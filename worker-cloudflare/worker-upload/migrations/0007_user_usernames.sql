-- 为 users 增加人类可记的用户名；user_id（UUID）仍为主键，username 与 user_id 1:1 且唯一（大小写不敏感）。
-- 历史补建用户 username 为 NULL，待管理员用 rename-user 补记；新用户由 CLI 强制要求 username。
ALTER TABLE users ADD COLUMN username TEXT
  CHECK(username IS NULL OR (length(username) BETWEEN 1 AND 64 AND username NOT GLOB '*[^A-Za-z0-9_-]*'));

CREATE UNIQUE INDEX users_username_unique ON users(username COLLATE NOCASE) WHERE username IS NOT NULL;
