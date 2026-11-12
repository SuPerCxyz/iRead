package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func testLibraryNow() time.Time {
	return time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
}

func createLibraryIntent(t *testing.T, database *Store, clientID string) UploadIntent {
	t.Helper()
	now := testLibraryNow()
	intent, created, err := database.CreateUploadIntent(context.Background(), CreateUploadIntentParams{
		ID:             strings.Repeat("1", 32),
		ClientUploadID: clientID,
		FileName:       "book.epub",
		ExpectedSize:   4,
		ExpiresAt:      now.Add(24 * time.Hour),
		Now:            now,
	})
	if err != nil || !created {
		t.Fatalf("CreateUploadIntent() = %+v, %v, %v", intent, created, err)
	}
	return intent
}

func TestUploadIntentConflictClaimAndRetry(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	ctx := context.Background()
	intent := createLibraryIntent(t, database, "client-1")

	existing, created, err := database.CreateUploadIntent(ctx, CreateUploadIntentParams{
		ID:             strings.Repeat("2", 32),
		ClientUploadID: "client-1",
		FileName:       "different.epub",
		ExpectedSize:   99,
		ExpiresAt:      testLibraryNow().Add(time.Hour),
		Now:            testLibraryNow(),
	})
	if err != nil || created || existing.ID != intent.ID {
		t.Fatalf("重复 clientUploadId = %+v, created=%v, err=%v", existing, created, err)
	}

	claimed, ok, err := database.ClaimUploadContent(ctx, intent.ID, ".staging/"+intent.ID+".part", testLibraryNow())
	if err != nil || !ok || claimed.State != "uploading" {
		t.Fatalf("首次 claim = %+v, %v, %v", claimed, ok, err)
	}
	if _, ok, err := database.ClaimUploadContent(ctx, intent.ID, ".staging/"+intent.ID+".part", testLibraryNow()); err != nil || ok {
		t.Fatalf("并发 claim 应失败: ok=%v err=%v", ok, err)
	}
	failed, err := database.MarkUploadFailed(ctx, intent.ID, 2, "invalid_file", "校验失败", "corrupt_container", false, testLibraryNow())
	if err != nil || failed.State != "failed" || failed.ErrorCode == nil {
		t.Fatalf("MarkUploadFailed = %+v, %v", failed, err)
	}
	if failed.ErrorReason == nil || *failed.ErrorReason != "corrupt_container" {
		t.Fatalf("ErrorReason = %v, 期望 corrupt_container", failed.ErrorReason)
	}
	retried, ok, err := database.ClaimUploadContent(ctx, intent.ID, ".staging/"+intent.ID+".part", testLibraryNow())
	if err != nil || !ok || retried.State != "uploading" || retried.ErrorCode != nil || retried.ErrorReason != nil {
		t.Fatalf("失败后重试 claim = %+v, %v, %v", retried, ok, err)
	}
}

