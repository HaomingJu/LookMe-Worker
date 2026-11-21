import { readBounded } from '../../worker-image2txt/src/bytes';
import { DEFAULT_VERSION, getProfile, hasVersion, sha256 } from './config';
import { dayBounds, summaries } from './input';
import { generate } from './model';
import { HttpError, type Env } from './types';

const json = (data: unknown, status: number, headers: Record<string, string> = {}) => Response.json(data, {
  status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});
async function ownerOf(request: Request, env: Env, now: number): Promise<string> {
  const match = /^Bearer (lm_[0-9a-f]{64})$/.exec(request.headers.get('Authorization') ?? '');
  if (!match) throw new HttpError(401, 'unauthorized');
  const row = await env.DB.prepare(`SELECT u.user_id FROM user_tokens t JOIN users u ON u.user_id=t.user_id
    WHERE t.token_hash=? AND t.revoked_at_ms IS NULL AND t.expires_at_ms>? AND u.status='active'`)
    .bind(await sha256(match[1]), now).first<{ user_id: string }>();
  if (!row) throw new HttpError(401, 'unauthorized');
  return row.user_id;
}
async function payload(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) throw new HttpError(415, 'json_required');
  if (!request.body) throw new HttpError(400, 'invalid_json');
  if (Number(request.headers.get('Content-Length')) > 2048) throw new HttpError(413, 'request_too_large');
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readBounded(request.body, 2048, AbortSignal.timeout(5000))));
  } catch (error) {
    if (error instanceof Error && error.message === 'body_too_large') throw new HttpError(413, 'request_too_large');
    throw new HttpError(400, 'invalid_json');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || Object.keys(data).some(key => !['date', 'story_count', 'story_version'].includes(key))) throw new HttpError(400, 'invalid_fields');
  return data as Record<string, unknown>;
}
export function createWorker(clock = Date.now) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const requestId = crypto.randomUUID();
      const started = Date.now();
      let attempted = false;
      let code = 'ok';
      try {
        if (new URL(request.url).pathname !== '/stories') return json({ error: 'not_found' }, 404);
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
        const now = clock();
        const owner = await ownerOf(request, env, now);
        const body = await payload(request);
        const version = body.story_version ?? DEFAULT_VERSION;
        if (typeof version !== 'string' || !hasVersion(version)) throw new HttpError(400, 'invalid_story_version');
        const profile = await getProfile(version);
        const count = body.story_count ?? profile.default_story_count;
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > profile.max_stories) throw new HttpError(400, 'invalid_story_count');
        const day = dayBounds(body.date, now);
        if (env.STORY_GENERATION_ENABLED !== true || !env.AI) throw new HttpError(503, 'story_generation_disabled');
        const photos = await summaries(env.DB, owner, day.start, day.end, now, profile);
        if (count > photos.length) throw new HttpError(422, 'not_enough_photos', { photo_count: photos.length, requested_stories: count });
        const input = JSON.stringify({ date: day.date, timezone: profile.timezone, date_basis: profile.date_basis, story_count: count, photos });
        if (new TextEncoder().encode(input).byteLength > profile.max_input_bytes) throw new HttpError(413, 'summaries_too_large', { limit_bytes: profile.max_input_bytes });
        const inputHash = await sha256(input);
        attempted = true;
        const result = await generate(env.AI, profile, input, count, photos);
        return json({ request_id: requestId, date: day.date, timezone: profile.timezone, date_basis: profile.date_basis,
          snapshot_at: new Date(now).toISOString(), day_complete: now >= day.end, photo_count: photos.length,
          story_count: count, story_version: version, analysis_version: profile.analysis_version, model: profile.model,
          input_sha256: inputHash, sources: photos.map(({ summary: _summary, ...source }) => source), ...result }, 200);
      } catch (error) {
        const failure = error instanceof HttpError ? error : new HttpError(503, attempted ? 'failed_after_model_call' : 'service_unavailable');
        code = failure.code;
        return json({ error: code, request_id: requestId, ...failure.details, model_call_attempted: attempted,
          ...(attempted ? { may_have_been_billed: true, automatic_retry: false } : {}) }, failure.status);
      } finally {
        // 仅技术元数据；不记录 Token、用户摘要、故事正文、提示词或底层异常。
        console.info(JSON.stringify({ event: 'story_request', request_id: requestId, code, model_call_attempted: attempted, wall_ms: Date.now() - started }));
      }
    },
  };
}
export default createWorker() satisfies ExportedHandler<Env>;
