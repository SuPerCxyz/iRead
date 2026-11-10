package jobs

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"iread/server/internal/store"
)

func TestSingleWorkerProcessesTasksFIFO(t *testing.T) {
	env := newJobsEnv(t)
	firstBook, firstTask := env.insertBook("epub", "First", buildEPUB(t, epubSampleOptions{nav: true, cover: true, nonce: 1}))
	secondBook, secondTask := env.insertBook("epub", "Second", buildEPUB(t, epubSampleOptions{nav: true, cover: true, nonce: 2}))
	env.startManager(env.manager(1))

	first := env.waitTask(firstTask, store.TaskStateSucceeded)
	second := env.waitTask(secondTask, store.TaskStateSucceeded)
	if first.StartedAt == nil || second.StartedAt == nil || first.FinishedAt == nil {
		t.Fatalf("缺少任务时间: first=%+v second=%+v", first, second)
	}
	if second.StartedAt.Before(*first.StartedAt) {
		t.Fatalf("任务未按 FIFO：first start=%v second start=%v", first.StartedAt, second.StartedAt)
	}
	if second.StartedAt.Before(*first.FinishedAt) {
		t.Fatalf("单 worker 不应并行：first finish=%v second start=%v", first.FinishedAt, second.StartedAt)
	}
	env.waitBookStatus(firstBook, "ready")
	env.waitBookStatus(secondBook, "ready")
}

func TestPanicIsIsolatedAndWorkerContinues(t *testing.T) {
	env := newJobsEnv(t)
	panicBook, panicTask := env.insertBook("epub", "Panic", buildEPUB(t, epubSampleOptions{nav: true, cover: true, nonce: 3}))
	manager := env.manager(1)
	var once sync.Once
	manager.phaseHook = func(phase string) {
		if phase == "toc" {
			once.Do(func() { panic("boom") })
		}
	}
	env.startManager(manager)

	task := env.waitTask(panicTask, store.TaskStateFailed)
	if task.ErrorCode == nil || *task.ErrorCode != ErrorCodeInternal || !task.ErrorRetryable {
		t.Fatalf("panic 任务 error = %+v", task)
	}
	env.waitBookStatus(panicBook, "error")

	goodBook, goodTask := env.insertBook("epub", "After Panic", buildEPUB(t, epubSampleOptions{nav: true, cover: true, nonce: 4}))
	manager.Notify()
	env.waitTask(goodTask, store.TaskStateSucceeded)
	env.waitBookStatus(goodBook, "ready")
}

func TestGracefulStopReleasesRunningTaskToQueued(t *testing.T) {
	env := newJobsEnv(t)
	bookID, taskID := env.insertBook("epub", "Shutdown", buildEPUB(t, epubSampleOptions{nav: true, cover: true, nonce: 5}))
	manager := env.manager(1)
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	manager.phaseHook = func(phase string) {
		if phase == "toc" {
			once.Do(func() {
				close(entered)
				<-release
			})
		}
	}
	if err := manager.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("任务未进入 toc 阶段")
	}

	stopErr := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		stopErr <- manager.Stop(ctx)
	}()
	close(release)
	if err := <-stopErr; err != nil {
		t.Fatalf("Stop: %v", err)
	}

	task := env.waitTask(taskID, store.TaskStateQueued)
	if task.State != store.TaskStateQueued {
		t.Fatalf("优雅退出后任务状态 = %s", task.State)
	}
	var status string
	if err := env.db.QueryRow(`SELECT status FROM books WHERE id = ?`, bookID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "indexing" {
		t.Fatalf("释放任务不应把书籍标成 %s", status)
	}
}

