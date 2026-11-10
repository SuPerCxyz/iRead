package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"iread/server/internal/settings"
)

const testTimestamp = "2026-11-09T10:00:00.123456789Z"

func rawTestDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", buildDSN(path))
	if err != nil {
		t.Fatalf("打开测试数据库失败: %v", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Ping(); err != nil {
		t.Fatalf("连接测试数据库失败: %v", err)
	}
	return db
}

func tableExists(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&count); err != nil {
		t.Fatalf("查询表 %s 失败: %v", name, err)
	}
	return count == 1
}

func indexExists(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?`, name).Scan(&count); err != nil {
		t.Fatalf("查询索引 %s 失败: %v", name, err)
	}
	return count == 1
}

func countRows(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM "` + table + `"`).Scan(&count); err != nil {
		t.Fatalf("统计表 %s 失败: %v", table, err)
	}
	return count
}

func migrationCount(t *testing.T, db *sql.DB) int {
	t.Helper()
	return countRows(t, db, "schema_migrations")
}

func mustExec(t *testing.T, db execer, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("执行 SQL 失败: %v\nSQL: %s", err, query)
	}
}

func expectExecError(t *testing.T, db execer, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err == nil {
		t.Fatalf("期望 SQL 失败但成功\nSQL: %s", query)
	}
}

// execer 让同一批插入辅助函数可用于 *sql.DB 与事务。
type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func insertBook(t *testing.T, db execer, id string) {
	t.Helper()
	mustExec(t, db, `
		INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
		VALUES (?, '示例书', 'epub', 'indexing', 0, ?, ?)`,
		id, testTimestamp, testTimestamp)
}

// TestOpenUpgradesStageOneDatabaseAndPreservesSettings 模拟只应用 0001 的旧库，验证升级保留外观数据。
func TestOpenUpgradesStageOneDatabaseAndPreservesSettings(t *testing.T) {
	dir := t.TempDir()
	databasePath := filepath.Join(dir, "iread.db")
	legacy := rawTestDB(t, databasePath)

	mustExec(t, legacy, `
		CREATE TABLE schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		)`)
	script, err := migrationFiles.ReadFile("migrations/0001_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, legacy, string(script))
	mustExec(t, legacy, `INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)`, testTimestamp)

	value := settings.DefaultAppearanceValue()
	value.ThemeMode = "dark"
	rawValue, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, legacy, `
		INSERT INTO app_settings ("group", schema_version, value, revision, updated_at)
		VALUES (?, 1, ?, 7, ?)`,
		settings.AppearanceGroup, string(rawValue), testTimestamp)
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	database := openTestStore(t, dir)
	ctx := context.Background()
	if got := migrationCount(t, database.db); got != 4 {
		t.Fatalf("升级后迁移数量 = %d，期望 4", got)
	}
	record, err := database.GetAppearance(ctx)
	if err != nil {
		t.Fatalf("升级后读取外观失败: %v", err)
	}
	if record.Revision != "7" || record.Value.ThemeMode != "dark" {
		t.Fatalf("升级后外观记录 = %+v", record)
	}
	for _, table := range requiredTables {
		if !tableExists(t, database.db, table) {
			t.Fatalf("升级后缺少表 %s", table)
		}
	}
	if err := database.Check(ctx); err != nil {
		t.Fatalf("升级后 Check() error = %v", err)
	}
}

// TestMigrationsAreIdempotentAcrossReopen 验证重复启动不会重复登记迁移，也不会丢业务行。
func TestMigrationsAreIdempotentAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	first := openTestStore(t, dir)
	bookID := strings.Repeat("a", 32)
	insertBook(t, first.db, bookID)

	appliedAt := map[int]string{}
	rows, err := first.db.Query(`SELECT version, applied_at FROM schema_migrations ORDER BY version`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var version int
		var at string
		if err := rows.Scan(&version, &at); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		appliedAt[version] = at
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if len(appliedAt) != 4 {
		t.Fatalf("首次迁移数量 = %d，期望 4", len(appliedAt))
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second := openTestStore(t, dir)
	if got := migrationCount(t, second.db); got != 4 {
		t.Fatalf("重开后迁移数量 = %d，期望 4", got)
	}
	for version, want := range appliedAt {
		var got string
		if err := second.db.QueryRow(`SELECT applied_at FROM schema_migrations WHERE version = ?`, version).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("版本 %d applied_at 被改写: %q -> %q", version, want, got)
		}
	}
	if got := countRows(t, second.db, "books"); got != 1 {
		t.Fatalf("重开后 books 行数 = %d，期望 1", got)
	}
}

