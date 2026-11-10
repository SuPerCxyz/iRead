package jobs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"iread/server/internal/store"
)

type cacheFixture struct {
	bookID      string
	fileVersion string
	original    string
	originalRaw []byte
	coversPath  string
	comicPath   string
}

func (e *jobsEnv) seedCacheFixture(t *testing.T) cacheFixture {
	t.Helper()
	bookID := randomID(t)
	original := []byte("original-book-bytes-must-survive-cache-clear")
	digest := sha256.Sum256(original)
	fileVersion := hex.EncodeToString(digest[:])
	relative := filepath.ToSlash(filepath.Join(bookID, fileVersion+".epub"))
	fullOriginal := filepath.Join(e.books, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(fullOriginal), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fullOriginal, original, 0o600); err != nil {
		t.Fatal(err)
	}
	now := e.nextTime().UTC().Format("2006-01-02T15:04:05.000000000Z07:00")
	if _, err := e.db.Exec(`
		INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
		VALUES (?, 'Cache Fixture', 'epub', 'ready', 1, ?, ?)`,
		bookID, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Exec(`
		INSERT INTO book_files (
			book_id, original_file_name, extension, media_type, sha256, byte_size,
			storage_rel_path, created_at
		) VALUES (?, 'fixture.epub', 'epub', 'application/epub+zip', ?, ?, ?, ?)`,
		bookID, fileVersion, len(original), relative, now); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Exec(`
		INSERT INTO book_metadata (book_id, extraction_status, updated_at)
		VALUES (?, 'ok', ?)`, bookID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Exec(`
		INSERT INTO reading_progress (
			book_id, file_version, format, locator_type, locator_payload,
			progress_percent, client_mutation_id, revision, updated_at
		) VALUES (?, ?, 'epub', 'epub-cfi', '{"locatorVersion":1,"spineIndex":2}',
			42.5, 'cache-fixture-mutation', 3, ?)`,
		bookID, fileVersion, now); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Exec(`
		INSERT INTO bookmarks (
			bookmark_id, book_id, file_version, format, locator_type, locator_payload,
			locator_key, label, client_mutation_id, revision, created_at, updated_at
		) VALUES (?, ?, ?, 'epub', 'epub-cfi', '{"locatorVersion":1,"spineIndex":2}',
			'cache-fixture-key', '缓存测试书签', 'cache-fixture-bookmark', 1, ?, ?)`,
		randomID(t), bookID, fileVersion, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Exec(`
		INSERT INTO book_reader_overrides (book_id, schema_version, overrides_json, revision, updated_at)
		VALUES (?, 1, '{"reflow":{"fontSize":18}}', 2, ?)`, bookID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Exec(`
		INSERT INTO app_settings ("group", schema_version, value, revision, updated_at)
		VALUES ('appearance', 1, '{"theme":"dark","schemaVersion":1}', 4, ?)`, now); err != nil {
		t.Fatal(err)
	}

	coversPath := filepath.Join(e.cache, "covers", bookID, "1")
	comicPath := filepath.Join(e.cache, "comic", bookID, fileVersion)
	for _, dir := range []string{coversPath, comicPath, filepath.Join(e.cache, "keep")} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []struct {
		path string
		size int
	}{
		{filepath.Join(coversPath, "grid.jpg"), 101},
		{filepath.Join(coversPath, "detail.jpg"), 203},
		{filepath.Join(comicPath, "page-1.jpg"), 307},
		{filepath.Join(e.cache, "keep", "unrelated.txt"), 17},
	} {
		if err := os.WriteFile(file.path, make([]byte, file.size), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return cacheFixture{
		bookID:      bookID,
		fileVersion: fileVersion,
		original:    fullOriginal,
		originalRaw: original,
		coversPath:  coversPath,
		comicPath:   comicPath,
	}
}

func dirIsEmpty(t *testing.T, path string) bool {
	t.Helper()
	entries, err := os.ReadDir(path)
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	if err != nil {
		t.Fatalf("读取目录 %s: %v", path, err)
	}
	return len(entries) == 0
}

func TestCacheClearRemovesOnlyDerivedCache(t *testing.T) {
	env := newJobsEnv(t)
	fixture := env.seedCacheFixture(t)

	before, err := MeasureDerivedCache(env.cache)
	if err != nil {
		t.Fatalf("MeasureDerivedCache() error = %v", err)
	}
	if before.Entries != 3 || before.DerivedBytes != 611 {
		t.Fatalf("清理前用量 = %+v", before)
	}
	if before.ByKind["covers"].Entries != 2 || before.ByKind["comic"].Entries != 1 {
		t.Fatalf("清理前 byKind = %+v", before.ByKind)
	}

	task, created, err := env.store.CreateCacheClearTask(context.Background())
	if err != nil || !created {
		t.Fatalf("CreateCacheClearTask() created=%v err=%v", created, err)
	}
	env.startManager(env.manager(1))
	finished := env.waitTask(task.ID, store.TaskStateSucceeded)
	if finished.ProgressPhase != "done" || finished.ProgressTotal == nil ||
		*finished.ProgressTotal != before.Entries || finished.ProgressCompleted != before.Entries {
		t.Fatalf("缓存清理任务 progress = phase:%s completed:%d total:%v",
			finished.ProgressPhase, finished.ProgressCompleted, finished.ProgressTotal)
	}

	if !dirIsEmpty(t, filepath.Join(env.cache, "covers")) {
		t.Fatal("covers 派生缓存未清空")
	}
	if !dirIsEmpty(t, filepath.Join(env.cache, "comic")) {
		t.Fatal("comic 派生缓存未清空")
	}
	if _, err := os.Stat(filepath.Join(env.cache, "keep", "unrelated.txt")); err != nil {
		t.Fatalf("非派生缓存文件不应被删除: %v", err)
	}
	originalBytes, err := os.ReadFile(fixture.original)
	if err != nil || string(originalBytes) != string(fixture.originalRaw) {
		t.Fatalf("原件被修改: err=%v bytes=%q", err, originalBytes)
	}

	var progressCount, bookmarkCount, overrideCount int
	var settingsValue string
	if err := env.db.QueryRow(`SELECT COUNT(*) FROM reading_progress WHERE book_id = ?`, fixture.bookID).Scan(&progressCount); err != nil {
		t.Fatal(err)
	}
	if err := env.db.QueryRow(`SELECT COUNT(*) FROM bookmarks WHERE book_id = ?`, fixture.bookID).Scan(&bookmarkCount); err != nil {
		t.Fatal(err)
	}
	if err := env.db.QueryRow(`SELECT COUNT(*) FROM book_reader_overrides WHERE book_id = ?`, fixture.bookID).Scan(&overrideCount); err != nil {
		t.Fatal(err)
	}
	if err := env.db.QueryRow(`SELECT value FROM app_settings WHERE "group" = 'appearance'`).Scan(&settingsValue); err != nil {
		t.Fatal(err)
	}
	if progressCount != 1 || bookmarkCount != 1 || overrideCount != 1 {
		t.Fatalf("派生缓存清理影响了阅读数据: progress=%d bookmark=%d override=%d",
			progressCount, bookmarkCount, overrideCount)
	}
	if settingsValue != `{"theme":"dark","schemaVersion":1}` {
		t.Fatalf("全局设置被修改: %s", settingsValue)
	}
	if _, err := os.Stat(filepath.Join(env.root, "db", "iread.db")); err != nil {
		t.Fatalf("数据库文件不应被删除: %v", err)
	}

	after, err := MeasureDerivedCache(env.cache)
	if err != nil {
		t.Fatalf("清理后 MeasureDerivedCache() error = %v", err)
	}
	if after.DerivedBytes != 0 || after.Entries != 0 {
		t.Fatalf("清理后用量 = %+v", after)
	}
}

func TestCacheClearReusesActiveTaskAndCreatesNewAfterTerminal(t *testing.T) {
	env := newJobsEnv(t)
	first, created, err := env.store.CreateCacheClearTask(context.Background())
	if err != nil || !created {
		t.Fatalf("首次创建 created=%v err=%v", created, err)
	}
	second, created, err := env.store.CreateCacheClearTask(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if created || second.ID != first.ID {
		t.Fatalf("活动任务应复用: created=%v first=%s second=%s", created, first.ID, second.ID)
	}

	env.startManager(env.manager(1))
	env.waitTask(first.ID, store.TaskStateSucceeded)
	third, created, err := env.store.CreateCacheClearTask(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !created || third.ID == first.ID {
		t.Fatalf("终态后应创建新任务: created=%v first=%s third=%s", created, first.ID, third.ID)
	}
}

func TestCacheClearPartialFailureIsRetryable(t *testing.T) {
	env := newJobsEnv(t)
	firstBook := randomID(t)
	secondBook := randomID(t)
	failingPath := filepath.Join(env.cache, "covers", firstBook)
	otherPath := filepath.Join(env.cache, "covers", secondBook)
	comicPath := filepath.Join(env.cache, "comic", randomID(t))
	for _, file := range []struct {
		path string
		size int
	}{
		{filepath.Join(failingPath, "1", "grid.jpg"), 11},
		{filepath.Join(otherPath, "1", "grid.jpg"), 13},
		{filepath.Join(comicPath, "v1", "page.jpg"), 17},
	} {
		if err := os.MkdirAll(filepath.Dir(file.path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file.path, make([]byte, file.size), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	manager := env.manager(1)
	var failed atomic.Bool
	manager.cacheRemoveHook = func(path string) error {
		if path == failingPath && failed.CompareAndSwap(false, true) {
			return errors.New("注入删除失败")
		}
		return os.RemoveAll(path)
	}
	task, created, err := env.store.CreateCacheClearTask(context.Background())
	if err != nil || !created {
		t.Fatalf("CreateCacheClearTask() created=%v err=%v", created, err)
	}
	env.startManager(manager)
	failedTask := env.waitTask(task.ID, store.TaskStateFailed)
	if failedTask.ErrorCode == nil || *failedTask.ErrorCode != ErrorCodeCacheClearFailed || !failedTask.ErrorRetryable {
		t.Fatalf("部分失败任务 = %+v", failedTask)
	}
	if _, err := os.Stat(failingPath); err != nil {
		t.Fatalf("注入失败的条目应保留: %v", err)
	}
	if _, err := os.Stat(otherPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("其他成功条目应被删除: %v", err)
	}
	if _, err := os.Stat(comicPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("其他 scope 应继续清理: %v", err)
	}
	remaining, err := MeasureDerivedCache(env.cache)
	if err != nil {
		t.Fatalf("部分失败后 MeasureDerivedCache() error = %v", err)
	}
	if remaining.Entries != 1 || remaining.DerivedBytes != 11 {
		t.Fatalf("部分失败后剩余用量 = %+v", remaining)
	}

	retry, created, err := env.store.CreateCacheClearTask(context.Background())
	if err != nil || !created || retry.ID == task.ID {
		t.Fatalf("失败后重新清理应创建新任务: created=%v retry=%s err=%v", created, retry.ID, err)
	}
	manager.Notify()
	env.waitTask(retry.ID, store.TaskStateSucceeded)
	after, err := MeasureDerivedCache(env.cache)
	if err != nil {
		t.Fatalf("重试后 MeasureDerivedCache() error = %v", err)
	}
	if after.Entries != 0 || after.DerivedBytes != 0 {
		t.Fatalf("重试后仍有派生缓存: %+v", after)
	}
}

func TestCacheClearFailedTaskRetriesInPlace(t *testing.T) {
	env := newJobsEnv(t)
	bookID := randomID(t)
	failingPath := filepath.Join(env.cache, "covers", bookID)
	if err := os.MkdirAll(filepath.Dir(filepath.Join(failingPath, "1", "grid.jpg")), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(failingPath, "1", "grid.jpg"), make([]byte, 9), 0o600); err != nil {
		t.Fatal(err)
	}

	manager := env.manager(1)
	var failed atomic.Bool
	manager.cacheRemoveHook = func(path string) error {
		if path == failingPath && failed.CompareAndSwap(false, true) {
			return errors.New("注入删除失败")
		}
		return os.RemoveAll(path)
	}
	task, created, err := env.store.CreateCacheClearTask(context.Background())
	if err != nil || !created {
		t.Fatalf("CreateCacheClearTask() created=%v err=%v", created, err)
	}
	env.startManager(manager)
	failedTask := env.waitTask(task.ID, store.TaskStateFailed)
	if failedTask.BookID != nil || !failedTask.ErrorRetryable {
		t.Fatalf("失败缓存任务 = %+v", failedTask)
	}

	retried, err := env.store.RetryTask(context.Background(), task.ID, failedTask.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if retried.State != store.TaskStateQueued || retried.Attempt != 2 ||
		retried.Revision != failedTask.Revision+1 || retried.BookID != nil {
		t.Fatalf("重试缓存任务 = %+v", retried)
	}
	manager.Notify()
	succeeded := env.waitTask(task.ID, store.TaskStateSucceeded)
	if succeeded.Attempt != 2 {
		t.Fatalf("重试后 attempt = %d", succeeded.Attempt)
	}
	after, err := MeasureDerivedCache(env.cache)
	if err != nil {
		t.Fatalf("重试后 MeasureDerivedCache() error = %v", err)
	}
	if after.Entries != 0 || after.DerivedBytes != 0 {
		t.Fatalf("重试后仍有派生缓存: %+v", after)
	}
}

func TestCacheClearRefusesSymlinkedScope(t *testing.T) {
	env := newJobsEnv(t)
	outside := filepath.Join(env.root, "outside")
	if err := os.MkdirAll(outside, 0o750); err != nil {
		t.Fatal(err)
	}
	outsideFile := filepath.Join(outside, "keep.txt")
	if err := os.WriteFile(outsideFile, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(env.cache, "covers")); err != nil {
		t.Skipf("当前环境不支持符号链接: %v", err)
	}
	if _, err := MeasureDerivedCache(env.cache); err == nil {
		t.Fatal("符号链接 scope 不应被统计")
	}

	task, _, err := env.store.CreateCacheClearTask(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	env.startManager(env.manager(1))
	failedTask := env.waitTask(task.ID, store.TaskStateFailed)
	if failedTask.ErrorCode == nil || *failedTask.ErrorCode != ErrorCodeCacheClearFailed {
		t.Fatalf("符号链接 scope 应失败: %+v", failedTask)
	}
	if _, err := os.Stat(outsideFile); err != nil {
		t.Fatalf("清理不应跟随符号链接删除外部文件: %v", err)
	}
}

func TestCacheClearCancellationStopsBeforeCommit(t *testing.T) {
	env := newJobsEnv(t)
	cachePath := filepath.Join(env.cache, "covers", randomID(t), "1")
	if err := os.MkdirAll(cachePath, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cachePath, "grid.jpg"), make([]byte, 32), 0o600); err != nil {
		t.Fatal(err)
	}

	manager := env.manager(1)
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	manager.phaseHook = func(phase string) {
		if phase != "clear" {
			return
		}
		once.Do(func() {
			close(entered)
			<-release
		})
	}
	task, _, err := env.store.CreateCacheClearTask(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	env.startManager(manager)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("缓存清理任务未进入 clear 阶段")
	}
	if _, accepted, err := env.store.CancelTask(context.Background(), task.ID, 2); err != nil || !accepted {
		t.Fatalf("取消缓存清理任务 accepted=%v err=%v", accepted, err)
	}
	close(release)

	cancelled := env.waitTask(task.ID, store.TaskStateCancelled)
	if cancelled.ErrorCode == nil || *cancelled.ErrorCode != store.TaskErrorIndexCancelled || !cancelled.ErrorRetryable {
		t.Fatalf("缓存清理取消终态 = %+v", cancelled)
	}
}

func TestCacheClearDoesNotBlockFollowingBookIndex(t *testing.T) {
	env := newJobsEnv(t)
	cacheTask, _, err := env.store.CreateCacheClearTask(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// 固定 cache.clear 更早的创建时间，确保它排在随后登记的 book.index 之前。
	if _, err := env.db.Exec(`
		UPDATE background_tasks SET created_at = '2026-01-01T00:00:00.000000000Z' WHERE id = ?`,
		cacheTask.ID); err != nil {
		t.Fatal(err)
	}
	bookID, indexTask := env.insertBook("epub", "After Cache Clear",
		buildEPUB(t, epubSampleOptions{nav: true, cover: true, nonce: 44}))
	env.startManager(env.manager(1))

	cleared := env.waitTask(cacheTask.ID, store.TaskStateSucceeded)
	indexed := env.waitTask(indexTask, store.TaskStateSucceeded)
	env.waitBookStatus(bookID, "ready")
	if indexed.StartedAt == nil || cleared.FinishedAt == nil || indexed.StartedAt.Before(*cleared.FinishedAt) {
		t.Fatalf("单 worker 应串行执行: clear finish=%v index start=%v", cleared.FinishedAt, indexed.StartedAt)
	}
}
