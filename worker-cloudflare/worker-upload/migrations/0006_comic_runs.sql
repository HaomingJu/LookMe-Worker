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
