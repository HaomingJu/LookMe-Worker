export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  AI: Ai;
}

export interface AnalysisMessage {
  photo_id: string;
  analysis_version: typeof ANALYSIS_VERSION;
}

export interface Photo {
  photo_id: string;
  object_key: string;
  sha256: string;
  mime_type: string;
  byte_size: number;
}

export interface Analysis extends AnalysisMessage {
  model: string;
  status: 'queued' | 'running' | 'retry_wait' | 'needs_review' | 'succeeded' | 'failed';
  attempt_count: number;
  next_attempt_at_ms: number;
  lease_token: string | null;
  lease_until_ms: number | null;
  provider_attempt_id: string | null;
  provider_submitted_at_ms: number | null;
  provider_request_id: string | null;
  result_text: string | null;
  error_code: string | null;
}

// v1 保留为历史 Moondream 语义；Gemma 使用新版本，禁止混用结果。
export const ANALYSIS_VERSION = 'v2';
export const MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const LEASE_MS = 120_000;
export const MAX_PREPARATION_ATTEMPTS = 5;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const retrySeconds = (attempt: number) => Math.min(60 * 2 ** Math.min(attempt - 1, 4), 900);
