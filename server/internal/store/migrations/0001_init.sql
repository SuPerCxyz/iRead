CREATE TABLE app_settings (
  "group" TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
