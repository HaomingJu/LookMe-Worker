#!/usr/bin/env node
// 仅手动调用，Token 从受限文件读取；不自动重试，不接受 owner_id。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectProfile, SelectionError } from '../config/selection.mjs';
const CATALOG = JSON.parse(fs.readFileSync(new URL('../config/story-profiles.json', import.meta.url), 'utf8'));
const DEFAULT_MODEL = CATALOG.profiles[CATALOG.default_version].model;
export const HELP = `用法：npm run story -- --base-url https://已部署的故事Worker域名 --token-file /受限目录/user.token --date YYYY-MM-DD [--model MODEL_ID] --confirm-model-call [--out /受限目录/result.story.json] [--story-version VERSION]
按北京时间上传日期聚合；AI根据内容自动决定故事数量，不再使用 --stories。
自动模式保留1–8个且不超过照片数量的资源上限，不要求凑满；每个故事仍有4格。
--model 可选，默认：${DEFAULT_MODEL}
支持的模型：${Object.keys(CATALOG.model_defaults).join('、')}；每个模型选择自己的固定配置版本。
--story-version 可选：显式锁定历史版本；与 --model 冲突时拒绝，不静默改模型。
--list-models 离线列出模型与默认版本，不读取Token、不调用模型。
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
    if (key === '--stories' || key.startsWith('--stories=')) throw new Error('--stories 已移除：故事数量由AI自动决定，请删除此参数');
    if (Object.hasOwn(values, key)) throw new Error('参数重复');
    if (key === '--confirm-model-call') values[key] = true;
    else if (['--base-url', '--token-file', '--date', '--model', '--out', '--story-version'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) values[key] = args[++i];
    else throw new Error('参数未知或缺值；使用 --help');
  }
  if (!values['--confirm-model-call']) throw new Error('需显式传入 --confirm-model-call 才会调用模型');
  if (!values['--base-url'] || !values['--token-file'] || !/^20\d{2}-\d{2}-\d{2}$/.test(values['--date'] ?? '')) throw new Error('必须提供 --base-url、--token-file 和合法 --date');
  const base = new URL(values['--base-url']);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error('Base URL 必须是HTTPS源地址（本地回环允许HTTP），不含路径、凭据或查询参数');
  const date = new Date(values['--date'] + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== values['--date']) throw new Error('日期不存在');
  let selected;
  try { selected = selectProfile(CATALOG, { model: values['--model'], story_version: values['--story-version'] }); }
  catch (error) {
    if (!(error instanceof SelectionError)) throw error;
    const messages = { unsupported_model: '不支持该模型；使用 --list-models 查看已适配模型', invalid_story_version: '故事版本未配置', model_version_mismatch: '--model 与 --story-version 的锁定模型不一致' };
    throw new Error(messages[error.code] ?? '模型选择失败');
  }
  return { url: base.origin + '/stories', tokenFile: path.resolve(values['--token-file']), out: values['--out'] ? path.resolve(values['--out']) : null,
    profile: selected.profile, body: { date: values['--date'], model: selected.profile.model, story_version: selected.version } };
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
const PROVIDER_MESSAGES = {
  model_payment_required: '模型服务要求处理付款问题，请账号管理员检查 Cloudflare Billing（不能据此确认具体欠款）',
  model_paid_plan_required: '该模型需要 Workers Paid 计划，请检查 Cloudflare 套餐；不表示已有欠款',
  model_quota_exceeded: 'Workers AI 每日免费额度已耗尽；请等待额度重置或检查付费计划，不等于欠费',
  model_capacity_exceeded: '模型服务暂时没有可用容量，不是欠费',
  model_rate_limited: '模型服务返回请求限制，未能确认是余额或额度问题',
};
function usageSummary(data, clientMs) {
  const model = typeof data?.model === 'string' && Object.hasOwn(CATALOG.model_defaults, data.model) ? data.model : '未返回';
  const duration = Number.isFinite(data?.request_duration_ms) && data.request_duration_ms >= 0 ? `${data.request_duration_ms}ms` : '未返回';
  const tokens = name => Number.isSafeInteger(data?.usage?.[name]) && data.usage[name] >= 0 ? String(data.usage[name]) : '未返回';
  const price = data?.cost?.estimated_usd;
  const cost = data?.cost?.status === 'estimated' && data.cost.is_estimate === true && data.cost.currency === 'USD' && Number.isFinite(price) && price >= 0
    ? `USD ${price}（公开价估算，非账单）` : '无法估算（缺少用量或单价）';
  const rates = data?.cost?.pricing;
  const unitPrice = data?.cost?.currency === 'USD' && rates?.unit === 'per_million_tokens'
    && Number.isFinite(rates.input) && rates.input >= 0 && Number.isFinite(rates.output) && rates.output >= 0
    ? `输入USD ${rates.input}/百万tokens、输出USD ${rates.output}/百万tokens` : '未返回';
  return `模型=${model}；服务端耗时=${duration}；客户端耗时=${clientMs}ms；输入tokens=${tokens('prompt_tokens')}；输出tokens=${tokens('completion_tokens')}；公开单价=${unitPrice}；费用=${cost}`;
}
const VALIDATION_CODES = new Set([
  'invalid_story_fields', 'invalid_story_text', 'story_text_too_long', 'invalid_story_sources',
  'duplicate_source_id', 'unknown_source_id', 'invalid_story_count', 'duplicate_story_source',
  'invalid_story_order', 'invalid_panels', 'invalid_panel_order', 'missing_panel_sources',
  'missing_story_sources', 'invalid_story_json', 'unknown_validation_error',
]);
export function errorDetails(data) {
  const details = [];
  if (VALIDATION_CODES.has(data?.validation_code)) details.push('校验原因：' + data.validation_code);
  if (typeof data?.validation_path === 'string' && data.validation_path.length <= 200
    && /^\$(?:\.(?:daily_summary|stories|title|summary|source_photo_ids|image_prompt|panels|panel|description)|\[\d{1,4}\])*$/.test(data.validation_path)) details.push('字段：' + data.validation_path);
  if (['waiting_headers', 'reading_body', 'validating_output'].includes(data?.model_stage)) details.push('阶段：' + data.model_stage);
  if (typeof data?.request_id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.request_id)) details.push('request_id=' + data.request_id);
  return details.length ? details.join('；') + '；' : '';
}
export async function run(args, fetchImpl = fetch) {
  if (args.length === 1 && args[0] === '--help') return { help: HELP };
  if (args.length === 1 && args[0] === '--list-models') return { default_model: DEFAULT_MODEL,
    models: Object.entries(CATALOG.model_defaults).map(([model, version]) => ({ model, story_version: version, story_count_mode: CATALOG.profiles[version].story_count_mode })) };
  const options = parse(args);
  let clientRequestMs;
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
    const requestStarted = performance.now();
    try {
      const response = await fetchImpl(options.url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(options.body), redirect: 'error', signal: AbortSignal.timeout(210000) });
      data = await readResponse(response);
      clientRequestMs = Math.round(performance.now() - requestStarted);
      if (response.status !== 200) {
        const code = typeof data?.error === 'string' && /^[a-z_]{1,80}$/.test(data.error) ? data.error : 'request_failed';
        throw new Error(`HTTP ${response.status}: ${code}；${Object.hasOwn(PROVIDER_MESSAGES, code) ? PROVIDER_MESSAGES[code] + '；' : ''}${errorDetails(data)}${usageSummary(data, clientRequestMs)}；${data?.model_call_attempted === false ? '服务端报告未调用模型' : '可能已调用模型并产生费用'}；不自动重试`);
      }
    } catch (error) {
      if (error instanceof Error && /^HTTP \d{3}:/.test(error.message)) throw error;
      throw new Error(`请求未取得有效确认；模型=${options.body.model}；客户端耗时=${Math.round(performance.now()-requestStarted)}ms；用量未返回、费用无法估算；可能已调用模型并产生费用，不自动重试`);
    }
    if (!data || data.date !== options.body.date || data.model !== options.body.model || data.story_version !== options.body.story_version
      || !Number.isInteger(data.story_count) || data.story_count < 1 || data.story_count > options.profile.max_stories
      || !Number.isInteger(data.photo_count) || data.photo_count < data.story_count
      || !Array.isArray(data.stories) || data.stories.length !== data.story_count
      || (options.profile.story_count_mode === 'auto' ? data.story_count_mode !== 'auto' : data.story_count !== options.profile.default_story_count)) throw new Error('结果格式或模型版本异常；可能已产生费用，不自动重试');
    data.client_request_ms = clientRequestMs;
    const output = JSON.stringify(data, null, 2) + '\n';
    if (fd !== undefined) { fs.writeFileSync(fd, output); fs.fsyncSync(fd); }
    return options.out ? { saved_file: options.out, story_count: data.story_count, model: data.model, story_version: data.story_version, request_id: data.request_id, request_duration_ms: data.request_duration_ms ?? null, client_request_ms: clientRequestMs, model_timings: data.model_timings ?? null, usage: data.usage ?? {}, cost: data.cost ?? null, ...(data.coverage ? { coverage: data.coverage } : {}) } : data;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await run(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
