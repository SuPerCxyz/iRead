package jobs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"iread/server/internal/reader/comic"
	"iread/server/internal/store"
)

func comicFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "reader", "comic", "testdata", name))
	if err != nil {
		t.Fatalf("读取漫画样本 %s: %v", name, err)
	}
	return data
}

func TestManagerIndexesCBRFixtures(t *testing.T) {
	for _, fixture := range []string{
		"comic_rar4.rar", "comic_rar5.rar",
		"comic_solid_rar4.rar", "comic_solid_rar5.rar",
	} {
		t.Run(fixture, func(t *testing.T) {
			env := newJobsEnv(t)
			data := comicFixture(t, fixture)
			bookID, taskID := env.insertBook("cbr", "Comic RAR", data)
			beforeHash := env.fileHash(bookID)
			env.startManager(env.manager(1))

			task := env.waitTask(taskID, store.TaskStateSucceeded)
			if task.ErrorCode != nil || task.ErrorRetryable {
				t.Fatalf("CBR 任务 error = %+v", task)
			}
			if task.ProgressPhase != "finalize" || task.ProgressCompleted != 3 {
				t.Fatalf("CBR 进度 = %s/%d，期望 finalize/3",
					task.ProgressPhase, task.ProgressCompleted)
			}

			var status, title, authorsJSON, tocJSON, extractionStatus, coverID string
			var pageCount, indexVersion int64
			if err := env.db.QueryRow(`SELECT status, index_version FROM books WHERE id = ?`, bookID).
				Scan(&status, &indexVersion); err != nil {
				t.Fatal(err)
			}
			if err := env.db.QueryRow(`
				SELECT title, authors_json, page_count, toc_json, extraction_status, cover_resource_id
				FROM book_metadata WHERE book_id = ?`, bookID).Scan(
				&title, &authorsJSON, &pageCount, &tocJSON, &extractionStatus, &coverID); err != nil {
				t.Fatal(err)
			}
			if status != "ready" || indexVersion != 1 {
				t.Fatalf("CBR book status/version = %s/%d", status, indexVersion)
			}
			if title != "Comic RAR" || pageCount != 3 || extractionStatus != "ok" ||
				coverID != "cover:1" {
				t.Fatalf("CBR metadata = %q page=%d status=%s cover=%q",
					title, pageCount, extractionStatus, coverID)
			}
			if authorsJSON != "[]" || tocJSON != "[]" {
				t.Fatalf("CBR authors/toc = %s/%s", authorsJSON, tocJSON)
			}

			// 自然排序后的首图是 page1.jpg（320×200），封面不得放大。
			assertCoverDimensions(t, env.cache, bookID, 1, CoverVariantGrid, 320, 200)
			assertCoverDimensions(t, env.cache, bookID, 1, CoverVariantDetail, 320, 200)

			var fileVersion string
			if err := env.db.QueryRow(`SELECT sha256 FROM book_files WHERE book_id = ?`, bookID).
				Scan(&fileVersion); err != nil {
				t.Fatal(err)
			}
			screenPath, err := comic.ScreenCachePath(
				env.cache, bookID, fileVersion, comic.ResourceID("page1.jpg"))
			if err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(screenPath)
			if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
				t.Fatalf("CBR screen 缓存不可用: path=%s err=%v", screenPath, err)
			}

			if afterHash := env.fileHash(bookID); afterHash != beforeHash {
				t.Fatalf("CBR 索引修改了原件: before=%s after=%s", beforeHash, afterHash)
			}
		})
	}
}

