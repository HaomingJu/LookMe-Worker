-- LookMe D1 当前完整结构快照（0001 + 0002 + 0003 + 0004）；已有库只应用缺失的版本化迁移。
-- 时间统一为 UTC Unix 毫秒；owner_id 来自认证，不接受客户端自报。
CREATE TABLE photos (
  photo_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  client_photo_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg' CHECK(mime_type = 'image/jpeg'),
  byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 2097152),
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 2048),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 2048),
  source TEXT NOT NULL CHECK(source IN ('cli','apple_app','device')),
  captured_at_ms INTEGER,
  captured_at_source TEXT CHECK(captured_at_source IN ('exif','apple_photos','device','manual')),
  uploaded_at_ms INTEGER NOT NULL,
  CHECK((captured_at_ms IS NULL) = (captured_at_source IS NULL)),
  UNIQUE(owner_id, client_photo_id),
  UNIQUE(owner_id, photo_id)
);

CREATE TABLE comic_jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  client_job_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  prompt_version TEXT NOT NULL,
  generation_config_json TEXT NOT NULL CHECK(json_valid(generation_config_json)),
  status TEXT NOT NULL CHECK(status IN
    ('queued','running','retry_wait','needs_review','succeeded','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  lease_token TEXT,
  lease_until_ms INTEGER,
  provider_submitted_at_ms INTEGER,
  provider_attempt_id TEXT,
  provider_request_id TEXT,
  result_object_key TEXT UNIQUE,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK((lease_token IS NULL) = (lease_until_ms IS NULL)),
  CHECK((provider_submitted_at_ms IS NULL) = (provider_attempt_id IS NULL)),
  CHECK(status <> 'running' OR lease_token IS NOT NULL),
  CHECK(status <> 'succeeded' OR result_object_key IS NOT NULL),
  UNIQUE(owner_id, client_job_id),
  UNIQUE(owner_id, job_id)
);

CREATE INDEX comic_jobs_status_lease ON comic_jobs(status, lease_until_ms);

CREATE TABLE comic_job_photos (
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 2),
  PRIMARY KEY(job_id, position),
  UNIQUE(job_id, photo_id),
  FOREIGN KEY(owner_id, job_id) REFERENCES comic_jobs(owner_id, job_id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, photo_id) REFERENCES photos(owner_id, photo_id) ON DELETE RESTRICT
);

CREATE INDEX comic_job_photos_photo ON comic_job_photos(owner_id, photo_id);

CREATE TABLE job_dispatch (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES comic_jobs(job_id) ON DELETE CASCADE,
  dispatch_after_ms INTEGER NOT NULL,
  published_at_ms INTEGER,
  publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK(publish_attempts >= 0)
);

CREATE INDEX job_dispatch_pending ON job_dispatch(dispatch_after_ms) WHERE published_at_ms IS NULL;

-- 保留已有照片/任务归属；不重建已有业务表，不为历史 owner 自动签发凭据。
CREATE TABLE users (
  user_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  created_at_ms INTEGER NOT NULL
);

INSERT INTO users (user_id, created_at_ms)
SELECT owner_id, MIN(created_at_ms) FROM (
  SELECT owner_id, uploaded_at_ms AS created_at_ms FROM photos
  UNION ALL
  SELECT owner_id, created_at_ms FROM comic_jobs
) GROUP BY owner_id;

CREATE TABLE user_tokens (
  token_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
  revoked_at_ms INTEGER
);

CREATE INDEX user_tokens_user ON user_tokens(user_id);

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

-- 仅新上传写入 Outbox；不扫描或补投历史照片。
-- 与 photos 在同一 D1 batch 事务中插入，Queue 接收成功不等于 AI 分析完成。
CREATE TABLE photo_analysis_dispatch (
  photo_id TEXT NOT NULL REFERENCES photos(photo_id) ON DELETE RESTRICT,
  analysis_version TEXT NOT NULL CHECK(length(analysis_version) BETWEEN 1 AND 64),
  dispatch_after_ms INTEGER NOT NULL,
  published_at_ms INTEGER,
  publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK(publish_attempts >= 0),
  lease_token TEXT,
  lease_until_ms INTEGER,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(photo_id, analysis_version),
  CHECK((lease_token IS NULL) = (lease_until_ms IS NULL)),
  CHECK(published_at_ms IS NULL OR lease_token IS NULL)
);

CREATE INDEX photo_analysis_dispatch_pending
  ON photo_analysis_dispatch(dispatch_after_ms, lease_until_ms)
  WHERE published_at_ms IS NULL;