// TestMigrationFailureRollsBackWholeScript 验证单个迁移文件内的多条语句同事务回滚。
func TestMigrationFailureRollsBackWholeScript(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "iread.db")
	db := rawTestDB(t, databasePath)
	ctx := context.Background()

	badFS := fstest.MapFS{
		"migrations/0001_init.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE alpha (id INTEGER PRIMARY KEY);`)},
		"migrations/0002_bad.sql": &fstest.MapFile{Data: []byte(`
			CREATE TABLE beta (id INTEGER PRIMARY KEY);
			INSERT INTO missing_table (id) VALUES (1);
		`)},
	}
	if err := migrateFS(ctx, db, badFS); err == nil {
		t.Fatal("包含无效语句的迁移应失败")
	}
	if !tableExists(t, db, "alpha") {
		t.Fatal("已成功的 0001 应保留")
	}
	if tableExists(t, db, "beta") {
		t.Fatal("失败迁移 0002 中的 beta 表应被事务回滚")
	}
	if got := migrationCount(t, db); got != 1 {
		t.Fatalf("失败后迁移数量 = %d，期望 1", got)
	}

	goodFS := fstest.MapFS{
		"migrations/0001_init.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE alpha (id INTEGER PRIMARY KEY);`)},
		"migrations/0002_good.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE beta (id INTEGER PRIMARY KEY);`)},
	}
	if err := migrateFS(ctx, db, goodFS); err != nil {
		t.Fatalf("修正后的迁移失败: %v", err)
	}
	if !tableExists(t, db, "beta") {
		t.Fatal("修正后的 0002 应成功建表")
	}
	if got := migrationCount(t, db); got != 2 {
		t.Fatalf("修正后迁移数量 = %d，期望 2", got)
	}
}

func TestSchemaTablesAndIndexes(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	for _, table := range requiredTables {
		if !tableExists(t, database.db, table) {
			t.Fatalf("缺少表 %s", table)
		}
	}

	expectedIndexes := []string{
		"idx_sessions_user_active",
		"idx_sessions_absolute_expires",
		"idx_auth_contexts_expires",
		"idx_books_created_id",
		"idx_books_updated_id",
		"idx_books_title_nocase_id",
		"idx_books_format_created_id",
		"idx_books_status_created_id",
		"idx_book_metadata_title_nocase",
		"idx_background_tasks_state_created",
		"idx_background_tasks_book_created",
		"ux_background_tasks_active_book",
		"idx_upload_intents_state_updated",
		"idx_upload_intents_expires",
		"idx_reading_progress_updated_book",
		"idx_bookmarks_book_created_id",
	}
	for _, index := range expectedIndexes {
		if !indexExists(t, database.db, index) {
			t.Fatalf("缺少索引 %s", index)
		}
	}

	var partialSQL string
	if err := database.db.QueryRow(`
		SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_background_tasks_active_book'`,
	).Scan(&partialSQL); err != nil {
		t.Fatal(err)
	}
	normalized := strings.Join(strings.Fields(partialSQL), " ")
	if !strings.Contains(normalized, "WHERE state IN ('queued', 'running')") {
		t.Fatalf("活动任务唯一索引缺少部分条件: %s", normalized)
	}
}

