-- 阶段2：书库原件、元数据、后台任务与上传意图。原件与派生数据分离，状态不能冒充可读。

CREATE TABLE books (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9A-Fa-f]*'),
  display_title TEXT NOT NULL CHECK (length(display_title) BETWEEN 1 AND 500),
  format TEXT NOT NULL CHECK (format IN ('epub', 'pdf', 'cbz', 'cbr')),
  status TEXT NOT NULL CHECK (status IN ('indexing', 'ready', 'unsupported', 'error')),
  index_version INTEGER NOT NULL DEFAULT 0 CHECK (index_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_books_created_id
  ON books (created_at DESC, id DESC);
CREATE INDEX idx_books_updated_id
  ON books (updated_at DESC, id DESC);
CREATE INDEX idx_books_title_nocase_id
  ON books (display_title COLLATE NOCASE, id);
CREATE INDEX idx_books_format_created_id
  ON books (format, created_at DESC, id);
CREATE INDEX idx_books_status_created_id
  ON books (status, created_at DESC, id);

CREATE TABLE book_files (
  book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  original_file_name TEXT NOT NULL
    CHECK (length(original_file_name) BETWEEN 1 AND 512 AND instr(original_file_name, char(0)) = 0),
  extension TEXT NOT NULL CHECK (extension IN ('epub', 'pdf', 'cbz', 'cbr')),
  media_type TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE
    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  storage_rel_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE book_metadata (
  book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NULL,
  subtitle TEXT NULL,
  language TEXT NULL,
  publisher TEXT NULL,
  published_at TEXT NULL,
  identifier TEXT NULL,
  authors_json TEXT NOT NULL DEFAULT '[]',
  page_count INTEGER NULL CHECK (page_count >= 0),
  toc_json TEXT NOT NULL DEFAULT '[]',
  cover_resource_id TEXT NULL,
  index_version INTEGER NOT NULL DEFAULT 0,
  extraction_status TEXT NOT NULL
    CHECK (extraction_status IN ('pending', 'ok', 'partial', 'failed', 'unsupported')),
  extracted_at TEXT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_book_metadata_title_nocase
  ON book_metadata (title COLLATE NOCASE);

CREATE TABLE background_tasks (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9A-Fa-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('book.index', 'cache.clear')),
  book_id TEXT NULL REFERENCES books(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  progress_phase TEXT NOT NULL DEFAULT 'queued',
  progress_completed INTEGER NOT NULL DEFAULT 0 CHECK (progress_completed >= 0),
  progress_total INTEGER NULL CHECK (progress_total >= 0),
  error_code TEXT NULL,
  error_message TEXT NULL,
  error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0, 1)),
  cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL,
  lease_until TEXT NULL
);

CREATE INDEX idx_background_tasks_state_created
  ON background_tasks (state, created_at);
CREATE INDEX idx_background_tasks_book_created
  ON background_tasks (book_id, created_at);
CREATE UNIQUE INDEX ux_background_tasks_active_book
  ON background_tasks (book_id) WHERE state IN ('queued', 'running');

CREATE TABLE upload_intents (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9A-Fa-f]*'),
  client_upload_id TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL
    CHECK (length(file_name) BETWEEN 1 AND 512 AND instr(file_name, char(0)) = 0),
  expected_size INTEGER NOT NULL CHECK (expected_size > 0),
  byte_size INTEGER NULL CHECK (byte_size > 0),
  state TEXT NOT NULL
    CHECK (state IN ('awaiting-upload', 'uploading', 'stored', 'duplicate', 'failed', 'cancelled', 'expired')),
  bytes_received INTEGER NOT NULL DEFAULT 0 CHECK (bytes_received >= 0),
  temporary_rel_path TEXT NULL,
  final_rel_path TEXT NULL,
  commit_phase TEXT NOT NULL DEFAULT 'none'
    CHECK (commit_phase IN ('none', 'prepared', 'renamed', 'committed')),
  book_id TEXT NULL,
  duplicate_of_book_id TEXT NULL,
  task_id TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  error_retryable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_upload_intents_state_updated
  ON upload_intents (state, updated_at);
CREATE INDEX idx_upload_intents_expires
  ON upload_intents (expires_at);
