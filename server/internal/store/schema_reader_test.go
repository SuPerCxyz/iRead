package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func readerConstraintBookIDs(t *testing.T, db *sql.DB) []string {
	t.Helper()
	ids := make([]string, 0, 12)
	for i := 1; i <= 12; i++ {
		id := fmt.Sprintf("%032x", i)
		insertBook(t, db, id)
		ids = append(ids, id)
	}
	return ids
}

func stageThreeMigrationFS(t *testing.T) fstest.MapFS {
	t.Helper()
	files := fstest.MapFS{}
	for _, name := range []string{"0001_init.sql", "0002_auth.sql", "0003_library.sql"} {
		raw, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatalf("读取迁移 %s 失败: %v", name, err)
		}
		files["migrations/"+name] = &fstest.MapFile{Data: raw}
	}
	return files
}

// TestReaderMigrationUpgradesStageThreeDatabase 模拟只应用 0001–0003 的旧库，
// 验证 0004 升级保留书库数据并新增阅读器表。
func TestReaderMigrationUpgradesStageThreeDatabase(t *testing.T) {
	dir := t.TempDir()
	databasePath := filepath.Join(dir, "iread.db")
	legacy := rawTestDB(t, databasePath)
	ctx := context.Background()

	if err := migrateFS(ctx, legacy, stageThreeMigrationFS(t)); err != nil {
		t.Fatalf("应用 0001–0003 失败: %v", err)
	}
	bookID := strings.Repeat("a", 32)
	insertBook(t, legacy, bookID)
	mustExec(t, legacy, `
		INSERT INTO book_files (
			book_id, original_file_name, extension, media_type, sha256, byte_size,
			storage_rel_path, created_at
		) VALUES (?, '旧书.epub', 'epub', 'application/epub+zip', ?, 123,
			'books/legacy.epub', ?)`,
		bookID, strings.Repeat("b", 64), testTimestamp)
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	database := openTestStore(t, dir)
	if got := migrationCount(t, database.db); got != 5 {
		t.Fatalf("升级后迁移数量 = %d，期望 5", got)
	}
	for _, table := range []string{
		"book_manifests", "reading_progress", "progress_mutations",
		"bookmarks", "book_reader_overrides",
	} {
		if !tableExists(t, database.db, table) {
			t.Fatalf("升级后缺少表 %s", table)
		}
	}

	var title, sha string
	if err := database.db.QueryRow(`SELECT display_title FROM books WHERE id = ?`, bookID).Scan(&title); err != nil {
		t.Fatalf("升级后读取书籍失败: %v", err)
	}
	if title != "示例书" {
		t.Fatalf("升级后书籍标题 = %q", title)
	}
	if err := database.db.QueryRow(`SELECT sha256 FROM book_files WHERE book_id = ?`, bookID).Scan(&sha); err != nil {
		t.Fatalf("升级后读取原件失败: %v", err)
	}
	if sha != strings.Repeat("b", 64) {
		t.Fatalf("升级后原件 sha256 = %q", sha)
	}
	if err := database.Check(ctx); err != nil {
		t.Fatalf("升级后 Check() error = %v", err)
	}
}

