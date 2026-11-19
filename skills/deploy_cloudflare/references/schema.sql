-- LookMe Demo D1 初始迁移模板；发布前对照现有迁移。
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
