import { decode } from 'jpeg-js';

interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
}
interface Photo {
  photo_id: string;
  sha256: string;
  source: string;
  captured_at_ms: number | null;
  captured_at_source: string | null;
  uploaded_at_ms: number;
}
class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const MAX_FILE = 2 * 1024 * 1024;
const MAX_REQUEST = 3 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (data: unknown, status: number) => Response.json(data, {
  status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
});
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
async function authenticate(request: Request, env: Env): Promise<string> {
  const header = request.headers.get('Authorization');
  const match = /^Bearer (lm_[0-9a-f]{64})$/.exec(header ?? '');
  if (!match) throw new HttpError(401, 'unauthorized');
  const tokenHash = await digest(new TextEncoder().encode(match[1]));
  const user = await env.DB.prepare(`SELECT u.user_id FROM user_tokens t
    JOIN users u ON u.user_id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at_ms IS NULL
      AND t.expires_at_ms > ? AND u.status = 'active'`)
    .bind(tokenHash, Date.now()).first<{ user_id: string }>();
  if (!user) throw new HttpError(401, 'unauthorized');
  return user.user_id;
}
async function boundedBody(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get('Content-Length')) > MAX_REQUEST) throw new HttpError(413, 'request_too_large');
  if (!request.body) throw new HttpError(400, 'invalid_multipart');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST) {
        await reader.cancel();
        throw new HttpError(413, 'request_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function field(form: FormData, name: string, optional = false): string | null {
  const values = form.getAll(name);
  if (optional && values.length === 0) return null;
  if (values.length !== 1 || typeof values[0] !== 'string' || !values[0]) throw new HttpError(400, 'invalid_fields');
  return values[0];
}
function capturedTime(value: string | null, source: string | null): number | null {
  if (value === null && source === null) return null;
  if (!value || !source || !['exif', 'apple_photos', 'device', 'manual'].includes(source)) throw new HttpError(400, 'invalid_captured_at');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new HttpError(400, 'invalid_captured_at');
  const [, year, month, day, hour, minute, second] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  const time = Date.parse(value);
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || !Number.isFinite(time)) throw new HttpError(400, 'invalid_captured_at');
  return time;
}
// 先检查 SOF 尺寸，避免为超过边长限制的图像分配解码内存。
function dimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new HttpError(415, 'invalid_jpeg');
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    const size = (bytes[offset] << 8) | bytes[offset + 1];
    if (size < 2 || offset + size > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width > 2048 || height > 2048) throw new HttpError(413, 'dimensions_too_large');
      if (!width || !height) break;
      return { width, height };
    }
    offset += size;
  }
  throw new HttpError(415, 'invalid_jpeg');
}
function photoResponse(photo: Photo, status: number): Response {
  return json({ photo_id: photo.photo_id, uploaded_at: new Date(photo.uploaded_at_ms).toISOString(),
    ...(photo.captured_at_ms === null ? {} : { captured_at: new Date(photo.captured_at_ms).toISOString() }) }, status);
}
async function upload(request: Request, env: Env): Promise<Response> {
  const owner = await authenticate(request, env);
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new HttpError(415, 'multipart_required');
  const body = await boundedBody(request);
  let form: FormData;
  try { form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData(); }
  catch { throw new HttpError(400, 'invalid_multipart'); }
  const allowed = new Set(['file', 'client_photo_id', 'source', 'captured_at', 'captured_at_source']);
  for (const key of form.keys()) if (!allowed.has(key)) throw new HttpError(400, 'invalid_fields');
  const clientId = field(form, 'client_photo_id')!;
  const source = field(form, 'source')!;
  if (!UUID.test(clientId) || !['cli', 'apple_app', 'device'].includes(source)) throw new HttpError(400, 'invalid_fields');
  const capturedSource = field(form, 'captured_at_source', true);
  const captured = capturedTime(field(form, 'captured_at', true), capturedSource);
  const files = form.getAll('file');
  if (files.length !== 1 || typeof files[0] === 'string') throw new HttpError(400, 'invalid_file');
  const file = files[0];
  if (!file.size) throw new HttpError(400, 'empty_file');
  if (file.size > MAX_FILE) throw new HttpError(413, 'file_too_large');
  if (file.type !== 'image/jpeg') throw new HttpError(415, 'invalid_jpeg');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = dimensions(bytes);
  try {
    const image = decode(bytes, { useTArray: true, tolerantDecoding: false, maxResolutionInMP: 4.2, maxMemoryUsageInMB: 64 });
    if (image.width !== size.width || image.height !== size.height) throw new Error('dimensions');
  } catch { throw new HttpError(415, 'invalid_jpeg'); }
  const hash = await digest(bytes);
  const lookup = () => env.DB.prepare('SELECT photo_id, sha256, source, captured_at_ms, captured_at_source, uploaded_at_ms FROM photos WHERE owner_id = ? AND client_photo_id = ?').bind(owner, clientId.toLowerCase()).first<Photo>();
  const existingResponse = (photo: Photo) => {
    if (photo.sha256 !== hash || photo.source !== source || photo.captured_at_ms !== captured || photo.captured_at_source !== capturedSource) throw new HttpError(409, 'photo_conflict');
    return photoResponse(photo, 200);
  };
  const existing = await lookup();
  if (existing) return existingResponse(existing);
  const id = crypto.randomUUID();
  const key = `photos/v1/${owner}/${id}/${hash}.jpg`;
  const uploaded = Date.now();
  const object = await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  if (!object) throw new Error('object_not_saved');
  try {
    await env.DB.prepare('INSERT INTO photos (photo_id, owner_id, client_photo_id, object_key, sha256, mime_type, byte_size, width, height, source, captured_at_ms, captured_at_source, uploaded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, owner, clientId.toLowerCase(), key, hash, 'image/jpeg', bytes.length, size.width, size.height, source, captured, capturedSource, uploaded).run();
  } catch (error) {
    // 并发上传可能已由另一请求落库；不删除可能仍被引用的对象。
    const winner = await lookup();
    if (winner) return existingResponse(winner);
    throw error;
  }
  return photoResponse({ photo_id: id, sha256: hash, source, captured_at_ms: captured, captured_at_source: capturedSource, uploaded_at_ms: uploaded }, 201);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (new URL(request.url).pathname !== '/photos') return json({ error: 'not_found' }, 404);
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      return await upload(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code }, error.status);
      // 不记录请求正文、凭据或底层异常，避免意外泄露业务数据。
      return json({ error: 'storage_unavailable' }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
