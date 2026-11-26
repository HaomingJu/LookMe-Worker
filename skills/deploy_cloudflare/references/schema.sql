-- LookMe D1 当前完整结构快照（0001 + 0002 + 0003 + 0004 + 0005 + 0006 + 0007）；已有库只应用缺失的版本化迁移。
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
-- username 为人类可记的唯一用户名（大小写不敏感），与 user_id 1:1；历史补建用户为 NULL 待补记。
CREATE TABLE users (
  user_id TEXT PRIMARY KEY NOT NULL,
  username TEXT CHECK(username IS NULL OR (length(username) BETWEEN 1 AND 64 AND username NOT GLOB '*[^A-Za-z0-9_-]*')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  created_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX users_username_unique ON users(username COLLATE NOCASE) WHERE username IS NOT NULL;

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

-- 手动故事批次；不回填历史文件，不触发模型或漫画任务。
CREATE TABLE story_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  story_date TEXT NOT NULL CHECK(length(story_date) = 10),
  timezone TEXT NOT NULL,
  date_basis TEXT NOT NULL,
  story_version TEXT NOT NULL,
  analysis_version TEXT NOT NULL,
  model TEXT NOT NULL,
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  status TEXT NOT NULL CHECK(status IN ('generating','succeeded','needs_review')),
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(owner_id, run_id),
  CHECK((status = 'succeeded') = (response_json IS NOT NULL))
);
CREATE INDEX story_runs_owner_date ON story_runs(owner_id, story_date, created_at_ms DESC, run_id DESC);

-- 保存本次输入的真实照片关联和摘要快照；复合外键杜绝跨用户关联。
CREATE TABLE story_run_photos (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  summary_text TEXT NOT NULL,
  PRIMARY KEY(run_id, photo_id),
  UNIQUE(run_id, position),
  FOREIGN KEY(owner_id, run_id) REFERENCES story_runs(owner_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY(owner_id, photo_id) REFERENCES photos(owner_id, photo_id) ON DELETE RESTRICT
);

-- 稳定story_id供后续worker-comic引用；当前不创建任何漫画任务。
CREATE TABLE stories (
  story_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 7),
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  summary TEXT NOT NULL CHECK(length(trim(summary)) > 0),
  image_prompt TEXT NOT NULL CHECK(length(trim(image_prompt)) > 0),
  panels_json TEXT NOT NULL CHECK(json_valid(panels_json) AND json_type(panels_json) = 'array' AND json_array_length(panels_json) = 4),
  source_photo_ids_json TEXT NOT NULL CHECK(json_valid(source_photo_ids_json) AND json_type(source_photo_ids_json) = 'array' AND json_array_length(source_photo_ids_json) > 0),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(run_id, position),
  UNIQUE(owner_id, story_id),
  FOREIGN KEY(owner_id, run_id) REFERENCES story_runs(owner_id, run_id) ON DELETE RESTRICT
);
CREATE INDEX stories_owner_run ON stories(owner_id, run_id, position);

-- Each story is a logical comic task. An owner can retain many independently
-- requested results for it. Legacy comic_jobs/dispatch tables are untouched.
CREATE TABLE comic_runs (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  story_id TEXT NOT NULL,
  model TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  status TEXT NOT NULL CHECK(status IN ('generating','succeeded','needs_review')),
  provider_request_id TEXT,
  result_object_key TEXT UNIQUE,
  result_mime_type TEXT CHECK(result_mime_type IN ('image/png','image/jpeg')),
  result_byte_size INTEGER CHECK(result_byte_size BETWEEN 1 AND 8388608),
  result_sha256 TEXT CHECK(length(result_sha256) = 64),
  result_width INTEGER CHECK(result_width > 0),
  result_height INTEGER CHECK(result_height > 0),
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(owner_id, run_id),
  FOREIGN KEY(owner_id, story_id) REFERENCES stories(owner_id, story_id) ON DELETE RESTRICT,
  CHECK((status = 'succeeded') = (result_object_key IS NOT NULL)),
  CHECK((status = 'succeeded') = (result_mime_type IS NOT NULL)),
  CHECK((status = 'succeeded') = (result_byte_size IS NOT NULL)),
  CHECK((status = 'succeeded') = (result_sha256 IS NOT NULL)),
  CHECK((status = 'succeeded') = (result_width IS NOT NULL)),
  CHECK((status = 'succeeded') = (result_height IS NOT NULL)),
  CHECK((status = 'needs_review') = (error_code IS NOT NULL))
);
CREATE INDEX comic_runs_story_history ON comic_runs(owner_id, story_id, created_at_ms DESC, run_id DESC);
