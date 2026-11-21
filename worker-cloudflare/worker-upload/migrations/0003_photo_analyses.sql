-- 图片分析独立于原始照片元数据；所有时间为 UTC Unix 毫秒。
CREATE TABLE photo_analyses (
  photo_id TEXT NOT NULL REFERENCES photos(photo_id) ON DELETE RESTRICT,
  analysis_version TEXT NOT NULL CHECK(length(analysis_version) BETWEEN 1 AND 64),
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN
    ('queued', 'running', 'retry_wait', 'needs_review', 'succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at_ms INTEGER NOT NULL,
  lease_token TEXT,
  lease_until_ms INTEGER,
  provider_attempt_id TEXT,
  provider_submitted_at_ms INTEGER,
  provider_request_id TEXT,
  result_text TEXT,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(photo_id, analysis_version),
  CHECK((lease_token IS NULL) = (lease_until_ms IS NULL)),
  CHECK((provider_attempt_id IS NULL) = (provider_submitted_at_ms IS NULL)),
  CHECK((status = 'running') = (lease_token IS NOT NULL)),
  CHECK(status NOT IN ('queued', 'retry_wait', 'failed') OR provider_attempt_id IS NULL),
  CHECK(status NOT IN ('needs_review', 'succeeded') OR provider_attempt_id IS NOT NULL),
  CHECK((status = 'succeeded') = (result_text IS NOT NULL)),
  CHECK(result_text IS NULL OR length(trim(result_text)) BETWEEN 1 AND 16000)
);

CREATE INDEX photo_analyses_status_retry ON photo_analyses(status, next_attempt_at_ms);
CREATE INDEX photo_analyses_status_lease ON photo_analyses(status, lease_until_ms);
