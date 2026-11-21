#!/usr/bin/env node
// 仅手动调用，Token 从受限文件读取；不自动重试，不接受 owner_id。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const HELP = `用法：npm run story -- --base-url https://已部署的故事Worker域名 --token-file /受限目录/user.token --date YYYY-MM-DD --stories N --confirm-model-call [--out /受限目录/result.story.json] [--story-version v1]
按北京时间上传日期聚合；默认N=3，范围1–8，不能超过当天照片数量。
--base-url 必须显式指定独立故事Worker，不是上传API；HTTP仅允许本地回环地址。
--confirm-model-call 必填：一次请求可能产生 Workers AI 费用。
--out 可选：保存到尚不存在的0600文件，不覆盖；省略时故事JSON写到标准输出。
Token只从文件读取，不传明文参数。不会部署、自动重试或撤销凭据。
超时/断连可能已经产生费用；失败后不能把重新运行当作幂等恢复。
--help 不读取Token，也不访问网络。`;
export function parse(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (Object.hasOwn(values, key)) throw new Error('参数重复');
    if (key === '--confirm-model-call') values[key] = true;
    else if (['--base-url', '--token-file', '--date', '--stories', '--out', '--story-version'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) values[key] = args[++i];
    else throw new Error('参数未知或缺值；使用 --help');
  }
  if (!values['--confirm-model-call']) throw new Error('需显式传入 --confirm-model-call 才会调用模型');
  if (!values['--base-url'] || !values['--token-file'] || !/^20\d{2}-\d{2}-\d{2}$/.test(values['--date'] ?? '')) throw new Error('必须提供 --base-url、--token-file 和合法 --date');
  const base = new URL(values['--base-url']);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error('Base URL 必须是HTTPS源地址（本地回环允许HTTP），不含路径、凭据或查询参数');
  const count = values['--stories'] ?? '3';
  if (!/^[1-8]$/.test(count)) throw new Error('--stories 必须是1–8的整数');
  const date = new Date(values['--date'] + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== values['--date']) throw new Error('日期不存在');
  const version = values['--story-version'] ?? 'v1';
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(version)) throw new Error('故事版本无效');
  return { url: base.origin + '/stories', tokenFile: path.resolve(values['--token-file']), out: values['--out'] ? path.resolve(values['--out']) : null,
    body: { date: values['--date'], story_count: Number(count), story_version: version } };
}
async function readResponse(response) {
  if (!response.body) throw new Error('响应为空');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
      if (size > 512 * 1024) throw new Error('响应超过512KiB'); chunks.push(value); }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function run(args, fetchImpl = fetch) {
  if (args.length === 1 && args[0] === '--help') return { help: HELP };
  const options = parse(args);
  const stat = fs.statSync(options.tokenFile);
  if (!stat.isFile() || stat.size > 256 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw new Error('Token必须是当前用户的受限文件（0600）');
  const token = fs.readFileSync(options.tokenFile, 'utf8').trim();
  if (!/^lm_[0-9a-f]{64}$/.test(token)) throw new Error('Token文件格式无效');
  let fd;
  try {
    // 调用前检查输出路径，避免模型返回后才发现文件已存在；失败保留空文件便于核查。
    if (options.out) {
      const parent = fs.statSync(path.dirname(options.out));
      if (process.platform !== 'win32' && ((parent.mode & 0o077) !== 0 || parent.uid !== process.getuid())) throw new Error('输出文件父目录必须属于当前用户且权限0700');
      fd = fs.openSync(options.out, 'wx', 0o600);
    }
    let data;
    try {
      const response = await fetchImpl(options.url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(options.body), redirect: 'error', signal: AbortSignal.timeout(110000) });
      data = await readResponse(response);
      if (response.status !== 200) {
        const code = typeof data?.error === 'string' && /^[a-z_]{1,80}$/.test(data.error) ? data.error : 'request_failed';
        throw new Error(`HTTP ${response.status}: ${code}；${data?.model_call_attempted === false ? '服务端报告未调用模型' : '可能已调用模型并产生费用'}；不自动重试`);
      }
    } catch (error) {
      if (error instanceof Error && /^HTTP \d{3}:/.test(error.message)) throw error;
      throw new Error('请求未取得有效确认；可能已调用模型并产生费用，不自动重试');
    }
    if (!data || data.date !== options.body.date || data.story_count !== options.body.story_count || !Array.isArray(data.stories) || data.stories.length !== options.body.story_count) throw new Error('结果格式异常；可能已产生费用，不自动重试');
    const output = JSON.stringify(data, null, 2) + '\n';
    if (fd !== undefined) { fs.writeFileSync(fd, output); fs.fsyncSync(fd); }
    return options.out ? { saved_file: options.out, story_count: data.story_count, request_id: data.request_id } : data;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await run(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
