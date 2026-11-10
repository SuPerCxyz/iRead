-- 阶段3–6：阅读器共享持久化。仅定义 manifest、进度、书签与单书阅读设置；
-- 表存在不代表 HTTP 端点、阅读引擎或后台任务已实现。
-- fileVersion 统一为原件 SHA-256 小写 hex，与 book_files.sha256 使用同一身份。

CREATE TABLE book_manifests (
  book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  file_version TEXT NOT NULL
    CHECK (length(file_version) = 64 AND file_version NOT GLOB '*[^0-9a-f]*'),
  format TEXT NOT NULL CHECK (format IN ('epub', 'pdf', 'cbz', 'cbr')),
  index_version INTEGER NOT NULL CHECK (index_version >= 0),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reading_progress (
  book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  file_version TEXT NOT NULL
    CHECK (length(file_version) = 64 AND file_version NOT GLOB '*[^0-9a-f]*'),
  format TEXT NOT NULL CHECK (format IN ('epub', 'pdf', 'cbz', 'cbr')),
  locator_type TEXT NOT NULL,
  locator_payload TEXT NOT NULL,
  progress_percent REAL NOT NULL
    CHECK (progress_percent >= 0.0 AND progress_percent <= 100.0),
  client_mutation_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_reading_progress_updated_book
  ON reading_progress (updated_at DESC, book_id);

CREATE TABLE progress_mutations (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  client_mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (book_id, client_mutation_id)
);

CREATE TABLE bookmarks (
  bookmark_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(bookmark_id) = 32 AND bookmark_id NOT GLOB '*[^0-9A-Fa-f]*'),
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  file_version TEXT NOT NULL
    CHECK (length(file_version) = 64 AND file_version NOT GLOB '*[^0-9a-f]*'),
  format TEXT NOT NULL CHECK (format IN ('epub', 'pdf', 'cbz', 'cbr')),
  locator_type TEXT NOT NULL,
  locator_payload TEXT NOT NULL,
  locator_key TEXT NOT NULL,
  label TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (book_id, client_mutation_id),
  UNIQUE (book_id, file_version, locator_key)
);

CREATE INDEX idx_bookmarks_book_created_id
  ON bookmarks (book_id, created_at DESC, bookmark_id DESC);

CREATE TABLE book_reader_overrides (
  book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  overrides_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NULL
);
