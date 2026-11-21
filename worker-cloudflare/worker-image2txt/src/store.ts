import { type Analysis, type AnalysisMessage, type Photo, LEASE_MS, MAX_PREPARATION_ATTEMPTS, MODEL, retrySeconds } from './types';
import type { Caption } from './workers-ai';

export class Store {
  constructor(private readonly db: D1Database, private readonly key: AnalysisMessage) {}

  private statement(sql: string, ...values: unknown[]) {
    return this.db.prepare(sql).bind(...values, this.key.photo_id, this.key.analysis_version);
  }

  photo() {
    return this.db.prepare('SELECT photo_id, object_key, sha256, mime_type, byte_size FROM photos WHERE photo_id = ?')
      .bind(this.key.photo_id).first<Photo>();
  }

  async ensure(now: number) {
    await this.db.prepare(`INSERT INTO photo_analyses
      (photo_id, analysis_version, model, next_attempt_at_ms, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(photo_id, analysis_version) DO NOTHING`)
      .bind(this.key.photo_id, this.key.analysis_version, MODEL, now, now, now).run();
  }

  get() {
    return this.statement('SELECT * FROM photo_analyses WHERE photo_id = ? AND analysis_version = ?').first<Analysis>();
  }

  async claim(now: number): Promise<Analysis | null> {
    // 调用标记已经持久化的过期任务绝不重新领取；可能已发送或计费。
    await this.statement(`UPDATE photo_analyses SET status = 'needs_review', lease_token = NULL,
      lease_until_ms = NULL, error_code = 'provider_outcome_unknown', updated_at_ms = ?
      WHERE status = 'running' AND lease_until_ms <= ? AND provider_attempt_id IS NOT NULL
      AND photo_id = ? AND analysis_version = ?`, now, now).run();
    await this.statement(`UPDATE photo_analyses SET status = 'failed', lease_token = NULL,
      lease_until_ms = NULL, error_code = 'preparation_attempts_exhausted', updated_at_ms = ?
      WHERE provider_attempt_id IS NULL AND attempt_count >= ?
      AND (status IN ('queued', 'retry_wait') OR (status = 'running' AND lease_until_ms <= ?))
      AND photo_id = ? AND analysis_version = ?`, now, MAX_PREPARATION_ATTEMPTS, now).run();
    return this.statement(`UPDATE photo_analyses SET status = 'running', attempt_count = attempt_count + 1,
      lease_token = ?, lease_until_ms = ?, error_code = NULL, updated_at_ms = ?
      WHERE provider_attempt_id IS NULL AND attempt_count < ? AND next_attempt_at_ms <= ?
      AND (status IN ('queued', 'retry_wait') OR (status = 'running' AND lease_until_ms <= ?))
      AND model = ? AND photo_id = ? AND analysis_version = ? RETURNING *`,
      crypto.randomUUID(), now + LEASE_MS, now, MAX_PREPARATION_ATTEMPTS, now, now, MODEL).first<Analysis>();
  }

  prepareFailed(claim: Analysis, now: number, code: string, permanent: boolean) {
    return this.statement(`UPDATE photo_analyses SET status = ?, next_attempt_at_ms = ?,
      lease_token = NULL, lease_until_ms = NULL, error_code = ?, updated_at_ms = ?
      WHERE status = 'running' AND lease_token = ? AND provider_attempt_id IS NULL
      AND photo_id = ? AND analysis_version = ? RETURNING *`,
      permanent || claim.attempt_count >= MAX_PREPARATION_ATTEMPTS ? 'failed' : 'retry_wait',
      now + retrySeconds(claim.attempt_count) * 1000, code, now, claim.lease_token).first<Analysis>();
  }

  markSubmitted(claim: Analysis, attemptId: string, now: number) {
    // RETURNING 的成功响应是发送门槛；D1 写入响应丢失也不允许发起请求。
    return this.statement(`UPDATE photo_analyses SET provider_attempt_id = ?, provider_submitted_at_ms = ?,
      lease_until_ms = ?, updated_at_ms = ? WHERE status = 'running' AND lease_token = ?
      AND lease_until_ms > ? AND provider_attempt_id IS NULL AND photo_id = ? AND analysis_version = ? RETURNING *`,
      attemptId, now, now + LEASE_MS, now, claim.lease_token, now).first<Analysis>();
  }

  succeed(attemptId: string, result: Caption, now: number) {
    // 即便另一消费者已把过期 lease 标为待核查，同一调用的迟到成功仍可保存。
    return this.statement(`UPDATE photo_analyses SET status = 'succeeded', result_text = ?,
      provider_request_id = ?, lease_token = NULL, lease_until_ms = NULL, error_code = NULL, updated_at_ms = ?
      WHERE provider_attempt_id = ? AND status IN ('running', 'needs_review')
      AND photo_id = ? AND analysis_version = ? RETURNING *`,
      result.text, result.requestId, now, attemptId).first<Analysis>();
  }

  uncertain(attemptId: string, code: string, requestId: string | null, now: number) {
    return this.statement(`UPDATE photo_analyses SET status = 'needs_review', lease_token = NULL,
      lease_until_ms = NULL, error_code = ?, provider_request_id = COALESCE(?, provider_request_id), updated_at_ms = ?
      WHERE provider_attempt_id = ? AND status IN ('running', 'needs_review')
      AND photo_id = ? AND analysis_version = ? RETURNING *`,
      code, requestId, now, attemptId).first<Analysis>();
  }
}