func TestManagerRejectsCBRFixturesWithRealReasons(t *testing.T) {
	corrupt := comicFixture(t, "comic_rar5.rar")
	corrupt = corrupt[:len(corrupt)-100]
	tests := []struct {
		name string
		data []byte
		code string
	}{
		{name: "encrypted", data: comicFixture(t, "comic_encrypted_rar5.rar"),
			code: ErrorCodeEncryptedArchive},
		{name: "multi-volume", data: comicFixture(t, "comic_multi.part1.rar"),
			code: ErrorCodeUnsupportedArchive},
		{name: "symlink", data: comicFixture(t, "comic_symlink_rar5.rar"),
			code: ErrorCodeUnsafeArchive},
		{name: "traversal", data: comicFixture(t, "comic_traversal.rar"),
			code: ErrorCodeUnsafeArchive},
		{name: "corrupt", data: corrupt, code: ErrorCodeInvalidArchive},
		{name: "signature-only", data: []byte("Rar!\x1a\x07\x00not-a-real-rar"),
			code: ErrorCodeInvalidArchive},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			env := newJobsEnv(t)
			bookID, taskID := env.insertBook("cbr", "Broken Comic", test.data)
			beforeHash := env.fileHash(bookID)
			env.startManager(env.manager(1))

			task := env.waitTask(taskID, store.TaskStateFailed)
			if task.ErrorCode == nil || *task.ErrorCode != test.code || task.ErrorRetryable {
				t.Fatalf("CBR 失败任务 = %+v，期望 code=%s retryable=false",
					task, test.code)
			}

			var status string
			var indexVersion int64
			if err := env.db.QueryRow(`SELECT status, index_version FROM books WHERE id = ?`, bookID).
				Scan(&status, &indexVersion); err != nil {
				t.Fatal(err)
			}
			if status != "error" || indexVersion != 0 {
				t.Fatalf("CBR 失败后书籍 = %s/%d，不得 ready", status, indexVersion)
			}
			var extractionStatus string
			var pageCount int64
			if err := env.db.QueryRow(`
				SELECT extraction_status, COALESCE(page_count, -1)
				FROM book_metadata WHERE book_id = ?`, bookID).
				Scan(&extractionStatus, &pageCount); err != nil {
				t.Fatal(err)
			}
			if extractionStatus != "failed" || pageCount != -1 {
				t.Fatalf("CBR 失败元数据 = %s page=%d", extractionStatus, pageCount)
			}
			if _, err := os.Stat(filepath.Join(env.cache, "covers", bookID)); !os.IsNotExist(err) {
				t.Fatalf("失败任务不应写入封面: %v", err)
			}
			if afterHash := env.fileHash(bookID); afterHash != beforeHash {
				t.Fatalf("CBR 失败路径修改了原件: before=%s after=%s", beforeHash, afterHash)
			}
		})
	}
}

func TestManagerCBRFailureDoesNotBlockQueue(t *testing.T) {
	env := newJobsEnv(t)
	_, failedTaskID := env.insertBook("cbr", "Broken",
		[]byte("Rar!\x1a\x07\x00not-a-real-rar"))
	goodBook, goodTaskID := env.insertBook("cbr", "Solid",
		comicFixture(t, "comic_solid_rar5.rar"))
	env.startManager(env.manager(1))

	failed := env.waitTask(failedTaskID, store.TaskStateFailed)
	if failed.ErrorCode == nil || *failed.ErrorCode != ErrorCodeInvalidArchive {
		t.Fatalf("首个 CBR 失败任务 = %+v", failed)
	}
	good := env.waitTask(goodTaskID, store.TaskStateSucceeded)
	if good.StartedAt == nil || failed.FinishedAt == nil ||
		good.StartedAt.Before(*failed.FinishedAt) {
		t.Fatalf("后续 CBR 任务未被队列继续执行: failed=%+v good=%+v", failed, good)
	}
	env.waitBookStatus(goodBook, "ready")
}

func TestManagerCBRRetryAfterOriginalRestored(t *testing.T) {
	env := newJobsEnv(t)
	data := comicFixture(t, "comic_rar4.rar")
	bookID, taskID := env.insertBook("cbr", "Retry Comic", data)
	path := env.path(bookID)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	manager := env.manager(1)
	env.startManager(manager)

	task := env.waitTask(taskID, store.TaskStateFailed)
	if task.ErrorCode == nil || *task.ErrorCode != ErrorCodeFileUnavailable || !task.ErrorRetryable {
		t.Fatalf("原件缺失任务 = %+v", task)
	}
	env.waitBookStatus(bookID, "error")

	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := env.store.RetryTask(context.Background(), taskID, task.Revision); err != nil {
		t.Fatalf("重试 CBR 任务: %v", err)
	}
	manager.Notify()

	env.waitTask(taskID, store.TaskStateSucceeded)
	env.waitBookStatus(bookID, "ready")
	var pageCount int64
	if err := env.db.QueryRow(`SELECT page_count FROM book_metadata WHERE book_id = ?`, bookID).
		Scan(&pageCount); err != nil {
		t.Fatal(err)
	}
	if pageCount != 3 {
		t.Fatalf("重试后 page_count = %d", pageCount)
	}
}

func TestExtractCBRHonorsCancelledContext(t *testing.T) {
	env := newJobsEnv(t)
	bookID, _ := env.insertBook("cbr", "Cancelled", comicFixture(t, "comic_rar5.rar"))
	source, err := env.store.GetBookSource(context.Background(), bookID)
	if err != nil {
		t.Fatal(err)
	}
	manager := env.manager(1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err = manager.extractCBR(ctx, source, env.path(bookID),
		func(string, int64) error { return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("取消上下文应快速返回 context.Canceled，得到 %v", err)
	}
}

func TestComicIndexErrorMapsParserTimeoutAsRetryable(t *testing.T) {
	err := comicIndexError(fmt.Errorf("%w: %w", comic.ErrParserTimeout, context.DeadlineExceeded))
	var indexErr *indexError
	if !errors.As(err, &indexErr) {
		t.Fatalf("错误类型 = %T", err)
	}
	if indexErr.Code != ErrorCodeParserTimeout || !indexErr.Retryable {
		t.Fatalf("超时错误 = %+v", indexErr)
	}
}
