import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EnvHttpProxyAgent } from 'undici';

const BASE = 'https://api.fudaixuexue.eu.cc';
const HELP = `首次：node upload_batch.mjs [BASE_URL] TOKEN_FILE JPEG_FILE...
恢复：node upload_batch.mjs --state STATE_FILE [BASE_URL] TOKEN_FILE
自选：node upload_batch.mjs --state STATE_FILE [BASE_URL] TOKEN_FILE JPEG_FILE...
帮助：node upload_batch.mjs --help
BASE_URL 可选，默认 ${BASE}，自动追加 /photos。
TOKEN_FILE 必填，是凭据文件路径，不是 Token 明文。
JPEG_FILE 首次至少一张；恢复可省略，不接受目录/重复路径。
--state 可选；默认在主目录 .lookme-upload-batches 创建唯一状态文件。
POSIX 新目录0700、状态文件0600；已有目录不自动改权限。
请求前输出 STATE_FILE；恢复必须复用它，成功200/201跳过，UUID不变。
最多并发 8 张，用 Node undici 原生连接池；不依赖 C++。
每次每张只尝试一次，不自动无限重试；原图片大小/修改时间必须保持。
JPEG非空且不超过2 MiB，每边2048px，单请求3 MiB；格式由服务器验证。
Token与地址必须与批次一致，凭据必须属于同一用户。
显示单张响应/路径/大小/耗时/速度及批次成功数；速度为端到端有效速率。
退出0全部成功，退出1部分失败；--help不读凭据、不上传。
支持HTTPS_PROXY等环境变量；状态含路径/响应，请勿公开。
Python/JS/curl共用JSON状态格式，C/C++状态格式不同。`;
const successful = status => status === 200 || status === 201;
const validUuid = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

