import { constants } from 'node:fs';
import { open, realpath, stat, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultModel, models, isModel, uuid } from '../config/models.mjs';

const usage = `LookMe comic / 漫画命令
  npm run comic -- [generate] --base-url URL --token-file PATH --story-id UUID
      [--model MODEL_ID] [--photo-id UUID ...] [--run-id UUID] --confirm-model-call
  npm run comic -- list --base-url URL --token-file PATH --story-id UUID [--cursor CURSOR]
  npm run comic -- status --base-url URL --token-file PATH --run-id UUID
  npm run comic -- download --base-url URL --token-file PATH --run-id UUID --out /private/path/image.png
  npm run comic -- --list-models

Each new run draws once. Reuse the printed run_id to check status without paying again.
新 run_id 对应一次生成；断连后用输出的 run_id 查询，不要盲目重发。
`;
const keys = new Set(['base-url','token-file','story-id','run-id','model','photo-id','cursor','out','confirm-model-call']);

export function parse(args) {
  let command = 'generate';
  if (args[0] && !args[0].startsWith('--')) [command, ...args] = args;
  if (!['generate','list','status','download'].includes(command)) throw new Error('unknown_command');
  const options = new Map(), ids = [];
  for (let i = 0; i < args.length; i++) {
    const key = /^--([a-z-]+)$/.exec(args[i])?.[1];
    if (!key || !keys.has(key) || options.has(key)) throw new Error('unknown_or_duplicate_option');
    if (key === 'confirm-model-call') { options.set(key, true); continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('missing_option_value');
    if (key === 'photo-id') ids.push(value);
    else options.set(key, value);
  }
  const allowed = {
    generate: ['story-id','run-id','model','confirm-model-call'],
    list: ['story-id','cursor'],
    status: ['run-id'],
    download: ['run-id','out'],
  };
  if ([...options.keys()].some(k => !['base-url','token-file',...allowed[command]].includes(k)) ||
    (command !== 'generate' && ids.length)) throw new Error('unsupported_option_for_command');
  if (!options.get('base-url') || !options.get('token-file')) throw new Error('base_url_and_token_file_required');
  let base;
  try { base = new URL(options.get('base-url')); } catch { throw new Error('invalid_base_url'); }
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
    base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('invalid_base_url');

  const story = options.get('story-id'), id = options.get('run-id');
  if ((['generate','list'].includes(command) && !uuid.test(story ?? '')) ||
    (id !== undefined && !uuid.test(id)) || (['status','download'].includes(command) && !id)) throw new Error('invalid_identifier');
  const model = options.get('model') ?? defaultModel;
  if (!isModel(model)) throw new Error('unsupported_model');
  if (ids.length > 3 || new Set(ids).size !== ids.length || ids.some(id => !uuid.test(id))) throw new Error('invalid_reference_ids');
  if (command === 'generate' && !options.get('confirm-model-call')) throw new Error('model_call_confirmation_required');
  const out = options.get('out');
  if (command === 'download' && (!out || !path.isAbsolute(out))) throw new Error('absolute_destination_required');
  const cursor = options.get('cursor');
  if (cursor && !/^\d{1,15}\.[0-9a-f-]{36}$/.test(cursor)) throw new Error('invalid_cursor');
  return { base, command, story, id, model, ids, out, cursor, tokenFile: options.get('token-file') };
}

async function tokenAt(file) {
  try {
    const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await source.stat();
      if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.size > 128) throw new Error();
      const token = (await source.readFile('utf8')).trim();
      if (!/^lm_[0-9a-f]{64}$/.test(token)) throw new Error();
      return token;
    } finally { await source.close(); }
  } catch { throw new Error('invalid_token_file_expected_owner_mode_0600'); }
}

async function bounded(response, limit) {
  if (!response.body) throw new Error('response_body_missing');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      if ((length += value.byteLength) > limit) throw new Error('response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function outputFile(file, bytes) {
  const folder = await realpath(path.dirname(file));
  const target = path.join(folder, path.basename(file));
  const p = await stat(folder);
  if (p.uid !== process.getuid() || (p.mode & 0o777) !== 0o700) throw new Error('destination_directory_must_be_0700');
  let created = false;
  try {
    const handle = await open(target, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
  } catch {
    if (created) await unlink(target).catch(() => {});
    throw new Error('cannot_save_new_image_file');
  }
  return target;
}
async function checkedJson(response) {
  const data = JSON.parse((await bounded(response, 2 * 1024 * 1024)).toString('utf8'));
  if (!response.ok) {
    const code = typeof data?.error === 'string' && /^[a-z0-9_]{1,100}$/.test(data.error) ? data.error : 'request_failed';
    throw new Error(`HTTP ${response.status}: ${code}${data?.may_have_been_billed === true ? ' (possibly billed / 可能已计费)' : ''}`);
  }
  return data;
}

export async function run(args, { send = fetch, notice = text => console.error(text) } = {}) {
  if (args.join(' ') === '--help') return usage;
  if (args.join(' ') === '--list-models') return models;
  const opts = parse(args);
  const id = opts.id ?? (opts.command === 'generate' ? randomUUID() : null);
  const token = await tokenAt(opts.tokenFile);
  const signal = AbortSignal.timeout(240_000);
  const get = resource => send(new URL(resource, opts.base), { headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error' });
  if (opts.command === 'list') {
    const url = new URL('/comics', opts.base);
    url.searchParams.set('story_id', opts.story);
    if (opts.cursor) url.searchParams.set('cursor', opts.cursor);
    return checkedJson(await get(url));
  }
  if (opts.command === 'status') return checkedJson(await get(`/comics/${id}`));
  if (opts.command === 'download') {
    // Read metadata to verify the downloaded bytes before touching the output file.
    const saved = await checkedJson(await get(`/comics/${id}`));
    if (saved?.status !== 'succeeded' || saved.run_id !== id || !/^[0-9a-f]{64}$/.test(saved.image?.sha256 ?? '')) throw new Error('image_not_ready');
    const response = await get(`/comics/${id}/image`);
    if (!response.ok) return checkedJson(response);
    const contentType = response.headers.get('Content-Type');
    if (!['image/png','image/jpeg'].includes(contentType) || saved.image.mime_type !== contentType) throw new Error('invalid_image_response');
    const bytes = await bounded(response, 8 * 1024 * 1024);
    if (bytes.length !== saved.image.byte_size || createHash('sha256').update(bytes).digest('hex') !== saved.image.sha256) {
      throw new Error('download_integrity_mismatch');
    }
    return { run_id: id, saved_to: await outputFile(opts.out, bytes), byte_size: bytes.length };
  }
  notice(`run_id=${id} (save it for status / 请保留以便查询)`);
  return checkedJson(await send(new URL('/comics', opts.base), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal, redirect: 'error', body: JSON.stringify({ run_id: id, story_id: opts.story, model: opts.model,
      ...(opts.ids.length ? { photo_ids: opts.ids } : {}), confirm_model_call: true }),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)))
    .catch(error => { console.error(error instanceof Error && error.message !== 'fetch failed' ? error.message : 'request_failed; use status with the printed run_id'); process.exitCode = 1; });
}