// TestReaderSchemaConstraintsAndIndexes 验证 0004 的默认值、枚举、数值边界、
// 唯一约束、外键级联与索引顺序。
func TestReaderSchemaConstraintsAndIndexes(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	db := database.db
	books := readerConstraintBookIDs(t, db)
	shaA := strings.Repeat("a", 64)
	shaB := strings.Repeat("b", 64)
	payload := `{"locatorVersion":1,"page":1}`

	// manifest 默认 schema_version=1。
	mustExec(t, db, `
		INSERT INTO book_manifests (
			book_id, file_version, format, index_version, manifest_json, created_at, updated_at
		) VALUES (?, ?, 'epub', 2, '{"schemaVersion":1}', ?, ?)`,
		books[0], shaA, testTimestamp, testTimestamp)
	var manifestSchema int
	if err := db.QueryRow(`SELECT schema_version FROM book_manifests WHERE book_id = ?`, books[0]).Scan(&manifestSchema); err != nil {
		t.Fatal(err)
	}
	if manifestSchema != 1 {
		t.Fatalf("manifest 默认 schema_version = %d，期望 1", manifestSchema)
	}
	expectExecError(t, db, `
		INSERT INTO book_manifests (book_id, file_version, format, index_version, manifest_json, created_at, updated_at)
		VALUES (?, ?, 'epub', 0, '{}', ?, ?)`, books[1], strings.Repeat("A", 64), testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO book_manifests (book_id, file_version, format, index_version, manifest_json, created_at, updated_at)
		VALUES (?, ?, 'mobi', 0, '{}', ?, ?)`, books[1], shaA, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO book_manifests (book_id, file_version, format, index_version, manifest_json, created_at, updated_at)
		VALUES (?, ?, 'epub', -1, '{}', ?, ?)`, books[1], shaA, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO book_manifests (book_id, file_version, format, index_version, manifest_json, created_at, updated_at)
		VALUES (?, ?, 'epub', 0, '{}', ?, ?)`, strings.Repeat("f", 32), shaA, testTimestamp, testTimestamp)

	// 进度默认 revision=1，百分比边界为 0–100。
	mustExec(t, db, `
		INSERT INTO reading_progress (
			book_id, file_version, format, locator_type, locator_payload, progress_percent,
			client_mutation_id, updated_at
		) VALUES (?, ?, 'pdf', 'pdf-page', ?, 0, 'mut-1', ?)`,
		books[0], shaA, payload, testTimestamp)
	var progressRevision int
	if err := db.QueryRow(`SELECT revision FROM reading_progress WHERE book_id = ?`, books[0]).Scan(&progressRevision); err != nil {
		t.Fatal(err)
	}
	if progressRevision != 1 {
		t.Fatalf("进度默认 revision = %d，期望 1", progressRevision)
	}
	expectExecError(t, db, `
		INSERT INTO reading_progress (
			book_id, file_version, format, locator_type, locator_payload, progress_percent,
			client_mutation_id, updated_at
		) VALUES (?, ?, 'pdf', 'pdf-page', ?, 100.1, 'mut-2', ?)`, books[1], shaA, payload, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO reading_progress (
			book_id, file_version, format, locator_type, locator_payload, progress_percent,
			client_mutation_id, updated_at
		) VALUES (?, ?, 'pdf', 'pdf-page', ?, -0.1, 'mut-3', ?)`, books[1], shaA, payload, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO reading_progress (
			book_id, file_version, format, locator_type, locator_payload, progress_percent,
			client_mutation_id, revision, updated_at
		) VALUES (?, ?, 'pdf', 'pdf-page', ?, 1, 'mut-4', 0, ?)`, books[1], shaA, payload, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO reading_progress (
			book_id, file_version, format, locator_type, locator_payload, progress_percent,
			client_mutation_id, updated_at
		) VALUES (?, ?, 'mobi', 'pdf-page', ?, 1, 'mut-5', ?)`, books[1], shaA, payload, testTimestamp)

	// 进度幂等记录主键为 (book_id, client_mutation_id)。
	mustExec(t, db, `
		INSERT INTO progress_mutations (
			book_id, client_mutation_id, request_hash, revision, response_json, created_at
		) VALUES (?, 'mut-1', ?, 1, '{}', ?)`,
		books[0], strings.Repeat("0", 64), testTimestamp)
	expectExecError(t, db, `
		INSERT INTO progress_mutations (
			book_id, client_mutation_id, request_hash, revision, response_json, created_at
		) VALUES (?, 'mut-1', ?, 1, '{}', ?)`,
		books[0], strings.Repeat("1", 64), testTimestamp)
	expectExecError(t, db, `
		INSERT INTO progress_mutations (
			book_id, client_mutation_id, request_hash, revision, response_json, created_at
		) VALUES (?, 'mut-2', ?, 0, '{}', ?)`,
		books[1], strings.Repeat("0", 64), testTimestamp)

	// 书签：32 hex ID、mutationId 去重、原件内 locator_key 去重、revision 起始 1。
	mustExec(t, db, `
		INSERT INTO bookmarks (
			bookmark_id, book_id, file_version, format, locator_type, locator_payload,
			locator_key, label, client_mutation_id, created_at, updated_at
		) VALUES (?, ?, ?, 'pdf', 'pdf-page', ?, 'page:1', '第一页', 'bm-1', ?, ?)`,
		strings.Repeat("1", 32), books[0], shaA, payload, testTimestamp, testTimestamp)
	var bookmarkRevision int
	if err := db.QueryRow(`SELECT revision FROM bookmarks WHERE bookmark_id = ?`, strings.Repeat("1", 32)).Scan(&bookmarkRevision); err != nil {
		t.Fatal(err)
	}
	if bookmarkRevision != 1 {
		t.Fatalf("书签默认 revision = %d，期望 1", bookmarkRevision)
	}
	expectExecError(t, db, `
		INSERT INTO bookmarks (
			bookmark_id, book_id, file_version, format, locator_type, locator_payload,
			locator_key, label, client_mutation_id, created_at, updated_at
		) VALUES (?, ?, ?, 'pdf', 'pdf-page', ?, 'page:2', '重复 mutation', 'bm-1', ?, ?)`,
		strings.Repeat("2", 32), books[0], shaA, payload, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO bookmarks (
			bookmark_id, book_id, file_version, format, locator_type, locator_payload,
			locator_key, label, client_mutation_id, created_at, updated_at
		) VALUES (?, ?, ?, 'pdf', 'pdf-page', ?, 'page:1', '重复定位', 'bm-2', ?, ?)`,
		strings.Repeat("3", 32), books[0], shaA, payload, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO bookmarks (
			bookmark_id, book_id, file_version, format, locator_type, locator_payload,
			locator_key, label, client_mutation_id, created_at, updated_at
		) VALUES ('bad-id', ?, ?, 'pdf', 'pdf-page', ?, 'page:1', '坏 ID', 'bm-3', ?, ?)`,
		books[1], shaA, payload, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO bookmarks (
			bookmark_id, book_id, file_version, format, locator_type, locator_payload,
			locator_key, label, client_mutation_id, revision, created_at, updated_at
		) VALUES (?, ?, ?, 'pdf', 'pdf-page', ?, 'page:1', '坏 revision', 'bm-4', 0, ?, ?)`,
		strings.Repeat("4", 32), books[1], shaA, payload, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO bookmarks (
			bookmark_id, book_id, file_version, format, locator_type, locator_payload,
			locator_key, label, client_mutation_id, created_at, updated_at
		) VALUES (?, ?, ?, 'mobi', 'pdf-page', ?, 'page:1', '坏格式', 'bm-5', ?, ?)`,
		strings.Repeat("5", 32), books[1], shaA, payload, testTimestamp, testTimestamp)
	expectExecError(t, db, `
		INSERT INTO bookmarks (
			bookmark_id, book_id, file_version, format, locator_type, locator_payload,
			locator_key, label, client_mutation_id, created_at, updated_at
		) VALUES (?, ?, ?, 'pdf', 'pdf-page', ?, 'page:1', '缺书', 'bm-6', ?, ?)`,
		strings.Repeat("6", 32), strings.Repeat("e", 32), shaB, payload, testTimestamp, testTimestamp)

	// 单书覆盖默认 schema_version=1、overrides={}、revision=0、updated_at=NULL。
	mustExec(t, db, `INSERT INTO book_reader_overrides (book_id) VALUES (?)`, books[0])
	var overrideSchema, overrideRevision int
	var overridesJSON string
	var updatedAt sql.NullString
	if err := db.QueryRow(`
		SELECT schema_version, overrides_json, revision, updated_at
		FROM book_reader_overrides WHERE book_id = ?`, books[0]).
		Scan(&overrideSchema, &overridesJSON, &overrideRevision, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if overrideSchema != 1 || overridesJSON != "{}" || overrideRevision != 0 || updatedAt.Valid {
		t.Fatalf("单书覆盖默认值 = schema:%d overrides:%q revision:%d updated:%v",
			overrideSchema, overridesJSON, overrideRevision, updatedAt)
	}
	expectExecError(t, db, `
		INSERT INTO book_reader_overrides (book_id, revision) VALUES (?, -1)`, books[1])

	// 索引名称与列顺序。
	for name, want := range map[string]string{
		"idx_reading_progress_updated_book": "updated_at DESC, book_id",
		"idx_bookmarks_book_created_id":     "book_id, created_at DESC, bookmark_id DESC",
	} {
		if !indexExists(t, db, name) {
			t.Fatalf("缺少索引 %s", name)
		}
		var statement string
		if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, name).Scan(&statement); err != nil {
			t.Fatal(err)
		}
		normalized := strings.Join(strings.Fields(statement), " ")
		if !strings.Contains(normalized, want) {
			t.Fatalf("索引 %s 列顺序 = %q，期望包含 %q", name, normalized, want)
		}
	}

	// 删除书籍级联清理所有阅读器记录。
	mustExec(t, db, `DELETE FROM books WHERE id = ?`, books[0])
	for _, table := range []string{
		"book_manifests", "reading_progress", "progress_mutations",
		"bookmarks", "book_reader_overrides",
	} {
		if got := countRows(t, db, table); got != 0 {
			t.Fatalf("删除书籍后 %s 行数 = %d，期望级联删除", table, got)
		}
	}
}