func TestPrepareCommitAndAbortPrepared(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	ctx := context.Background()
	intent := createLibraryIntent(t, database, "client-commit")
	now := testLibraryNow()
	if _, ok, err := database.ClaimUploadContent(ctx, intent.ID, ".staging/"+intent.ID+".part", now); err != nil || !ok {
		t.Fatalf("claim = %v, %v", ok, err)
	}
	bookID := strings.Repeat("a", 32)
	taskID := strings.Repeat("b", 32)
	sha := strings.Repeat("c", 64)
	err := database.PrepareUploadBook(ctx, PrepareUploadBookParams{
		UploadID:         intent.ID,
		BookID:           bookID,
		TaskID:           taskID,
		DisplayTitle:     "准备中",
		Format:           "epub",
		MediaType:        "application/epub+zip",
		OriginalFileName: "book.epub",
		Extension:        "epub",
		SHA256:           sha,
		ByteSize:         4,
		StorageRelPath:   bookID + "/" + sha + ".epub",
		AuthorsJSON:      `[]`,
		Status:           "indexing",
		ExtractionStatus: "pending",
		CreateTask:       true,
		Now:              now,
	})
	if err != nil {
		t.Fatalf("PrepareUploadBook() error = %v", err)
	}
	prepared, err := database.GetUploadIntent(ctx, intent.ID)
	if err != nil || prepared.CommitPhase != "prepared" || prepared.BookID == nil || *prepared.BookID != bookID {
		t.Fatalf("prepared intent = %+v, %v", prepared, err)
	}
	// 任务在第二次事务才 queued，prepare 阶段 worker 不可见。
	if _, err := database.GetTask(ctx, taskID); err == nil {
		t.Fatal("prepare 阶段不应存在可领取任务")
	}
	detail, err := database.GetBookDetail(ctx, bookID)
	if err != nil || detail.Status != "indexing" {
		t.Fatalf("book = %+v, %v", detail, err)
	}

	if err := database.MarkUploadRenamed(ctx, intent.ID, now); err != nil {
		t.Fatalf("MarkUploadRenamed() error = %v", err)
	}
	if err := database.CommitUpload(ctx, intent.ID, now); err != nil {
		t.Fatalf("CommitUpload() error = %v", err)
	}
	committed, err := database.GetUploadIntent(ctx, intent.ID)
	if err != nil || committed.State != "stored" || committed.CommitPhase != "committed" {
		t.Fatalf("committed intent = %+v, %v", committed, err)
	}
	if committed.BytesReceived != 4 || committed.ByteSize == nil || *committed.ByteSize != 4 {
		t.Fatalf("committed 大小 = %+v", committed)
	}
	task, err := database.GetTask(ctx, taskID)
	if err != nil || task.State != "queued" {
		t.Fatalf("commit 后 queued task = %+v, %v", task, err)
	}

	// 新意图验证 AbortPreparedUpload 会删除未索引书籍与任务。
	second := createLibraryIntentWithID(t, database, "client-abort", strings.Repeat("3", 32))
	if _, ok, err := database.ClaimUploadContent(ctx, second.ID, ".staging/"+second.ID+".part", now); err != nil || !ok {
		t.Fatalf("second claim = %v, %v", ok, err)
	}
	abortBookID := strings.Repeat("d", 32)
	abortTaskID := strings.Repeat("e", 32)
	abortSHA := strings.Repeat("f", 64)
	if err := database.PrepareUploadBook(ctx, PrepareUploadBookParams{
		UploadID:         second.ID,
		BookID:           abortBookID,
		TaskID:           abortTaskID,
		DisplayTitle:     "待放弃",
		Format:           "epub",
		MediaType:        "application/epub+zip",
		OriginalFileName: "abort.epub",
		Extension:        "epub",
		SHA256:           abortSHA,
		ByteSize:         4,
		StorageRelPath:   abortBookID + "/" + abortSHA + ".epub",
		AuthorsJSON:      `[]`,
		Status:           "indexing",
		ExtractionStatus: "pending",
		CreateTask:       true,
		Now:              now,
	}); err != nil {
		t.Fatalf("second PrepareUploadBook() error = %v", err)
	}
	if err := database.AbortPreparedUpload(ctx, second.ID, "upload_interrupted", "恢复失败", now); err != nil {
		t.Fatalf("AbortPreparedUpload() error = %v", err)
	}
	aborted, err := database.GetUploadIntent(ctx, second.ID)
	if err != nil || aborted.State != "failed" || aborted.BookID != nil || aborted.CommitPhase != "none" {
		t.Fatalf("aborted intent = %+v, %v", aborted, err)
	}
	if _, err := database.GetBookDetail(ctx, abortBookID); !errors.Is(err, ErrBookNotFound) {
		t.Fatalf("abort 后书籍应不存在，error = %v", err)
	}
	if count := countRows(t, database.db, "background_tasks"); count != 1 {
		t.Fatalf("任务数量 = %d，期望只保留第一个任务", count)
	}
}

func createLibraryIntentWithID(t *testing.T, database *Store, clientID, id string) UploadIntent {
	t.Helper()
	now := testLibraryNow()
	intent, created, err := database.CreateUploadIntent(context.Background(), CreateUploadIntentParams{
		ID:             id,
		ClientUploadID: clientID,
		FileName:       "book.epub",
		ExpectedSize:   4,
		ExpiresAt:      now.Add(24 * time.Hour),
		Now:            now,
	})
	if err != nil || !created {
		t.Fatalf("CreateUploadIntent() = %+v, %v, %v", intent, created, err)
	}
	return intent
}