func TestSchemaRuntimePragmasAndTransactionRollback(t *testing.T) {
	database := openTestStore(t, t.TempDir())

	var journalMode string
	if err := database.db.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if journalMode != "wal" {
		t.Fatalf("journal_mode = %q，期望 wal", journalMode)
	}
	var foreignKeys int
	if err := database.db.QueryRow(`PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if foreignKeys != 1 {
		t.Fatalf("foreign_keys = %d，期望 1", foreignKeys)
	}
	var busyTimeout int
	if err := database.db.QueryRow(`PRAGMA busy_timeout`).Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	if busyTimeout != 5000 {
		t.Fatalf("busy_timeout = %d，期望 5000", busyTimeout)
	}

	tx, err := database.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	insertBook(t, txDB{tx: tx}, strings.Repeat("b", 32))
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, database.db, "books"); got != 0 {
		t.Fatalf("回滚后 books 行数 = %d，期望 0", got)
	}
}

// txDB 让 insertBook 可在事务内复用。
type txDB struct {
	tx *sql.Tx
}

func (d txDB) Exec(query string, args ...any) (sql.Result, error) {
	return d.tx.Exec(query, args...)
}

func TestForeignKeyCascade(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	bookID := strings.Repeat("c", 32)
	insertBook(t, database.db, bookID)
	mustExec(t, database.db, `
		INSERT INTO book_files (book_id, original_file_name, extension, media_type, sha256, byte_size, storage_rel_path, created_at)
		VALUES (?, '示例.epub', 'epub', 'application/epub+zip', ?, 10, 'books/example.epub', ?)`,
		bookID, strings.Repeat("d", 64), testTimestamp)
	mustExec(t, database.db, `
		INSERT INTO book_metadata (book_id, extraction_status, updated_at)
		VALUES (?, 'pending', ?)`, bookID, testTimestamp)
	mustExec(t, database.db, `
		INSERT INTO background_tasks (id, kind, book_id, state, created_at, updated_at)
		VALUES (?, 'book.index', ?, 'queued', ?, ?)`,
		strings.Repeat("e", 32), bookID, testTimestamp, testTimestamp)

	mustExec(t, database.db, `DELETE FROM books WHERE id = ?`, bookID)
	for _, table := range []string{"book_files", "book_metadata", "background_tasks"} {
		if got := countRows(t, database.db, table); got != 0 {
			t.Fatalf("删除书籍后 %s 行数 = %d，期望级联删除", table, got)
		}
	}
}

func TestAuthSchemaConstraints(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	db := database.db

	adminInsert := `
		INSERT INTO users (id, password_hash, password_scheme, password_changed_at, created_at, updated_at)
		VALUES ('admin', '$argon2id$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA', 'argon2id', ?, ?, ?)`
	mustExec(t, db, adminInsert, testTimestamp, testTimestamp, testTimestamp)

	expectExecError(t, db, `
		INSERT INTO users (id, password_hash, password_scheme, password_changed_at, created_at, updated_at)
		VALUES ('other', 'hash', 'argon2id', ?, ?, ?)`, testTimestamp, testTimestamp, testTimestamp)
	expectExecError(t, db, adminInsert, testTimestamp, testTimestamp, testTimestamp)
	expectExecError(t, db, `UPDATE users SET password_scheme = 'bcrypt' WHERE id = 'admin'`)

	sessionID := strings.Repeat("a", 64)
	mustExec(t, db, `
		INSERT INTO sessions (id, user_id, csrf_hash, csrf_expires_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
		VALUES (?, 'admin', 'csrf', ?, ?, ?, ?, ?)`,
		sessionID, testTimestamp, testTimestamp, testTimestamp, testTimestamp, testTimestamp)
	var userAgent string
	if err := db.QueryRow(`SELECT user_agent FROM sessions WHERE id = ?`, sessionID).Scan(&userAgent); err != nil {
		t.Fatal(err)
	}
	if userAgent != "" {
		t.Fatalf("user_agent 默认值 = %q，期望空字符串", userAgent)
	}

	expectExecError(t, db, `
		INSERT INTO sessions (id, user_id, csrf_hash, csrf_expires_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
		VALUES (?, 'admin', 'csrf', ?, ?, ?, ?, ?)`,
		strings.Repeat("a", 63), testTimestamp, testTimestamp, testTimestamp, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO sessions (id, user_id, csrf_hash, csrf_expires_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
		VALUES (?, 'admin', 'csrf', ?, ?, ?, ?, ?)`,
		strings.Repeat("z", 64), testTimestamp, testTimestamp, testTimestamp, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO sessions (id, user_id, csrf_hash, csrf_expires_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
		VALUES (?, 'nobody', 'csrf', ?, ?, ?, ?, ?)`,
		strings.Repeat("b", 64), testTimestamp, testTimestamp, testTimestamp, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO sessions (id, user_id, csrf_hash, csrf_expires_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
		VALUES (?, 'admin', NULL, ?, ?, ?, ?, ?)`,
		strings.Repeat("c", 64), testTimestamp, testTimestamp, testTimestamp, testTimestamp, testTimestamp)

	authID := strings.Repeat("d", 64)
	mustExec(t, db, `
		INSERT INTO auth_contexts (id, csrf_hash, created_at, expires_at)
		VALUES (?, 'csrf', ?, ?)`, authID, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO auth_contexts (id, csrf_hash, created_at, expires_at)
		VALUES (?, 'csrf', ?, ?)`, strings.Repeat("d", 32), testTimestamp, testTimestamp)

	mustExec(t, db, `DELETE FROM users WHERE id = 'admin'`)
	if got := countRows(t, db, "sessions"); got != 0 {
		t.Fatalf("删除用户后 sessions 行数 = %d，期望级联删除", got)
	}
}

func TestBookSchemaConstraints(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	db := database.db

	insertBook(t, db, strings.Repeat("1", 32))
	insertBook(t, db, strings.Repeat("F", 32))

	badIDs := []string{"short", strings.Repeat("g", 32)}
	for _, id := range badIDs {
		expectExecError(t, db, `
			INSERT INTO books (id, display_title, format, status, created_at, updated_at)
			VALUES (?, '标题', 'epub', 'ready', ?, ?)`, id, testTimestamp, testTimestamp)
	}
	expectExecError(t, db, `
		INSERT INTO books (id, display_title, format, status, created_at, updated_at)
		VALUES (?, '', 'epub', 'ready', ?, ?)`, strings.Repeat("2", 32), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO books (id, display_title, format, status, created_at, updated_at)
		VALUES (?, ?, 'epub', 'ready', ?, ?)`, strings.Repeat("3", 32), strings.Repeat("题", 501), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO books (id, display_title, format, status, created_at, updated_at)
		VALUES (?, '标题', 'mobi', 'ready', ?, ?)`, strings.Repeat("4", 32), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO books (id, display_title, format, status, created_at, updated_at)
		VALUES (?, '标题', 'epub', 'done', ?, ?)`, strings.Repeat("5", 32), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
		VALUES (?, '标题', 'epub', 'ready', -1, ?, ?)`, strings.Repeat("6", 32), testTimestamp, testTimestamp)
}

func TestBookFileConstraints(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	db := database.db
	firstBook := strings.Repeat("a", 32)
	secondBook := strings.Repeat("b", 32)
	insertBook(t, db, firstBook)
	insertBook(t, db, secondBook)

	insertFile := `
		INSERT INTO book_files (book_id, original_file_name, extension, media_type, sha256, byte_size, storage_rel_path, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	sha := strings.Repeat("1", 64)
	mustExec(t, db, insertFile, firstBook, "示例.epub", "epub", "application/epub+zip", sha, 123, "books/a.epub", testTimestamp)

	expectExecError(t, db, insertFile, secondBook, "重复.epub", "epub", "application/epub+zip", sha, 123, "books/b.epub", testTimestamp)
	expectExecError(t, db, insertFile, secondBook, "坏.epub", "mobi", "application/epub+zip", strings.Repeat("2", 64), 123, "books/c.epub", testTimestamp)
	expectExecError(t, db, insertFile, secondBook, "坏.epub", "epub", "application/epub+zip", strings.Repeat("3", 64), 0, "books/d.epub", testTimestamp)
	expectExecError(t, db, insertFile, secondBook, "坏.epub", "epub", "application/epub+zip", strings.Repeat("4", 63), 123, "books/e.epub", testTimestamp)
	expectExecError(t, db, insertFile, secondBook, "坏.epub", "epub", "application/epub+zip", strings.Repeat("A", 64), 123, "books/f.epub", testTimestamp)
	expectExecError(t, db, insertFile, secondBook, "坏\x00.epub", "epub", "application/epub+zip", strings.Repeat("5", 64), 123, "books/g.epub", testTimestamp)
	expectExecError(t, db, insertFile, secondBook, strings.Repeat("名", 513), "epub", "application/epub+zip", strings.Repeat("6", 64), 123, "books/h.epub", testTimestamp)
	expectExecError(t, db, insertFile, strings.Repeat("f", 32), "缺书.epub", "epub", "application/epub+zip", strings.Repeat("7", 64), 123, "books/i.epub", testTimestamp)
	expectExecError(t, db, insertFile, secondBook, "路径.epub", "epub", "application/epub+zip", strings.Repeat("8", 64), 123, "books/a.epub", testTimestamp)
}

func TestBookMetadataConstraints(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	db := database.db
	bookID := strings.Repeat("a", 32)
	insertBook(t, db, bookID)

	mustExec(t, db, `
		INSERT INTO book_metadata (book_id, extraction_status, updated_at)
		VALUES (?, 'pending', ?)`, bookID, testTimestamp)

	var indexVersion int
	var authorsJSON, tocJSON string
	if err := db.QueryRow(`
		SELECT index_version, authors_json, toc_json FROM book_metadata WHERE book_id = ?`, bookID,
	).Scan(&indexVersion, &authorsJSON, &tocJSON); err != nil {
		t.Fatal(err)
	}
	if indexVersion != 0 || authorsJSON != "[]" || tocJSON != "[]" {
		t.Fatalf("metadata 默认值 = index_version:%d authors:%q toc:%q", indexVersion, authorsJSON, tocJSON)
	}

	expectExecError(t, db, `
		UPDATE book_metadata SET extraction_status = 'done' WHERE book_id = ?`, bookID)
	expectExecError(t, db, `
		UPDATE book_metadata SET page_count = -1 WHERE book_id = ?`, bookID)
}

func TestBackgroundTaskConstraints(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	db := database.db
	bookID := strings.Repeat("a", 32)
	insertBook(t, db, bookID)

	taskID := strings.Repeat("1", 32)
	mustExec(t, db, `
		INSERT INTO background_tasks (id, kind, book_id, state, created_at, updated_at)
		VALUES (?, 'book.index', ?, 'queued', ?, ?)`, taskID, bookID, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO background_tasks (id, kind, book_id, state, created_at, updated_at)
		VALUES (?, 'book.index', ?, 'running', ?, ?)`, strings.Repeat("2", 32), bookID, testTimestamp, testTimestamp)

	var attempt, revision int
	var phase string
	if err := db.QueryRow(`
		SELECT attempt, revision, progress_phase FROM background_tasks WHERE id = ?`, taskID,
	).Scan(&attempt, &revision, &phase); err != nil {
		t.Fatal(err)
	}
	if attempt != 1 || revision != 1 || phase != "queued" {
		t.Fatalf("task 默认值 = attempt:%d revision:%d phase:%q", attempt, revision, phase)
	}

	expectExecError(t, db, `
		INSERT INTO background_tasks (id, kind, state, created_at, updated_at)
		VALUES (?, 'other', 'queued', ?, ?)`, strings.Repeat("3", 32), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO background_tasks (id, kind, state, created_at, updated_at)
		VALUES (?, 'cache.clear', 'done', ?, ?)`, strings.Repeat("4", 32), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO background_tasks (id, kind, state, attempt, created_at, updated_at)
		VALUES (?, 'cache.clear', 'queued', 0, ?, ?)`, strings.Repeat("5", 32), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO background_tasks (id, kind, state, revision, created_at, updated_at)
		VALUES (?, 'cache.clear', 'queued', 0, ?, ?)`, strings.Repeat("6", 32), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO background_tasks (id, kind, state, progress_completed, created_at, updated_at)
		VALUES (?, 'cache.clear', 'queued', -1, ?, ?)`, strings.Repeat("7", 32), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO background_tasks (id, kind, state, error_retryable, created_at, updated_at)
		VALUES (?, 'cache.clear', 'queued', 2, ?, ?)`, strings.Repeat("8", 32), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO background_tasks (id, kind, state, cancellation_requested, created_at, updated_at)
		VALUES (?, 'cache.clear', 'queued', 2, ?, ?)`, strings.Repeat("9", 32), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO background_tasks (id, kind, state, created_at, updated_at)
		VALUES (?, 'book.index', 'queued', ?, ?)`, "bad-id", testTimestamp, testTimestamp)

	// cache.clear 的 book_id 为 NULL；SQLite 唯一索引允许并行存在多个 NULL。
	mustExec(t, db, `
		INSERT INTO background_tasks (id, kind, book_id, state, created_at, updated_at)
		VALUES (?, 'cache.clear', NULL, 'queued', ?, ?)`, strings.Repeat("a", 32), testTimestamp, testTimestamp)
	mustExec(t, db, `
		INSERT INTO background_tasks (id, kind, book_id, state, created_at, updated_at)
		VALUES (?, 'cache.clear', NULL, 'queued', ?, ?)`, strings.Repeat("b", 32), testTimestamp, testTimestamp)

	// 终态任务不占用活动任务唯一槽位。
	mustExec(t, db, `UPDATE background_tasks SET state = 'succeeded' WHERE id = ?`, taskID)
	mustExec(t, db, `
		INSERT INTO background_tasks (id, kind, book_id, state, created_at, updated_at)
		VALUES (?, 'book.index', ?, 'queued', ?, ?)`, strings.Repeat("c", 32), bookID, testTimestamp, testTimestamp)
}

func TestUploadIntentConstraints(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	db := database.db

	insertIntent := `
		INSERT INTO upload_intents (id, client_upload_id, file_name, expected_size, state, created_at, updated_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	intentID := strings.Repeat("a", 32)
	mustExec(t, db, insertIntent, intentID, "client-1", "示例.epub", 100, "awaiting-upload", testTimestamp, testTimestamp, testTimestamp)

	var bytesReceived int
	var commitPhase string
	if err := db.QueryRow(`
		SELECT bytes_received, commit_phase FROM upload_intents WHERE id = ?`, intentID,
	).Scan(&bytesReceived, &commitPhase); err != nil {
		t.Fatal(err)
	}
	if bytesReceived != 0 || commitPhase != "none" {
		t.Fatalf("upload intent 默认值 = bytes_received:%d commit_phase:%q", bytesReceived, commitPhase)
	}

	expectExecError(t, db, insertIntent, strings.Repeat("b", 32), "client-1", "另一个.epub", 100, "awaiting-upload", testTimestamp, testTimestamp, testTimestamp)
	expectExecError(t, db, insertIntent, strings.Repeat("c", 32), "client-2", "坏.epub", 100, "ready", testTimestamp, testTimestamp, testTimestamp)
	expectExecError(t, db, insertIntent, strings.Repeat("d", 32), "client-3", "坏.epub", 0, "awaiting-upload", testTimestamp, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		UPDATE upload_intents SET byte_size = 0 WHERE id = ?`, intentID)
	expectExecError(t, db, `
		UPDATE upload_intents SET bytes_received = -1 WHERE id = ?`, intentID)
	expectExecError(t, db, `
		UPDATE upload_intents SET commit_phase = 'done' WHERE id = ?`, intentID)
	expectExecError(t, db, `
		INSERT INTO upload_intents (id, client_upload_id, file_name, expected_size, state, created_at, updated_at, expires_at)
		VALUES ('bad-id', 'client-5', '坏.epub', 100, 'awaiting-upload', ?, ?, ?)`,
		testTimestamp, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO upload_intents (id, client_upload_id, file_name, expected_size, state, created_at, updated_at, expires_at)
		VALUES (?, 'client-6', ?, 100, 'awaiting-upload', ?, ?, ?)`,
		strings.Repeat("f", 32), strings.Repeat("名", 513), testTimestamp, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO upload_intents (id, client_upload_id, file_name, expected_size, state, created_at, updated_at, expires_at)
		VALUES (?, 'client-7', ?, 100, 'awaiting-upload', ?, ?, ?)`,
		strings.Repeat("0", 32), "坏\x00.epub", testTimestamp, testTimestamp, testTimestamp)
}

func TestCheckFailsWhenStageTwoTableIsMissing(t *testing.T) {
	tables := []string{
		"users",
		"sessions",
		"auth_contexts",
		"books",
		"book_files",
		"book_metadata",
		"background_tasks",
		"upload_intents",
	}
	for _, table := range tables {
		t.Run(table, func(t *testing.T) {
			dir := t.TempDir()
			database := openTestStore(t, dir)
			if _, err := database.db.Exec(`DROP TABLE "` + table + `"`); err != nil {
				t.Fatalf("删除表 %s 失败: %v", table, err)
			}
			err := database.Check(context.Background())
			if err == nil {
				t.Fatalf("%s 缺失时 Check() 应失败", table)
			}
			if strings.Contains(err.Error(), dir) {
				t.Fatalf("Check() 错误泄露数据库路径: %v", err)
			}
		})
	}
}