// TestReaderRowsSurviveReopen 验证 0004 迁移重复执行不会重建/清空阅读器数据。
func TestReaderRowsSurviveReopen(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	first := openTestStore(t, dir)
	bookID := strings.Repeat("a", 32)
	insertBook(t, first.db, bookID)
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	first.now = func() time.Time { return now }

	fileVersion := strings.Repeat("b", 64)
	if _, err := first.UpsertBookManifest(ctx, BookManifest{
		BookID: bookID, FileVersion: fileVersion, Format: ReaderFormatEPUB,
		IndexVersion: 1, ManifestJSON: json.RawMessage(`{"schemaVersion":1}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := first.PutReadingProgress(ctx, PutReadingProgressParams{
		BookID: bookID, FileVersion: fileVersion, Format: ReaderFormatEPUB,
		LocatorType: "epub-cfi", LocatorPayload: json.RawMessage(`{"spineIndex":1}`),
		ProgressPercent: 12, BaseRevision: 0, ClientMutationID: "m1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := first.CreateBookmark(ctx, CreateBookmarkParams{
		BookID: bookID, FileVersion: fileVersion, Format: ReaderFormatEPUB,
		LocatorType: "epub-cfi", LocatorPayload: json.RawMessage(`{"spineIndex":1}`),
		LocatorKey: "cfi:1", Label: "第一章", ClientMutationID: "b1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := first.PutBookReaderOverrides(ctx, PutBookReaderOverridesParams{
		BookID: bookID, BaseRevision: 0, Overrides: json.RawMessage(`{"fontSize":18}`),
	}); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second := openTestStore(t, dir)
	if got := migrationCount(t, second.db); got != 5 {
		t.Fatalf("重开后迁移数量 = %d，期望 5", got)
	}
	for _, table := range []string{
		"book_manifests", "reading_progress", "progress_mutations",
		"bookmarks", "book_reader_overrides",
	} {
		if got := countRows(t, second.db, table); got != 1 {
			t.Fatalf("重开后 %s 行数 = %d，期望 1", table, got)
		}
	}
	if progress, err := second.GetReadingProgress(ctx, bookID); err != nil || progress == nil || progress.Revision != 1 {
		t.Fatalf("重开后进度 = %+v err=%v", progress, err)
	}
	if record, err := second.GetBookReaderOverrides(ctx, bookID); err != nil || record.Revision != 1 {
		t.Fatalf("重开后单书设置 = %+v err=%v", record, err)
	}
}

func TestCheckFailsWhenReaderTableIsMissing(t *testing.T) {
	for _, table := range []string{
		"book_manifests", "reading_progress", "progress_mutations",
		"bookmarks", "book_reader_overrides",
	} {
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
