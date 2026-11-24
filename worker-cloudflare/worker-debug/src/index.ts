import PAGE from '../public/index.html';
import SCRIPT from '../public/app.js';
import STYLE from '../public/styles.css';

interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  DEBUG_PASSWORD?: string;
}
interface PhotoRow {
  photo_id: string;
  uploaded_at_ms: number;
  captured_at_ms: number | null;
  captured_at_source: string | null;
  width: number;
  height: number;
  byte_size: number;
  source: string;
  result_text: string | null;
  analysis_status: string | null;
  analysis_version: string | null;
  model: string | null;
}
const SESSION_TTL = 12 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ENCODER = new TextEncoder();
const PRIVATE = { 'Cache-Control': 'private, no-cache', Vary: 'Cookie' };
class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
async function hash(value: string) {
  return hex(await crypto.subtle.digest('SHA-256', ENCODER.encode(value)));
}
function hex(value: ArrayBuffer) {
  return Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join('');
}
async function key(secret: string) {
  return crypto.subtle.importKey('raw', ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function hmac(secret: string, value: string) {
  return hex(await crypto.subtle.sign('HMAC', await key(secret), ENCODER.encode(value)));
}
function cookie(request: Request) {
  const values = (request.headers.get('Cookie') ?? '').split(';').map(p => p.trim());
  const value = values.find(p => p.startsWith('lookme_debug='));
  try { return value ? decodeURIComponent(value.slice('lookme_debug='.length)) : ''; }
  catch { return ''; }
}
async function sessionValid(request: Request, secret: string) {
  const match = /^(\d{13})\.([0-9a-f]{64})$/.exec(cookie(request));
  if (!match || Number(match[1]) <= Date.now() || Number(match[1]) > Date.now() + SESSION_TTL) return false;
  const bytes = Uint8Array.from(match[2].match(/../g)!, b => parseInt(b, 16));
  return crypto.subtle.verify('HMAC', await key(secret), bytes, ENCODER.encode(match[1]));
}
function sessionCookie(value: string, seconds: number) {
  return `lookme_debug=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${seconds}`;
}
function sameOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new HttpError(403, 'cross_origin_rejected');
  }
}
async function login(request: Request, secret: string) {
  sameOrigin(request);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'json_required');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'invalid_login');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4096) { await reader.cancel(); throw new HttpError(413, 'request_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'invalid_login'); }
  if (!data || typeof data !== 'object' || !('password' in data) || typeof data.password !== 'string') {
    throw new HttpError(400, 'invalid_login');
  }
  const supplied = await hash(data.password);
  const expected = await hash(secret);
  if (!crypto.subtle.timingSafeEqual(ENCODER.encode(supplied), ENCODER.encode(expected))) throw new HttpError(401, 'unauthorized');
  const expires = String(Date.now() + SESSION_TTL);
  return new Response(JSON.stringify({ ok: true }), { headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
    'Set-Cookie': sessionCookie(`${expires}.${await hmac(secret, expires)}`, SESSION_TTL / 1000),
  } });
}
function matches(request: Request, etag: string) {
  return (request.headers.get('If-None-Match') ?? '').split(',').some(v => v.trim().replace(/^W\//, '') === etag || v.trim() === '*');
}
async function cachedJSON(request: Request, data: unknown) {
  const body = JSON.stringify(data);
  const etag = `"${await hash(body)}"`;
  const headers = { ...PRIVATE, ETag: etag, 'Content-Type': 'application/json' };
  return matches(request, etag) ? new Response(null, { status: 304, headers }) : new Response(body, { headers });
}
function parameters(url: URL, allowed: string[]) {
  const seen = new Set<string>();
  for (const [name] of url.searchParams) {
    if (seen.has(name) || !allowed.includes(name)) throw new HttpError(400, 'invalid_filter');
    seen.add(name);
  }
}
function owner(value: string | null) {
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new HttpError(400, 'invalid_user');
  return value;
}
function filters(url: URL) {
  parameters(url, ['user', 'date', 'start', 'end', 'limit', 'cursor']);
  const user = owner(url.searchParams.get('user'));
  const date = url.searchParams.get('date') ?? '';
  const start = url.searchParams.get('start') ?? '00:00';
  const end = url.searchParams.get('end') ?? '23:59';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '0001-01-01' || date > '9998-12-31') throw new HttpError(400, 'invalid_date');
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) throw new HttpError(400, 'invalid_date');
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(start) || !time.test(end) || start > end) throw new HttpError(400, 'invalid_time_range');
  const from = Date.parse(`${date}T${start}:00+08:00`);
  const to = Date.parse(`${date}T${end}:00+08:00`) + 60000;
  const size = url.searchParams.get('limit') ?? '12';
  if (!/^\d+$/.test(size) || Number(size) < 1 || Number(size) > 50) throw new HttpError(400, 'invalid_limit');
  return { user, date, start, end, from, to, limit: Number(size) };
}
async function users(request: Request, env: Env) {
  const result = await env.DB.prepare(`SELECT u.user_id, u.status, count(p.photo_id) AS photo_count,
    min(p.uploaded_at_ms) AS first_uploaded_at_ms, max(p.uploaded_at_ms) AS last_uploaded_at_ms,
    min(p.captured_at_ms) AS first_captured_at_ms, max(p.captured_at_ms) AS last_captured_at_ms,
    sum(CASE WHEN p.photo_id IS NOT NULL AND p.captured_at_ms IS NULL THEN 1 ELSE 0 END) AS undated_photo_count
    FROM users u LEFT JOIN photos p ON p.owner_id = u.user_id GROUP BY u.user_id ORDER BY u.created_at_ms, u.user_id`).all();
  return cachedJSON(request, { users: result.results });
}
async function timeline(request: Request, env: Env, url: URL) {
  const f = filters(url);
  if (!await env.DB.prepare('SELECT user_id FROM users WHERE user_id = ?').bind(f.user).first()) throw new HttpError(404, 'user_not_found');
  const scope = `captured_at_ms|${f.user}|${f.date}|${f.start}|${f.end}`;
  const raw = url.searchParams.get('cursor');
  let after: { time: number; id: string } | null = null;
  if (raw !== null) {
    try {
      if (raw.length > 1024) throw new Error();
      const cursor = JSON.parse(atob(raw));
      if (cursor.scope !== scope || !Number.isSafeInteger(cursor.time) || cursor.time < f.from || cursor.time >= f.to || !UUID.test(cursor.id)) throw new Error();
      after = { time: cursor.time, id: cursor.id };
    } catch { throw new HttpError(400, 'invalid_cursor'); }
  }
  // 同毫秒照片以 ID 收敛分页，摘要版本不参与照片排序或页大小。
  const result = await env.DB.prepare(`SELECT p.photo_id, p.uploaded_at_ms, p.captured_at_ms, p.captured_at_source,
    p.width, p.height, p.byte_size, p.source, a.result_text, a.status AS analysis_status, a.analysis_version, a.model
    FROM photos p LEFT JOIN photo_analyses a ON a.photo_id = p.photo_id AND a.analysis_version = (
      SELECT chosen.analysis_version FROM photo_analyses chosen WHERE chosen.photo_id = p.photo_id
      ORDER BY (chosen.status = 'succeeded') DESC, chosen.updated_at_ms DESC, chosen.analysis_version DESC LIMIT 1)
    WHERE p.owner_id = ? AND p.captured_at_ms >= ? AND p.captured_at_ms < ?
    ${after ? 'AND (p.captured_at_ms > ? OR (p.captured_at_ms = ? AND p.photo_id > ?))' : ''}
    ORDER BY p.captured_at_ms ASC, p.photo_id ASC LIMIT ?`)
    .bind(f.user, f.from, f.to, ...(after ? [after.time, after.time, after.id] : []), f.limit + 1).all<PhotoRow>();
  const photos = result.results.slice(0, f.limit);
  const last = photos.at(-1);
  const next = result.results.length > f.limit && last ? btoa(JSON.stringify({ scope, time: last.captured_at_ms, id: last.photo_id })) : null;
  return cachedJSON(request, { photos, next_cursor: next, timezone: 'Asia/Shanghai', date_basis: 'captured_at_ms', story: { status: 'separate_endpoint', endpoint: '/api/stories' } });
}
// 故事按生成时指定的上传日分组，不沿用照片时间线的captured_at筛选。
async function storyRuns(request: Request, env: Env, url: URL) {
  parameters(url, ['user', 'date', 'cursor']);
  const user = owner(url.searchParams.get('user'));
  const date = url.searchParams.get('date') ?? '';
  const timestamp = Date.parse(date + 'T00:00:00Z');
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) throw new HttpError(400, 'invalid_date');
  if (!await env.DB.prepare('SELECT user_id FROM users WHERE user_id=?').bind(user).first()) throw new HttpError(404, 'user_not_found');
  let after: { time: number; id: string } | null = null;
  const raw = url.searchParams.get('cursor');
  if (raw !== null) {
    try {
      if (raw.length > 1024) throw new Error();
      const parsed = JSON.parse(atob(raw));
      if (parsed.user !== user || parsed.date !== date || !Number.isSafeInteger(parsed.time) || parsed.time < 0 || !UUID.test(parsed.id)) throw new Error();
      after = { time: parsed.time, id: parsed.id };
    } catch { throw new HttpError(400, 'invalid_cursor'); }
  }
  const result = await env.DB.prepare(`SELECT run_id,story_date,timezone,date_basis,story_version,analysis_version,model,status,created_at_ms,updated_at_ms,
    json_extract(response_json,'$.story_count') AS story_count,
    json_extract(response_json,'$.daily_summary') AS daily_summary,
    json_extract(response_json,'$.snapshot_at') AS snapshot_at,
    json_extract(response_json,'$.day_complete') AS day_complete,
    json_extract(response_json,'$.provider_request_id') AS provider_request_id,
    json_extract(response_json,'$.request_duration_ms') AS request_duration_ms,
    json_extract(response_json,'$.usage') AS usage_json,
    json_extract(response_json,'$.cost') AS cost_json,
    json_extract(response_json,'$.model_timings') AS timings_json,
    error_json FROM story_runs WHERE owner_id=? AND story_date=?
    ${after ? 'AND (created_at_ms < ? OR (created_at_ms = ? AND run_id < ?))' : ''}
    ORDER BY created_at_ms DESC,run_id DESC LIMIT 11`)
    .bind(user, date, ...(after ? [after.time, after.time, after.id] : [])).all<Record<string, any>>();
  const rows = result.results.slice(0, 10);
  const runs = rows.map(row => {
    const { usage_json, cost_json, timings_json, error_json, ...rest } = row;
    const error = error_json ? JSON.parse(error_json) : null;
    return { ...rest, usage: usage_json ? JSON.parse(usage_json) : error?.usage ?? {},
      cost: cost_json ? JSON.parse(cost_json) : error?.cost ?? null,
      model_timings: timings_json ? JSON.parse(timings_json) : error?.model_timings ?? null,
      request_duration_ms: row.request_duration_ms ?? error?.request_duration_ms ?? null,
      error_code: error?.error ?? null };
  });
  const last = rows.at(-1);
  return cachedJSON(request, { runs, next_cursor: result.results.length > 10 && last ? btoa(JSON.stringify({ user, date, time: last.created_at_ms, id: last.run_id })) : null,
    timezone: 'Asia/Shanghai', date_basis: 'uploaded_at_ms' });
}
async function storyDetail(request: Request, env: Env, url: URL) {
  parameters(url, ['user', 'run_id']);
  const user = owner(url.searchParams.get('user')), id = url.searchParams.get('run_id') ?? '';
  if (!UUID.test(id)) throw new HttpError(400, 'invalid_run_id');
  // 调试密码为管理员只读权限；仍用owner/run_id限定查询，避免选择用户串数据。
  const row = await env.DB.prepare('SELECT status,response_json,error_json FROM story_runs WHERE owner_id=? AND run_id=?')
    .bind(user, id).first<{status:string;response_json:string|null;error_json:string|null}>();
  if (!row) throw new HttpError(404, 'story_not_found');
  return cachedJSON(request, { run_id: id, status: row.status, result: row.response_json ? JSON.parse(row.response_json) : null,
    error: row.error_json ? JSON.parse(row.error_json) : null });
}
async function photo(request: Request, env: Env, url: URL, id: string) {
  if (!UUID.test(id)) throw new HttpError(404, 'not_found');
  parameters(url, ['user']);
  const user = url.searchParams.has('user') ? owner(url.searchParams.get('user')) : null;
  const row = await env.DB.prepare(`SELECT object_key, sha256 FROM photos WHERE photo_id = ? ${user ? 'AND owner_id = ?' : ''}`)
    .bind(id, ...(user ? [user] : [])).first<{ object_key: string; sha256: string }>();
  if (!row) throw new HttpError(404, 'not_found');
  const headers = { ...PRIVATE, ETag: `"${row.sha256}"`, 'Content-Type': 'image/jpeg' };
  if (matches(request, headers.ETag)) return new Response(null, { status: 304, headers });
  const object = await env.PHOTOS.get(row.object_key);
  if (!object) throw new HttpError(404, 'photo_missing');
  return new Response(object.body, { headers });
}
async function route(request: Request, env: Env) {
  const url = new URL(request.url);
  if (!env.DEBUG_PASSWORD) throw new HttpError(503, 'debug_not_configured');
  const assets: Record<string, [string, string]> = {
    '/': [PAGE, 'text/html'], '/app.js': [SCRIPT, 'text/javascript'], '/styles.css': [STYLE, 'text/css'],
  };
  if (request.method === 'GET' && assets[url.pathname]) {
    const [body, type] = assets[url.pathname];
    return new Response(body, { headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' } });
  }
  if (url.pathname === '/api/login' && request.method === 'POST') return login(request, env.DEBUG_PASSWORD);
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    sameOrigin(request);
    return new Response(null, { status: 204, headers: { 'Set-Cookie': sessionCookie('', 0), 'Cache-Control': 'no-store', 'Clear-Site-Data': '"cache"' } });
  }
  if (!await sessionValid(request, env.DEBUG_PASSWORD)) throw new HttpError(401, 'unauthorized');
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  if (url.pathname === '/api/users') return users(request, env);
  if (url.pathname === '/api/stories') return storyRuns(request, env, url);
  if (url.pathname === '/api/story') return storyDetail(request, env, url);
  if (url.pathname === '/api/timeline') return timeline(request, env, url);
  const match = /^\/photo\/([^/]+)$/.exec(url.pathname);
  if (match) return photo(request, env, url, match[1]);
  throw new HttpError(404, 'not_found');
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try { response = await route(request, env); }
    catch (error) { response = error instanceof HttpError ? json({ error: error.code }, error.status) : json({ error: 'storage_unavailable' }, 503); }
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return response;
  },
} satisfies ExportedHandler<Env>;
