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
