-- 阶段2：单管理员认证。会话/预认证上下文只保存原始 cookie token 的 SHA-256。

CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK (id = 'admin'),
  password_hash TEXT NOT NULL,
  password_scheme TEXT NOT NULL CHECK (password_scheme = 'argon2id'),
  password_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9A-Fa-f]*'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  csrf_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_sessions_user_active
  ON sessions (user_id, revoked_at, absolute_expires_at);
CREATE INDEX idx_sessions_absolute_expires
  ON sessions (absolute_expires_at);

CREATE TABLE auth_contexts (
  id TEXT PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9A-Fa-f]*'),
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL
);

CREATE INDEX idx_auth_contexts_expires
  ON auth_contexts (expires_at);
