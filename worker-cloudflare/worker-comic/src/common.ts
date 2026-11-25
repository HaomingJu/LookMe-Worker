export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  COMICS: R2Bucket;
  AI?: { run(model: string, options: unknown): Promise<unknown> };
  IMAGES?: ImagesBinding;
  COMIC_GENERATION_ENABLED?: boolean;
  COMIC_ALLOW_ALL_AUTHENTICATED_USERS?: boolean;
  COMIC_GENERATOR_OWNER_IDS?: string;
  COMIC_FLARE_ENABLED?: boolean;
}

export class ComicError extends Error {
  constructor(readonly status: number, readonly code: string, readonly assetOrigin?: string) { super(code); }
}
export const noCache = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
export const reply = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { ...noCache, ...headers } });
export async function sha256(data: Uint8Array | string) {
  const value = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
  return [...new Uint8Array(value)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function ownerOf(request: Request, db: D1Database) {
  const token = /^Bearer (lm_[0-9a-f]{64})$/.exec(request.headers.get('Authorization') ?? '');
  if (!token) throw new ComicError(401, 'unauthorized');
  const row = await db.prepare(`SELECT u.user_id FROM user_tokens t JOIN users u ON u.user_id=t.user_id
    WHERE t.token_hash=? AND t.revoked_at_ms IS NULL AND t.expires_at_ms>? AND u.status='active'`)
    .bind(await sha256(token[1]), Date.now()).first<{ user_id: string }>();
  if (!row) throw new ComicError(401, 'unauthorized');
  return row.user_id;
}
