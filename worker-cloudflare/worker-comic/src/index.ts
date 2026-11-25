import { readBounded } from '../../worker-image2txt/src/bytes';
import { defaultModel, isModel, specs, uuid } from '../config/models.mjs';
import { ComicError, noCache, ownerOf, reply, sha256, type Env } from './common';
import { daily } from './daily';
import { checkProvider, prepareRender, reference, render, type Model } from './render';
import { claim, finish, getRun, getStory, history, loadPhotos, markFailure, publicRun, storyPrompt, type Run } from './store';

async function inputOf(request: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) throw new ComicError(415, 'json_required');
  if (Number(request.headers.get('Content-Length')) > 2048) throw new ComicError(413, 'request_too_large');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      await readBounded(request.body!, 2048, AbortSignal.timeout(5000))));
  } catch (error) {
    if (error instanceof Error && error.message === 'body_too_large') throw new ComicError(413, 'request_too_large');
    throw new ComicError(400, 'invalid_json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(k => !['story_id','run_id','model','photo_ids','confirm_model_call'].includes(k))) throw new ComicError(400, 'invalid_fields');
  const body = value as Record<string, unknown>;
  const { story_id, run_id, photo_ids, confirm_model_call } = body;
  const model = Object.hasOwn(body, 'model') ? body.model : defaultModel;
  if (typeof story_id !== 'string' || typeof run_id !== 'string' || !uuid.test(story_id) || !uuid.test(run_id)) throw new ComicError(400, 'invalid_identifier');
  if (!isModel(model)) throw new ComicError(400, 'unsupported_model');
  if (confirm_model_call !== true) throw new ComicError(400, 'model_call_confirmation_required');
  if (Object.hasOwn(body, 'photo_ids') && (!Array.isArray(photo_ids) || photo_ids.length < 1 || photo_ids.length > 3 ||
    photo_ids.some(id => typeof id !== 'string' || !uuid.test(id)) || new Set(photo_ids).size !== photo_ids.length)) {
    throw new ComicError(400, 'invalid_reference_ids');
  }
  return { story_id, run_id, model: model as Model, photo_ids: (photo_ids ?? null) as string[] | null };
}
const replay = (run: Run, hash: string) => {
  if (run.request_sha256 !== hash) throw new ComicError(409, 'run_id_conflict');
  return reply({ ...publicRun(run), replayed: true, model_call_attempted: false }, run.status === 'generating' ? 202 : 200);
};

export function createWorker({ outbound = fetch, timeout }: { outbound?: typeof fetch; timeout?: number } = {}) {
  return {
    async fetch(request: Request, env: Env) {
      const url = new URL(request.url);
      const runPath = /^\/comics\/([a-f0-9-]+)(\/image)?$/.exec(url.pathname);
      const root = url.pathname === '/comics';
      const dailyFeed = url.pathname === '/daily';
      if (!root && !dailyFeed && (!runPath || !uuid.test(runPath[1]))) return reply({ error: 'not_found' }, 404);
      if (request.method !== 'GET' && !(root && request.method === 'POST')) {
        return reply({ error: 'method_not_allowed' }, 405, { Allow: root ? 'GET, POST' : 'GET' });
      }
      let owner: string | undefined;
      let runId: string | undefined;
      let attempted = false;
      let provider: string | null = null;
      try {
        owner = await ownerOf(request, env.DB);
        if (dailyFeed) return await daily(env.DB, owner, url);
        if (runPath) {
          const run = await getRun(env.DB, owner, runPath[1]);
          if (!run) throw new ComicError(404, 'run_not_found');
          if (!runPath[2]) return reply(publicRun(run));
          if (run.status !== 'succeeded') throw new ComicError(409, 'image_not_ready');
          const asset = await env.COMICS.get(run.result_object_key!);
          if (!asset || asset.size !== run.result_byte_size || asset.customMetadata?.sha256 !== run.result_sha256) {
            throw new ComicError(503, 'comic_image_unavailable');
          }
          const ext = run.result_mime_type === 'image/png' ? 'png' : 'jpg';
          return new Response(asset.body, { headers: { ...noCache, 'Content-Type': run.result_mime_type!,
            'Content-Length': String(asset.size), 'Content-Disposition': `attachment; filename="comic-${run.run_id}.${ext}"` } });
        }
        if (request.method === 'GET') {
          const story = url.searchParams.get('story_id');
          if (!story || !uuid.test(story)) throw new ComicError(400, 'invalid_identifier');
          return reply(await history(env.DB, owner, story, url.searchParams.get('cursor')));
        }
        const data = await inputOf(request);
        runId = data.run_id;
        const hash = await sha256(JSON.stringify([data.story_id, data.model, data.photo_ids]));
        const existing = await getRun(env.DB, owner, runId);
        if (existing) return replay(existing, hash);
        if (env.COMIC_GENERATION_ENABLED !== true) throw new ComicError(503, 'comic_generation_disabled');
        if (env.COMIC_ALLOW_ALL_AUTHENTICATED_USERS !== true &&
          !env.COMIC_GENERATOR_OWNER_IDS?.split(',').map(id => id.trim()).includes(owner)) {
          throw new ComicError(403, 'comic_generation_not_allowed');
        }
        checkProvider(env, data.model);
        const { ids, prompt } = storyPrompt(await getStory(env.DB, owner, data.story_id), data.photo_ids);
        const photos = await loadPhotos(env.DB, owner, ids);
        const refs = [];
        for (const photo of photos) refs.push(await reference(env, photo, specs[data.model].referenceSide));
        const prepared = prepareRender(env, data.model, prompt, refs, outbound);
        if (!await claim(env.DB, owner, runId, data.story_id, data.model, hash, prompt, refs)) {
          const winner = await getRun(env.DB, owner, runId);
          if (!winner) throw new ComicError(503, 'comic_registration_unconfirmed');
          return replay(winner, hash);
        }
        attempted = true;
        const result = await render(prepared, timeout);
        provider = result.providerId;
        await finish(env, owner, runId, result.raster, provider);
        const saved = await getRun(env.DB, owner, runId);
        if (!saved || saved.status !== 'succeeded') throw new ComicError(503, 'comic_metadata_store_unconfirmed');
        return reply({ ...publicRun(saved), replayed: false, model_call_attempted: true }, 201);
      } catch (error) {
        const e = error instanceof ComicError ? error : new ComicError(503, attempted ? 'comic_persistence_unconfirmed' : 'service_unavailable');
        if (attempted && owner && runId) {
          // Never overwrite a successful commit if the write succeeded but confirmation was lost.
          try { await markFailure(env.DB, owner, runId, e.code, provider); } catch { /* keep generating for manual reconciliation */ }
          console.warn(JSON.stringify({ event: 'comic_attempt_needs_review', run_id: runId, error: e.code,
            ...(e.assetOrigin ? { asset_origin: e.assetOrigin } : {}) }));
        }
        return reply({ error: e.code, ...(runId ? { run_id: runId } : {}), model_call_attempted: attempted, ...(e.assetOrigin ? { asset_origin: e.assetOrigin } : {}),
          may_have_been_billed: attempted, automatic_retry: false }, e.status);
      }
    },
  };
}
export default createWorker() satisfies ExportedHandler<Env>;