func TestRestartRecoversExpiredRunningTask(t *testing.T) {
	env := newJobsEnv(t)
	bookID, taskID := env.insertBook("epub", "Restart", buildEPUB(t, epubSampleOptions{nav: true, cover: true}))
	if _, ok, err := env.store.ClaimNextTask(context.Background(), time.Minute); err != nil || !ok {
		t.Fatalf("领取任务: ok=%v err=%v", ok, err)
	}
	if err := env.store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(context.Background(), env.root+"/db/iread.db")
	if err != nil {
		t.Fatalf("重开数据库: %v", err)
	}
	env.store = reopened
	past := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	if _, err := env.db.Exec(`UPDATE background_tasks SET lease_until = ? WHERE id = ?`, past, taskID); err != nil {
		t.Fatal(err)
	}

	manager, err := NewManager(Options{
		Store:       env.store,
		BooksDir:    env.books,
		CacheDir:    env.cache,
		Workers:     1,
		Lease:       2 * time.Second,
		Poll:        20 * time.Millisecond,
		TaskTimeout: 10 * time.Second,
		Logger:      testLogger(),
	})
	if err != nil {
		t.Fatal(err)
	}
	env.startManager(manager)
	task := env.waitTask(taskID, store.TaskStateSucceeded)
	if task.Attempt != 1 {
		t.Fatalf("重启恢复不应增加 attempt，得到 %d", task.Attempt)
	}
	env.waitBookStatus(bookID, "ready")
}

func TestManagerMaintenancePrunesOldProgressMutations(t *testing.T) {
	env := newJobsEnv(t)
	bookID := randomID(t)
	now := time.Now().UTC()
	stamp := func(value time.Time) string {
		return value.UTC().Format("2006-01-02T15:04:05.000000000Z07:00")
	}
	if _, err := env.db.Exec(`
		INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
		VALUES (?, 'Maintenance', 'epub', 'ready', 1, ?, ?)`,
		bookID, stamp(now), stamp(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO progress_mutations (
			book_id, client_mutation_id, request_hash, revision, response_json, created_at
		) VALUES (?, 'stale', ?, 1, '{}', ?)`,
		bookID, "stale", strings.Repeat("0", 64), stamp(now.Add(-31*24*time.Hour))); err != nil {
		t.Fatal(err)
	}

	env.manager(1).runMaintenance(context.Background())

	var remaining int
	if err := env.db.QueryRow(`SELECT COUNT(*) FROM progress_mutations WHERE book_id = ?`, bookID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("启动维护未清理旧进度幂等记录: %d", remaining)
	}
}

func TestWorkersFromEnvClampsToOne(t *testing.T) {
	t.Setenv("IREAD_INDEX_WORKERS", "")
	if got := WorkersFromEnv(); got != 1 {
		t.Fatalf("默认 worker = %d", got)
	}
	t.Setenv("IREAD_INDEX_WORKERS", "1")
	if got := WorkersFromEnv(); got != 1 {
		t.Fatalf("worker 1 = %d", got)
	}
	t.Setenv("IREAD_INDEX_WORKERS", "8")
	if got := WorkersFromEnv(); got != 1 {
		t.Fatalf("超过上限应回落到 1，得到 %d", got)
	}
	t.Setenv("IREAD_INDEX_WORKERS", "not-a-number")
	if got := WorkersFromEnv(); got != 1 {
		t.Fatalf("非法值应回落到 1，得到 %d", got)
	}
}

func TestRunningCancellationStopsBeforeFinalize(t *testing.T) {
	env := newJobsEnv(t)
	bookID, taskID := env.insertBook("epub", "Cancel Running", buildEPUB(t, epubSampleOptions{
		nav: true, cover: true, nonce: 21,
	}))
	manager := env.manager(1)
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	manager.phaseHook = func(phase string) {
		if phase == "toc" {
			once.Do(func() {
				close(entered)
				<-release
			})
		}
	}
	env.startManager(manager)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("任务未进入 toc 阶段")
	}
	if _, accepted, err := env.store.CancelTask(context.Background(), taskID, 2); err != nil || !accepted {
		t.Fatalf("取消运行任务 accepted=%v err=%v", accepted, err)
	}
	close(release)

	task := env.waitTask(taskID, store.TaskStateCancelled)
	if task.ErrorCode == nil || *task.ErrorCode != store.TaskErrorIndexCancelled || !task.ErrorRetryable {
		t.Fatalf("取消终态 = %+v", task)
	}
	env.waitBookStatus(bookID, "error")
	var indexVersion int64
	if err := env.db.QueryRow(`SELECT index_version FROM books WHERE id = ?`, bookID).Scan(&indexVersion); err != nil {
		t.Fatal(err)
	}
	if indexVersion != 0 {
		t.Fatalf("取消后 index_version = %d", indexVersion)
	}
	if _, err := os.Stat(env.cache + "/covers/" + bookID + "/1/grid.jpg"); !os.IsNotExist(err) {
		t.Fatalf("取消任务不应提交封面: %v", err)
	}
}
