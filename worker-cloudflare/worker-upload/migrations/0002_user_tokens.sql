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
