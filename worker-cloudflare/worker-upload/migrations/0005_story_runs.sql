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
