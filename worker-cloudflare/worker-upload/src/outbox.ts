import { DEFAULT_ANALYSIS_VERSION, getAnalysisProfile } from '../../shared/analysis-config';

export interface AnalysisDispatchMessage { photo_id: string; analysis_version: string }
export interface DispatchEnv {
  DB: D1Database;
  IMAGE2TXT_QUEUE: Queue<AnalysisDispatchMessage>;
  PHOTO_ANALYSIS_ENABLED: boolean;
  OUTBOX_BATCH_SIZE: number;
  OUTBOX_LEASE_SECONDS: number;
  OUTBOX_RETRY_BASE_SECONDS: number;
  OUTBOX_RETRY_MAX_SECONDS: number;
}
export interface DispatchSettings {
  enabled: boolean;
  batchSize: number;
  leaseSeconds: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}
export function dispatchSettings(env: DispatchEnv): DispatchSettings {
  const integer = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
  if (typeof env.PHOTO_ANALYSIS_ENABLED !== 'boolean'
    || !integer(env.OUTBOX_BATCH_SIZE, 1, 100) || !integer(env.OUTBOX_LEASE_SECONDS, 30, 900)
    || !integer(env.OUTBOX_RETRY_BASE_SECONDS, 1, 3600)
    || !integer(env.OUTBOX_RETRY_MAX_SECONDS, env.OUTBOX_RETRY_BASE_SECONDS, 86400)) {
    throw new Error('invalid_outbox_configuration');
  }
  return { enabled: env.PHOTO_ANALYSIS_ENABLED, batchSize: env.OUTBOX_BATCH_SIZE,
    leaseSeconds: env.OUTBOX_LEASE_SECONDS, retryBaseSeconds: env.OUTBOX_RETRY_BASE_SECONDS,
    retryMaxSeconds: env.OUTBOX_RETRY_MAX_SECONDS };
}

export async function newDispatchVersion(env: DispatchEnv): Promise<string | null> {
  if (!dispatchSettings(env).enabled) return null;
  await getAnalysisProfile(DEFAULT_ANALYSIS_VERSION);
  return DEFAULT_ANALYSIS_VERSION;
}
export function insertDispatch(db: D1Database, photoId: string, version: string, now: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO photo_analysis_dispatch
    (photo_id, analysis_version, dispatch_after_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)`)
    .bind(photoId, version, now, now, now);
}
// 每次调用最多领取一个有界批次；不循环清空队列，不依赖请求上下文完成全部历史任务。
export async function drainOutbox(env: DispatchEnv, photoId?: string, clock = Date.now): Promise<void> {
  const settings = dispatchSettings(env);
  if (!settings.enabled) return;
  const now = clock(), token = crypto.randomUUID();
  const selection = photoId === undefined ? '' : 'AND photo_id = ?';
  const values: unknown[] = [token, now + settings.leaseSeconds * 1000, now, now, now];
  if (photoId !== undefined) values.push(photoId);
  values.push(settings.batchSize);
  const result = await env.DB.prepare(`UPDATE photo_analysis_dispatch
    SET lease_token = ?, lease_until_ms = ?, publish_attempts = publish_attempts + 1, updated_at_ms = ?
    WHERE (photo_id, analysis_version) IN (
      SELECT photo_id, analysis_version FROM photo_analysis_dispatch
      WHERE published_at_ms IS NULL AND dispatch_after_ms <= ?
        AND (lease_until_ms IS NULL OR lease_until_ms <= ?) ${selection}
      ORDER BY dispatch_after_ms, created_at_ms, photo_id, analysis_version LIMIT ?
    ) RETURNING photo_id, analysis_version`).bind(...values).all<AnalysisDispatchMessage>();
  const rows = result.results;
  if (rows.length === 0) return;
  try {
    if (!env.IMAGE2TXT_QUEUE || typeof env.IMAGE2TXT_QUEUE.sendBatch !== 'function') throw new Error('missing_queue_binding');
    await env.IMAGE2TXT_QUEUE.sendBatch(rows.map(row => ({
      body: { photo_id: row.photo_id, analysis_version: row.analysis_version }, contentType: 'json' as const,
    })));
    const done = clock();
    // 接收响应丢失/lease 过期可能导致重复投递；旧 token 不得覆盖新的领取者。
    await env.DB.prepare(`UPDATE photo_analysis_dispatch SET published_at_ms = ?, lease_token = NULL,
      lease_until_ms = NULL, error_code = NULL, updated_at_ms = ?
      WHERE published_at_ms IS NULL AND lease_token = ?`).bind(done, done, token).run();
    console.info({ service: 'photo-outbox', event: 'dispatch_accepted', count: rows.length });
  } catch {
    const failed = clock();
    // 一个UPDATE按每行尝试次数计算退避，避免大批失败时耗尽D1查询额度。
    // publish_attempts在领取时已加1；位移上限20，防止指数溢出。
    await env.DB.prepare(`UPDATE photo_analysis_dispatch
      SET dispatch_after_ms = ? + MIN(?, ? * (1 << MIN(publish_attempts - 1, 20))) * 1000,
        lease_token = NULL, lease_until_ms = NULL, error_code = 'queue_publish_unconfirmed', updated_at_ms = ?
      WHERE published_at_ms IS NULL AND lease_token = ?`)
      .bind(failed, settings.retryMaxSeconds, settings.retryBaseSeconds, failed, token).run();
    console.warn({ service: 'photo-outbox', event: 'dispatch_retry_scheduled', count: rows.length,
      code: 'queue_publish_unconfirmed' });
  }
}
export async function dispatchSafely(env: DispatchEnv, photoId?: string): Promise<void> {
  try { await drainOutbox(env, photoId); }
  catch {
    // 即使本次 waitUntil/Cron 失败，持久化记录仍在，lease 到期后可重领。
    console.warn({ service: 'photo-outbox', event: 'dispatch_deferred', code: 'dispatch_storage_or_config_error' });
  }
}
