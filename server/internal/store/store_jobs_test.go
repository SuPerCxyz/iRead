package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func newJobsStore(t *testing.T) *Store {
	t.Helper()
	database, err := Open(context.Background(), t.TempDir()+"/iread.db")
	if err != nil {
		t.Fatalf("打开数据库: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func insertJobsBook(t *testing.T, database *Store, title string) string {
	t.Helper()
	bookID, err := newStoreID()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := database.db.Exec(`
		INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
		VALUES (?, ?, 'epub', 'indexing', 0, ?, ?)`, bookID, title, now, now); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(bookID))
	if _, err := database.db.Exec(`
		INSERT INTO book_files (
			book_id, original_file_name, extension, media_type, sha256, byte_size,
			storage_rel_path, created_at
		) VALUES (?, ?, 'epub', 'application/epub+zip', ?, 10, ?, ?)`,
		bookID, title+".epub", hex.EncodeToString(digest[:]), bookID+"/file.epub", now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.db.Exec(`
		INSERT INTO book_metadata (book_id, extraction_status, updated_at)
		VALUES (?, 'pending', ?)`, bookID, now); err != nil {
		t.Fatal(err)
	}
	return bookID
}

func bookStatus(t *testing.T, database *Store, bookID string) (string, int64) {
	t.Helper()
	var status string
	var indexVersion int64
	if err := database.db.QueryRow(`SELECT status, index_version FROM books WHERE id = ?`, bookID).
		Scan(&status, &indexVersion); err != nil {
		t.Fatal(err)
	}
	return status, indexVersion
}

func TestTaskRevisionTransitionsRetryAndFinalize(t *testing.T) {
	ctx := context.Background()
	database := newJobsStore(t)
	bookID := insertJobsBook(t, database, "Book")

	task, err := database.CreateBookIndexTask(ctx, bookID)
	if err != nil {
		t.Fatal(err)
	}
	if task.State != TaskStateQueued || task.Attempt != 1 || task.Revision != 1 ||
		task.ProgressPhase != "queued" || task.CancellationRequested {
		t.Fatalf("新任务 = %+v", task)
	}
	if status, _ := bookStatus(t, database, bookID); status != "indexing" {
		t.Fatalf("排任务后书籍状态 = %s", status)
	}

	claimed, ok, err := database.ClaimNextTask(ctx, time.Minute)
	if err != nil || !ok {
		t.Fatalf("ClaimNextTask ok=%v err=%v", ok, err)
	}
	if claimed.ID != task.ID || claimed.State != TaskStateRunning || claimed.Revision != 2 ||
		claimed.ProgressPhase != "metadata" || claimed.StartedAt == nil || claimed.LeaseUntil == nil {
		t.Fatalf("领取后的任务 = %+v", claimed)
	}

	if err := database.UpdateTaskProgress(ctx, task.ID, "toc", 1, nil); err != nil {
		t.Fatal(err)
	}
	progressed, err := database.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if progressed.Revision != 2 || progressed.ProgressPhase != "toc" || progressed.ProgressCompleted != 1 {
		t.Fatalf("纯进度更新不应改 revision: %+v", progressed)
	}

	cancelledRequest, accepted, err := database.CancelTask(ctx, task.ID, 2)
	if err != nil || !accepted {
		t.Fatalf("取消运行任务 accepted=%v err=%v", accepted, err)
	}
	if cancelledRequest.State != TaskStateRunning || !cancelledRequest.CancellationRequested ||
		cancelledRequest.Revision != 3 {
		t.Fatalf("取消请求后的任务 = %+v", cancelledRequest)
	}
	if _, err := database.FinalizeBookIndexTask(ctx, task.ID, BookIndexData{
		Title: stringPointer("Should Not Commit"), ExtractionStatus: "ok",
	}); !errors.Is(err, ErrTaskCancelled) {
		t.Fatalf("取消后 finalize error = %v，期望 ErrTaskCancelled", err)
	}
	if status, version := bookStatus(t, database, bookID); status != "indexing" || version != 0 {
		t.Fatalf("取消请求后书籍不应 ready: %s/%d", status, version)
	}

	if err := database.FinishCancelledTask(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	cancelledTask, err := database.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cancelledTask.State != TaskStateCancelled || cancelledTask.Revision != 4 ||
		cancelledTask.ErrorCode == nil || *cancelledTask.ErrorCode != TaskErrorIndexCancelled ||
		!cancelledTask.ErrorRetryable {
		t.Fatalf("取消终态 = %+v", cancelledTask)
	}
	if status, version := bookStatus(t, database, bookID); status != "error" || version != 0 {
		t.Fatalf("取消后书籍 = %s/%d", status, version)
	}

	retried, err := database.RetryTask(ctx, task.ID, 4)
	if err != nil {
		t.Fatal(err)
	}
	if retried.State != TaskStateQueued || retried.Attempt != 2 || retried.Revision != 5 ||
		retried.ErrorCode != nil || retried.CancellationRequested || retried.ProgressPhase != "queued" {
		t.Fatalf("retry 后任务 = %+v", retried)
	}
	if status, _ := bookStatus(t, database, bookID); status != "indexing" {
		t.Fatalf("retry 后书籍状态 = %s", status)
	}
	var stale *TaskRevisionConflictError
	if _, err := database.RetryTask(ctx, task.ID, 4); !errors.As(err, &stale) {
		t.Fatalf("stale retry error = %v", err)
	}

	claimedAgain, ok, err := database.ClaimNextTask(ctx, time.Minute)
	if err != nil || !ok || claimedAgain.Revision != 6 {
		t.Fatalf("第二次领取 = %+v ok=%v err=%v", claimedAgain, ok, err)
	}
	title := "Indexed"
	version, err := database.FinalizeBookIndexTask(ctx, task.ID, BookIndexData{
		Title:            &title,
		Authors:          []string{"Alice"},
		TOC:              []BookTOCEntry{{Title: "Chapter", Href: "ch1.xhtml", Level: 1}},
		CoverGenerated:   true,
		ExtractionStatus: "ok",
	})
	if err != nil {
		t.Fatal(err)
	}
	if version != 1 {
		t.Fatalf("finalize version = %d", version)
	}
	succeeded, err := database.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if succeeded.State != TaskStateSucceeded || succeeded.Revision != 7 ||
		succeeded.ProgressPhase != "finalize" || succeeded.ErrorCode != nil {
		t.Fatalf("成功任务 = %+v", succeeded)
	}
	status, indexVersion := bookStatus(t, database, bookID)
	if status != "ready" || indexVersion != 1 {
		t.Fatalf("成功后书籍 = %s/%d", status, indexVersion)
	}
	var coverID, extraction, authorsJSON, tocJSON string
	if err := database.db.QueryRow(`
		SELECT cover_resource_id, extraction_status, authors_json, toc_json
		FROM book_metadata WHERE book_id = ?`, bookID).Scan(&coverID, &extraction, &authorsJSON, &tocJSON); err != nil {
		t.Fatal(err)
	}
	if coverID != "cover:1" || extraction != "ok" || authorsJSON != `["Alice"]` ||
		tocJSON != `[{"title":"Chapter","href":"ch1.xhtml","level":1}]` {
		t.Fatalf("元数据 = %q %q %q %q", coverID, extraction, authorsJSON, tocJSON)
	}
	var stateConflict *TaskStateConflictError
	if _, _, err := database.CancelTask(ctx, task.ID, 7); !errors.As(err, &stateConflict) {
		t.Fatalf("成功任务取消 error = %v", err)
	}
}

func TestRetryCacheClearTaskWithoutBook(t *testing.T) {
	ctx := context.Background()
	database := newJobsStore(t)

	task, created, err := database.CreateCacheClearTask(ctx)
	if err != nil || !created {
		t.Fatalf("CreateCacheClearTask() created=%v err=%v", created, err)
	}
	claimed, ok, err := database.ClaimNextTask(ctx, time.Minute)
	if err != nil || !ok || claimed.ID != task.ID {
		t.Fatalf("ClaimNextTask() ok=%v err=%v task=%+v", ok, err, claimed)
	}
	if err := database.FailTask(ctx, task.ID, "cache_clear_failed", "部分缓存未能清理", true); err != nil {
		t.Fatal(err)
	}
	failed, err := database.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failed.State != TaskStateFailed || !failed.ErrorRetryable || failed.BookID != nil {
		t.Fatalf("失败缓存任务 = %+v", failed)
	}

	retried, err := database.RetryTask(ctx, task.ID, failed.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if retried.State != TaskStateQueued || retried.Attempt != 2 || retried.Revision != failed.Revision+1 ||
		retried.BookID != nil || retried.ErrorCode != nil || retried.CancellationRequested ||
		retried.StartedAt != nil || retried.FinishedAt != nil || retried.LeaseUntil != nil ||
		retried.ProgressPhase != "queued" {
		t.Fatalf("重试后的缓存任务 = %+v", retried)
	}
	var books int
	if err := database.db.QueryRow(`SELECT COUNT(*) FROM books`).Scan(&books); err != nil {
		t.Fatal(err)
	}
	if books != 0 {
		t.Fatalf("cache.clear 重试不应创建或修改书籍，books=%d", books)
	}

	claimedAgain, ok, err := database.ClaimNextTask(ctx, time.Minute)
	if err != nil || !ok || claimedAgain.ID != task.ID || claimedAgain.Revision != retried.Revision+1 ||
		claimedAgain.ProgressPhase != "queued" {
		t.Fatalf("第二次领取缓存任务 = %+v ok=%v err=%v", claimedAgain, ok, err)
	}
}

func TestRetryCancelledCacheClearTaskWithoutBook(t *testing.T) {
	ctx := context.Background()
	database := newJobsStore(t)

	task, _, err := database.CreateCacheClearTask(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := database.ClaimNextTask(ctx, time.Minute); err != nil || !ok {
		t.Fatalf("ClaimNextTask() ok=%v err=%v", ok, err)
	}
	if _, accepted, err := database.CancelTask(ctx, task.ID, 2); err != nil || !accepted {
		t.Fatalf("CancelTask() accepted=%v err=%v", accepted, err)
	}
	if err := database.FinishCancelledTask(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	cancelled, err := database.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.State != TaskStateCancelled || !cancelled.ErrorRetryable || cancelled.BookID != nil {
		t.Fatalf("取消的缓存任务 = %+v", cancelled)
	}

	retried, err := database.RetryTask(ctx, task.ID, cancelled.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if retried.State != TaskStateQueued || retried.Attempt != 2 || retried.Revision != cancelled.Revision+1 ||
		retried.BookID != nil || retried.ErrorCode != nil || retried.CancellationRequested {
		t.Fatalf("重试取消的缓存任务 = %+v", retried)
	}
}

func TestRunMaintenancePrunesStaleData(t *testing.T) {
	ctx := context.Background()
	database := newJobsStore(t)
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	database.now = func() time.Time { return now }

	firstBook := insertJobsBook(t, database, "Maintenance One")
	secondBook := insertJobsBook(t, database, "Maintenance Two")

	insertMutation := func(bookID, mutationID string, createdAt time.Time) {
		t.Helper()
		if _, err := database.db.Exec(`
			INSERT INTO progress_mutations (
				book_id, client_mutation_id, request_hash, revision, response_json, created_at
			) VALUES (?, ?, ?, 1, '{}', ?)`,
			bookID, mutationID, strings.Repeat("0", 64), formatStoreTime(createdAt)); err != nil {
			t.Fatal(err)
		}
	}
	insertMutation(firstBook, "old-one", now.Add(-31*24*time.Hour))
	insertMutation(firstBook, "recent-one", now.Add(-time.Hour))
	insertMutation(secondBook, "old-two", now.Add(-40*24*time.Hour))

	insertTask := func(id, kind string, bookID *string, state string, createdAt time.Time, finishedAt *time.Time) {
		t.Helper()
		var finished any
		if finishedAt != nil {
			finished = formatStoreTime(*finishedAt)
		}
		if _, err := database.db.Exec(`
			INSERT INTO background_tasks (
				id, kind, book_id, state, attempt, revision, progress_phase,
				created_at, updated_at, finished_at
			) VALUES (?, ?, ?, ?, 1, 1, 'done', ?, ?, ?)`,
			id, kind, bookID, state, formatStoreTime(createdAt), formatStoreTime(createdAt), finished); err != nil {
			t.Fatal(err)
		}
	}
	finished := func(offset time.Duration) *time.Time {
		value := now.Add(-offset)
		return &value
	}
	taskID := func(n int) string { return fmt.Sprintf("%032x", n) }
	insertTask(taskID(1), TaskKindBookIndex, &firstBook, TaskStateFailed,
		now.Add(-41*24*time.Hour), finished(40*24*time.Hour))
	insertTask(taskID(2), TaskKindBookIndex, &firstBook, TaskStateSucceeded,
		now.Add(-2*24*time.Hour), finished(24*time.Hour))
	insertTask(taskID(3), TaskKindBookIndex, &secondBook, TaskStateSucceeded,
		now.Add(-41*24*time.Hour), finished(40*24*time.Hour))
	insertTask(taskID(4), TaskKindCacheClear, nil, TaskStateFailed,
		now.Add(-41*24*time.Hour), finished(40*24*time.Hour))
	insertTask(taskID(5), TaskKindCacheClear, nil, TaskStateSucceeded,
		now.Add(-51*24*time.Hour), finished(50*24*time.Hour))
	insertTask(taskID(6), TaskKindBookIndex, &secondBook, TaskStateQueued,
		now.Add(-60*24*time.Hour), nil)

	insertIntent := func(id, state, commitPhase string, updatedAt, expiresAt time.Time) {
		t.Helper()
		if _, err := database.db.Exec(`
			INSERT INTO upload_intents (
				id, client_upload_id, file_name, expected_size, state, commit_phase,
				created_at, updated_at, expires_at
			) VALUES (?, ?, 'book.epub', 10, ?, ?, ?, ?, ?)`,
			id, "client-"+id, state, commitPhase,
			formatStoreTime(updatedAt), formatStoreTime(updatedAt), formatStoreTime(expiresAt)); err != nil {
			t.Fatal(err)
		}
	}
	insertIntent(taskID(11), "expired", "none", now.Add(-10*24*time.Hour), now.Add(-10*24*time.Hour))
	insertIntent(taskID(12), "failed", "none", now.Add(-10*24*time.Hour), now.Add(-10*24*time.Hour))
	insertIntent(taskID(13), "cancelled", "prepared", now.Add(-10*24*time.Hour), now.Add(-10*24*time.Hour))
	insertIntent(taskID(14), "expired", "none", now.Add(-5*24*time.Hour), now.Add(-5*24*time.Hour))
	insertIntent(taskID(15), "awaiting-upload", "none", now.Add(-10*24*time.Hour), now.Add(-10*24*time.Hour))
	insertIntent(taskID(16), "stored", "committed", now.Add(-10*24*time.Hour), now.Add(-10*24*time.Hour))

	result, err := database.RunMaintenance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.ProgressMutations != 2 || result.UploadIntents != 2 || result.TerminalTasks != 2 {
		t.Fatalf("清理结果 = %+v", result)
	}

	assertTaskExists := func(id string, want bool) {
		t.Helper()
		var count int
		if err := database.db.QueryRow(`SELECT COUNT(*) FROM background_tasks WHERE id = ?`, id).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if (count == 1) != want {
			t.Fatalf("任务 %s 存在=%v，期望 %v", id, count == 1, want)
		}
	}
	assertTaskExists(taskID(1), false)
	assertTaskExists(taskID(2), true)
	assertTaskExists(taskID(3), true)
	assertTaskExists(taskID(4), true)
	assertTaskExists(taskID(5), false)
	assertTaskExists(taskID(6), true)

	assertIntentExists := func(id string, want bool) {
		t.Helper()
		var count int
		if err := database.db.QueryRow(`SELECT COUNT(*) FROM upload_intents WHERE id = ?`, id).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if (count == 1) != want {
			t.Fatalf("上传意图 %s 存在=%v，期望 %v", id, count == 1, want)
		}
	}
	assertIntentExists(taskID(11), false)
	assertIntentExists(taskID(12), false)
	assertIntentExists(taskID(13), true)
	assertIntentExists(taskID(14), true)
	assertIntentExists(taskID(15), true)
	assertIntentExists(taskID(16), true)

	var oldMutations int
	if err := database.db.QueryRow(`SELECT COUNT(*) FROM progress_mutations WHERE client_mutation_id LIKE 'old-%'`).Scan(&oldMutations); err != nil {
		t.Fatal(err)
	}
	if oldMutations != 0 {
		t.Fatalf("旧进度幂等记录剩余 %d 条", oldMutations)
	}
}

func TestRecoverExpiredRunningTasks(t *testing.T) {
	ctx := context.Background()
	database := newJobsStore(t)
	bookID := insertJobsBook(t, database, "Recover")
	task, err := database.CreateBookIndexTask(ctx, bookID)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := database.ClaimNextTask(ctx, time.Millisecond); err != nil || !ok {
		t.Fatalf("claim ok=%v err=%v", ok, err)
	}
	time.Sleep(5 * time.Millisecond)
	count, err := database.RecoverExpiredTasks(ctx)
	if err != nil || count != 1 {
		t.Fatalf("recover count=%d err=%v", count, err)
	}
	recovered, err := database.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.State != TaskStateQueued || recovered.Revision != 3 || recovered.ProgressPhase != "queued" ||
		recovered.StartedAt != nil || recovered.LeaseUntil != nil {
		t.Fatalf("恢复后的任务 = %+v", recovered)
	}

	// 未过期租约不得被抢占。
	if _, ok, err := database.ClaimNextTask(ctx, time.Hour); err != nil || !ok {
		t.Fatalf("再次 claim ok=%v err=%v", ok, err)
	}
	count, err = database.RecoverExpiredTasks(ctx)
	if err != nil || count != 0 {
		t.Fatalf("未过期任务 recover count=%d err=%v", count, err)
	}
	running, err := database.GetTask(ctx, task.ID)
	if err != nil || running.State != TaskStateRunning {
		t.Fatalf("未过期任务状态 = %+v err=%v", running, err)
	}

	// 已请求取消的过期任务应直接落到 cancelled。
	past := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	if _, err := database.db.Exec(`
		UPDATE background_tasks SET cancellation_requested = 1, lease_until = ? WHERE id = ?`,
		past, task.ID); err != nil {
		t.Fatal(err)
	}
	count, err = database.RecoverExpiredTasks(ctx)
	if err != nil || count != 1 {
		t.Fatalf("取消恢复 count=%d err=%v", count, err)
	}
	cancelled, err := database.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.State != TaskStateCancelled || cancelled.ErrorCode == nil ||
		*cancelled.ErrorCode != TaskErrorIndexCancelled {
		t.Fatalf("取消恢复任务 = %+v", cancelled)
	}
	if status, _ := bookStatus(t, database, bookID); status != "error" {
		t.Fatalf("取消恢复后书籍 = %s", status)
	}
}

func TestCreateBookIndexTaskRejectsDuplicateActive(t *testing.T) {
	ctx := context.Background()
	database := newJobsStore(t)
	bookID := insertJobsBook(t, database, "Duplicate Active")
	if _, err := database.CreateBookIndexTask(ctx, bookID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateBookIndexTask(ctx, bookID); !errors.Is(err, ErrActiveTask) {
		t.Fatalf("重复活动任务 error = %v", err)
	}
}

func TestFailTaskDoesNotMarkBookReady(t *testing.T) {
	ctx := context.Background()
	database := newJobsStore(t)
	bookID := insertJobsBook(t, database, "Fail")
	task, err := database.CreateBookIndexTask(ctx, bookID)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := database.ClaimNextTask(ctx, time.Minute); err != nil || !ok {
		t.Fatalf("claim ok=%v err=%v", ok, err)
	}
	if err := database.FailTask(ctx, task.ID, "invalid_file", "图书容器损坏或无法解析", false); err != nil {
		t.Fatal(err)
	}
	failed, err := database.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failed.State != TaskStateFailed || failed.ErrorCode == nil || *failed.ErrorCode != "invalid_file" ||
		failed.ErrorRetryable || failed.Revision != 3 {
		t.Fatalf("失败任务 = %+v", failed)
	}
	if status, version := bookStatus(t, database, bookID); status != "error" || version != 0 {
		t.Fatalf("失败后书籍 = %s/%d", status, version)
	}
}

func stringPointer(value string) *string { return &value }

func TestClaimSkipsTaskWhoseUploadIsStillPreparing(t *testing.T) {
	ctx := context.Background()
	database := newJobsStore(t)
	firstBook := insertJobsBook(t, database, "Preparing")
	firstTask, err := database.CreateBookIndexTask(ctx, firstBook)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	uploadID, err := newStoreID()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.db.Exec(`
		INSERT INTO upload_intents (
			id, client_upload_id, file_name, expected_size, state, bytes_received,
			commit_phase, task_id, error_retryable, created_at, updated_at, expires_at
		) VALUES (?, ?, 'preparing.epub', 10, 'uploading', 10, 'prepared', ?, 0, ?, ?, ?)`,
		uploadID, "client-preparing", firstTask.ID, dbTime(now), dbTime(now), dbTime(now.Add(time.Hour))); err != nil {
		t.Fatal(err)
	}

	secondBook := insertJobsBook(t, database, "Ready")
	secondTask, err := database.CreateBookIndexTask(ctx, secondBook)
	if err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := database.ClaimNextTask(ctx, time.Minute)
	if err != nil || !ok {
		t.Fatalf("claim ok=%v err=%v", ok, err)
	}
	if claimed.ID != secondTask.ID {
		t.Fatalf("应跳过上传准备中的任务，得到 %s（期望 %s）", claimed.ID, secondTask.ID)
	}
	if _, err := database.db.Exec(`UPDATE upload_intents SET state = 'stored', commit_phase = 'committed' WHERE id = ?`, uploadID); err != nil {
		t.Fatal(err)
	}
	claimed, ok, err = database.ClaimNextTask(ctx, time.Minute)
	if err != nil || !ok || claimed.ID != firstTask.ID {
		t.Fatalf("提交后应可领取第一个任务: claimed=%+v ok=%v err=%v", claimed, ok, err)
	}
}
