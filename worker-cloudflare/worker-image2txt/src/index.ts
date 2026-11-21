import { imageDataUrl, readBounded } from './bytes';
import { MessageLog } from './logging';
import { caption, ProviderUncertain, PROVIDER_TIMEOUT_MS } from './workers-ai';
import { Store } from './store';
import { type AnalysisMessage, type Env, type Photo, ANALYSIS_VERSION, MODEL, MAX_IMAGE_BYTES, retrySeconds } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseMessage(body: unknown): AnalysisMessage | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.photo_id !== 'string' || !UUID.test(value.photo_id)
    || value.analysis_version !== ANALYSIS_VERSION) return null;
  return { photo_id: value.photo_id.toLowerCase(), analysis_version: ANALYSIS_VERSION };
}

class PreparationError extends Error {
  constructor(readonly code: string, readonly permanent = false) { super(code); }
}

async function prepareImage(env: Env, photo: Photo, log: MessageLog): Promise<string> {
  await log.step('check_ai_binding', () => {
    if (!env.AI || typeof env.AI.run !== 'function') throw new PreparationError('missing_ai_binding');
  });
  const bytes = await log.step('read_r2', async () => {
    const object = await env.PHOTOS.get(photo.object_key);
    if (!object) throw new PreparationError('photo_object_missing');
    if (photo.mime_type !== 'image/jpeg' || photo.byte_size < 1 || photo.byte_size > MAX_IMAGE_BYTES
      || object.size !== photo.byte_size) {
      void object.body.cancel().catch(() => {});
      throw new PreparationError('photo_metadata_mismatch', true);
    }
    return readBounded(object.body, MAX_IMAGE_BYTES);
  }, { byte_size: photo.byte_size });
  await log.step('verify_image', async () => {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      byte => byte.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== photo.byte_size || hash !== photo.sha256) {
      throw new PreparationError('photo_integrity_mismatch', true);
    }
  });
  return log.step('encode_image', () => imageDataUrl(bytes));
}

interface Dependencies {
  now: () => number;
}

// 依赖注入仅供本地 mock；生产入口不读取消息中的 URL、凭据、对象键或模型参数。
export function createWorker(deps: Dependencies = { now: Date.now }) {
  async function process(key: AnalysisMessage | null, log: MessageLog, env: Env) {
    if (!key) { log.retry('invalid_message'); return; }
    const store = new Store(env.DB, key);
    const photo = await log.step('load_photo', () => store.photo());
    if (!photo) { log.retry('photo_not_found'); return; }
    const claim = await log.step('claim_analysis', async () => {
      await store.ensure(deps.now());
      return store.claim(deps.now());
    });
    if (!claim) {
      const current = await log.step('read_analysis', () => store.get());
      if (current && current.model !== MODEL) { log.retry('analysis_model_mismatch'); return; }
      if (current?.status === 'succeeded') { log.ack('already_succeeded'); return; }
      const next = current?.status === 'running' ? current.lease_until_ms : current?.next_attempt_at_ms;
      log.retry('analysis_not_claimed', Math.min(900, Math.max(60, Math.ceil(((next ?? 0) - deps.now()) / 1000))),
        { status: current?.status });
      return;
    }

    let image: string;
    try {
      image = await prepareImage(env, photo, log);
    } catch (error) {
      const code = error instanceof PreparationError ? error.code : 'image_read_failed';
      log.failure(code, { preparation_attempt: claim.attempt_count });
      const failed = await log.step('persist_failure', () => store.prepareFailed(claim, deps.now(), code,
        error instanceof PreparationError && error.permanent));
      log.retry(code, retrySeconds(claim.attempt_count), { status: failed?.status });
      return;
    }

    const attemptId = crypto.randomUUID();
    const submitted = await log.step('mark_submitted', () => store.markSubmitted(claim, attemptId, deps.now()));
    if (!submitted) { log.retry('lease_lost_before_submission'); return; }
    let result;
    try {
      result = await log.step('call_provider', () => caption(image, env.AI),
        { timeout_ms: PROVIDER_TIMEOUT_MS });
    } catch (error) {
      const code = error instanceof ProviderUncertain ? error.code : 'provider_outcome_unknown';
      // 先输出失败诊断，即使随后 D1 不可用也能尽可能留下模型调用的不确定边界。
      log.failure(code, { timeout_ms: PROVIDER_TIMEOUT_MS });
      await log.step('persist_failure', () => store.uncertain(attemptId, code,
        error instanceof ProviderUncertain ? error.requestId : null, deps.now()));
      log.retry(code, 60, { status: 'needs_review' });
      return;
    }
    try {
      const saved = await log.step('save_result', () => store.succeed(attemptId, result, deps.now()));
      if (saved) { log.ack('analysis_succeeded', { result_chars: result.text.length }); return; }
    } catch {
      // 结果写入可能已经提交；条件更新不会覆盖 succeeded，也不会重调模型。
      log.failure('result_persistence_unknown');
      await log.step('persist_failure', () => store.uncertain(attemptId, 'result_persistence_unknown', result.requestId, deps.now()));
    }
    log.retry('result_not_confirmed');
  }

  return {
    async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
      // 每条单独确认，坏消息或存储故障不导致已成功消息整批重放。
      for (const message of batch.messages) {
        const key = parseMessage(message.body);
        const log = new MessageLog(message, key, deps.now);
        try { await process(key, log, env); }
        catch {
          // 平台 CPU/内存强制终止不保证进入 catch；需结合平台 invocation outcome。
          log.failure('storage_or_processing_error');
          log.retry('storage_or_processing_error');
        }
      }
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