function writeState(file, data) {
  const temp = `${file}.tmp`;
  let fd; let created = false;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); created = true;
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (created && fs.existsSync(temp)) fs.unlinkSync(temp);
    throw error;
  }
}
function checkFile(job) {
  const stat = fs.statSync(job.path, { bigint: true });
  if (!stat.isFile() || Number(stat.size) !== job.size || String(stat.mtimeNs) !== job.modified)
    throw new Error(`图片已改变或不存在：${job.path}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return; }
  let chosen;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state') {
      if (chosen !== undefined || !args[i + 1]) throw new Error('--state 需要唯一状态路径');
      chosen = args[++i];
    } else positional.push(args[i]);
  }
  const base = (/^https?:\/\//.test(positional[0] ?? '') ? positional.shift() : BASE).replace(/\/+$/, '');
  if (!positional.length) throw new Error(HELP);
  const tokenPath = fs.realpathSync(positional.shift());
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!/^lm_[0-9a-f]{64}$/.test(token)) throw new Error('Token 格式无效');
  if (!chosen && positional[0]?.endsWith('.upload-state')) chosen = positional.shift();
  let state;
  if (chosen) state = path.resolve(chosen);
  else {
    if (!positional.length) throw new Error('首次至少需要一张JPEG；恢复使用 --state');
    const folder = path.join(os.homedir(), '.lookme-upload-batches');
    if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink()) throw new Error('状态目录不能为符号链接');
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { mode: 0o700 });
    state = path.join(folder, `js-batch-${randomUUID()}.upload-state`);
  }
  if (fs.existsSync(state) && fs.lstatSync(state).isSymbolicLink()) throw new Error('状态不能为符号链接');
  if (process.platform !== 'win32' && (fs.statSync(path.dirname(state)).mode & 0o077)) throw new Error('状态父目录必须受限（0700）');
  const lock = `${state}.lock`;
  fs.mkdirSync(lock, { mode: 0o700 });
  let dispatcher;
  const controller = new AbortController();
  let interrupted = false;
  const stop = () => { interrupted = true; controller.abort(); };
  try {
    let data;
    if (fs.existsSync(state)) {
      data = JSON.parse(fs.readFileSync(state, 'utf8'));
      if (data.format !== 'LOOKME_NATIVE_BATCH_V1' || data.base_url !== base || data.token_path !== tokenPath)
        throw new Error('状态格式、服务地址或Token文件路径与原批次不一致');
      if (!Array.isArray(data.jobs) || !data.jobs.length || data.jobs.length > 10000) throw new Error('状态记录无效');
      const ids = new Set(), paths = new Set();
      for (const job of data.jobs) {
        if (!validUuid(job.uuid) || ids.has(job.uuid) || paths.has(job.path) || !Number.isInteger(job.status)) throw new Error('状态UUID/路径重复或字段无效');
        ids.add(job.uuid); paths.add(job.path); checkFile(job);
      }
    } else {
      if (!positional.length) throw new Error('新批次至少一张JPEG');
      const paths = positional.map(file => fs.realpathSync(file));
      if (new Set(paths).size !== paths.length) throw new Error('重复图片路径');
      const jobs = paths.map(file => {
        const stat = fs.statSync(file, { bigint: true });
        const size = Number(stat.size);
        if (!stat.isFile() || !size || size > 2 * 1024 * 1024) throw new Error(`图片为空/过大/不是普通文件：${file}`);
        return { path: file, uuid: randomUUID(), size, modified: String(stat.mtimeNs), status: 0, response: '' };
      });
      data = { format: 'LOOKME_NATIVE_BATCH_V1', base_url: base, token_path: tokenPath, jobs };
    }
    if (positional.length && (positional.length !== data.jobs.length || positional.some((file, i) => fs.realpathSync(file) !== data.jobs[i].path)))
      throw new Error('恢复图片列表/顺序改变');
    writeState(state, data);
    console.log(`STATE_FILE=${state}`);
    dispatcher = new EnvHttpProxyAgent({ connections: 8, pipelining: 1, connect: { timeout: 10000 } });
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const pending = data.jobs.filter(job => !successful(job.status));
    let next = 0, completed = data.jobs.length - pending.length, active = 0, bytes = 0;
    const began = performance.now();
    async function worker() {
      while (!interrupted && next < pending.length) {
        const job = pending[next++];
        checkFile(job);
        active++;
        console.log(`开始：${job.path} CLIENT_PHOTO_ID=${job.uuid} 活跃=${active}`);
        const started = performance.now();
        try {
          const image = fs.readFileSync(job.path);
          const form = new FormData();
          form.set('file', new Blob([image], { type: 'image/jpeg' }), 'upload.jpg');
          form.set('client_photo_id', job.uuid); form.set('source', 'cli');
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
          const response = await fetch(base + '/photos', { method: 'POST', body: form, headers: { Authorization: 'Bearer ' + token }, dispatcher, signal, redirect: 'error' });
          const reader = response.body.getReader();
          const chunks = []; let length = 0;
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            length += value.length;
            if (length > 65536) { await reader.cancel(); throw new Error('响应超过64KiB'); }
            chunks.push(value);
          }
          job.response = Buffer.concat(chunks).toString('utf8');
          job.status = response.status;
        } catch { job.status = -1; job.response = '网络/传输未确认；复用UUID恢复'; }
        active--;
        if (successful(job.status)) { completed++; bytes += job.size; }
        writeState(state, data);
        const elapsed = (performance.now() - started) / 1000;
        console.log(`${successful(job.status) ? '上传成功' : '上传失败'}：${job.path}\nCLIENT_PHOTO_ID=${job.uuid} HTTP ${job.status}\n文件大小：${job.size} 字节，请求耗时：${elapsed.toFixed(3)} 秒，平均上传速度：${(elapsed > 0 ? job.size / 1024 / elapsed : 0).toFixed(2)} KiB/s（含服务端处理）\n服务端响应：${job.response}\n批次进度：已成功 ${completed}/${data.jobs.length}，活跃 ${active}`);
      }
    }
    const results = await Promise.allSettled(Array.from({ length: Math.min(8, pending.length) }, async () => {
      try { await worker(); } catch (error) { stop(); throw error; }
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const elapsed = (performance.now() - began) / 1000;
    console.log(`批次进度：已成功 ${completed}/${data.jobs.length}\n批次耗时：${elapsed.toFixed(3)} 秒，本次成功文件：${bytes} 字节，有效平均速率：${(elapsed > 0 ? bytes / 1024 / elapsed : 0).toFixed(2)} KiB/s\n状态文件：${state}`);
    if (interrupted) console.error('批次已中断；使用 --state 恢复原状态。');
    if (interrupted || completed !== data.jobs.length) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (dispatcher) await dispatcher.close();
    fs.rmdirSync(lock);
  }
}
try { await main(); } catch (error) {
  console.error(`批次未全部确认成功：${error.message}\n使用 --state 恢复已输出的原状态文件。`);
  process.exitCode = 1;
}
