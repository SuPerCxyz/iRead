package library

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"iread/server/internal/formats"
	"iread/server/internal/store"
)

type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) Advance(duration time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(duration)
}

type fakeValidator struct {
	mu     sync.Mutex
	result formats.Result
	err    error
	calls  int
}

func (f *fakeValidator) Validate(_ context.Context, _ string, ext string) (formats.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	result := f.result
	if result.Format == "" {
		result.Format = ext
		result.MediaType = mediaTypeForExtension(ext)
	}
	return result, f.err
}

func readableValidator() *fakeValidator {
	return &fakeValidator{result: formats.Result{
		Readable:  true,
		HasCover:  true,
		Title:     "示例图书",
		Authors:   []string{"示例作者"},
		PageCount: 3,
	}}
}

type testEnv struct {
	t        *testing.T
	root     string
	booksDir string
	dbPath   string
	clock    *testClock
	store    *store.Store
	service  *Service
}

func newTestEnv(t *testing.T, validator Validator) *testEnv {
	t.Helper()
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	dbDir := filepath.Join(root, "db")
	if err := os.MkdirAll(booksDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dbDir, 0o750); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(dbDir, "iread.db")
	database, err := store.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("打开测试数据库: %v", err)
	}
	clock := &testClock{now: time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)}
	service, err := NewService(Config{
		Store:     database,
		BooksDir:  booksDir,
		Now:       clock.Now,
		Validator: validator,
	})
	if err != nil {
		_ = database.Close()
		t.Fatalf("NewService() error = %v", err)
	}
	env := &testEnv{
		t:        t,
		root:     root,
		booksDir: booksDir,
		dbPath:   dbPath,
		clock:    clock,
		store:    database,
		service:  service,
	}
	t.Cleanup(func() { _ = env.store.Close() })
	return env
}

func (e *testEnv) restartService() {
	e.t.Helper()
	if err := e.store.Close(); err != nil {
		e.t.Fatal(err)
	}
	database, err := store.Open(context.Background(), e.dbPath)
	if err != nil {
		e.t.Fatalf("重开数据库: %v", err)
	}
	service, err := NewService(Config{
		Store:     database,
		BooksDir:  e.booksDir,
		Now:       e.clock.Now,
		Validator: readableValidator(),
	})
	if err != nil {
		_ = database.Close()
		e.t.Fatalf("重启 NewService() error = %v", err)
	}
	e.store = database
	e.service = service
}

func (e *testEnv) createIntent(fileName string, size int64) store.UploadIntent {
	e.t.Helper()
	clientID, err := newID()
	if err != nil {
		e.t.Fatal(err)
	}
	intent, created, apiErr := e.service.CreateUploadIntent(context.Background(), "client-"+clientID, fileName, size)
	if apiErr != nil {
		e.t.Fatalf("CreateUploadIntent() error = %+v", apiErr)
	}
	if !created {
		e.t.Fatal("首次创建上传意图应返回 created=true")
	}
	return intent
}

func (e *testEnv) upload(fileName string, data []byte) store.UploadIntent {
	e.t.Helper()
	intent := e.createIntent(fileName, int64(len(data)))
	updated, apiErr := e.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: int64(len(data)),
		ContentType:   "application/octet-stream",
		Body:          bytes.NewReader(data),
	})
	if apiErr != nil {
		e.t.Fatalf("UploadContent() error = %+v", apiErr)
	}
	return updated
}

func (e *testEnv) stagingPartFiles() []string {
	e.t.Helper()
	entries, err := os.ReadDir(e.service.stagingDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		e.t.Fatal(err)
	}
	files := make([]string, 0)
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".part") {
			files = append(files, entry.Name())
		}
	}
	return files
}

func (e *testEnv) bookCount() int64 {
	e.t.Helper()
	result, err := e.store.ListBooks(context.Background(), store.BookListQuery{Sort: "recent-added", Limit: 100})
	if err != nil {
		e.t.Fatal(err)
	}
	return result.Total
}

func TestCreateUploadIntentIdempotentAndValidation(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	ctx := context.Background()

	first, created, apiErr := env.service.CreateUploadIntent(ctx, "client-1", "book.epub", 100)
	if apiErr != nil || !created {
		t.Fatalf("首次创建 = %+v, %+v", created, apiErr)
	}
	second, created, apiErr := env.service.CreateUploadIntent(ctx, "client-1", "book.epub", 100)
	if apiErr != nil || created || second.ID != first.ID {
		t.Fatalf("幂等创建 = %+v, created=%v, err=%+v", second, created, apiErr)
	}
	if _, _, apiErr := env.service.CreateUploadIntent(ctx, "client-1", "other.epub", 100); apiErr == nil || apiErr.Status != 409 || apiErr.Code != "state_conflict" {
		t.Fatalf("元信息冲突 = %+v", apiErr)
	}
	if _, _, apiErr := env.service.CreateUploadIntent(ctx, "client-1", "book.epub", 101); apiErr == nil || apiErr.Status != 409 {
		t.Fatalf("大小冲突 = %+v", apiErr)
	}
	if _, _, apiErr := env.service.CreateUploadIntent(ctx, "client-2", "book.txt", 10); apiErr == nil || apiErr.Status != 415 || apiErr.Reason != "extension_not_allowed" {
		t.Fatalf("扩展名拒绝 = %+v", apiErr)
	}
	if _, _, apiErr := env.service.CreateUploadIntent(ctx, "client-3", "book.pdf", MaxFileSize+1); apiErr == nil || apiErr.Status != 413 {
		t.Fatalf("超限拒绝 = %+v", apiErr)
	}
	if _, _, apiErr := env.service.CreateUploadIntent(ctx, "client-4", "book.pdf", 0); apiErr == nil || apiErr.Status != 400 {
		t.Fatalf("零大小拒绝 = %+v", apiErr)
	}
}

func TestUploadStoredWithPrivateFileAndIndexTask(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	data := []byte("epub-original-bytes")
	intent := env.upload("book.epub", data)

	if intent.State != StateStored || intent.CommitPhase != PhaseCommitted {
		t.Fatalf("intent = %+v", intent)
	}
	if intent.BookID == nil || intent.TaskID == nil || intent.ByteSize == nil || *intent.ByteSize != int64(len(data)) {
		t.Fatalf("关联字段 = %+v", intent)
	}
	detail, err := env.store.GetBookDetail(context.Background(), *intent.BookID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Status != "indexing" {
		t.Fatalf("book status = %q，期望 indexing", detail.Status)
	}
	if detail.File.SHA256 == "" || detail.File.ByteSize != int64(len(data)) || detail.File.Extension != "epub" {
		t.Fatalf("原件登记 = %+v", detail.File)
	}
	if detail.IndexTaskID == nil || *detail.IndexTaskID != *intent.TaskID {
		t.Fatalf("indexTaskId = %v, want %s", detail.IndexTaskID, *intent.TaskID)
	}
	task, err := env.store.GetTask(context.Background(), *intent.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.State != "queued" || task.Kind != "book.index" || task.BookID == nil || *task.BookID != *intent.BookID {
		t.Fatalf("task = %+v", task)
	}
	finalPath := filepath.Join(env.booksDir, *intent.BookID, detail.File.SHA256+".epub")
	info, err := os.Stat(finalPath)
	if err != nil {
		t.Fatalf("最终原件不存在: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("原件权限 = %o，期望 600", info.Mode().Perm())
	}
	if stagingInfo, err := os.Stat(env.service.stagingDir); err != nil || stagingInfo.Mode().Perm() != 0o700 {
		t.Fatalf("staging 目录权限 = %v, %v", stagingInfo, err)
	}
	if bookDirInfo, err := os.Stat(filepath.Join(env.booksDir, *intent.BookID)); err != nil || bookDirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("书籍目录权限 = %v, %v", bookDirInfo, err)
	}
	stored, err := os.ReadFile(finalPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, data) {
		t.Fatal("原件字节被修改")
	}
	if parts := env.stagingPartFiles(); len(parts) != 0 {
		t.Fatalf("staging 残留 = %v", parts)
	}
}

func TestDuplicateUploadUsesExistingBookWithoutTask(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	data := []byte("same-content")
	first := env.upload("first.epub", data)

	intent := env.createIntent("second.epub", int64(len(data)))
	duplicate, apiErr := env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: int64(len(data)),
		ContentType:   "application/octet-stream",
		Body:          bytes.NewReader(data),
	})
	if apiErr != nil {
		t.Fatalf("重复上传 error = %+v", apiErr)
	}
	if duplicate.State != StateDuplicate || duplicate.BookID == nil || duplicate.DuplicateOfBookID == nil {
		t.Fatalf("duplicate = %+v", duplicate)
	}
	if *duplicate.BookID != *first.BookID || *duplicate.DuplicateOfBookID != *first.BookID {
		t.Fatalf("重复关联 = %+v, first=%s", duplicate, *first.BookID)
	}
	if duplicate.TaskID != nil {
		t.Fatalf("重复上传不应创建任务: %v", *duplicate.TaskID)
	}
	if count := env.bookCount(); count != 1 {
		t.Fatalf("书籍数量 = %d，期望 1", count)
	}
	if parts := env.stagingPartFiles(); len(parts) != 0 {
		t.Fatalf("staging 残留 = %v", parts)
	}
}

func TestUploadTruncatedAndOversizeBodies(t *testing.T) {
	env := newTestEnv(t, readableValidator())

	truncated := env.createIntent("truncated.epub", 10)
	_, apiErr := env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      truncated.ID,
		ContentLength: 10,
		ContentType:   "application/octet-stream",
		Body:          strings.NewReader("12345"),
	})
	if apiErr == nil || apiErr.Status != 400 {
		t.Fatalf("截断上传 = %+v", apiErr)
	}
	failed, err := env.store.GetUploadIntent(context.Background(), truncated.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failed.State != StateFailed || failed.ErrorCode == nil || *failed.ErrorCode != "upload_interrupted" {
		t.Fatalf("截断后意图 = %+v", failed)
	}
	if count := env.bookCount(); count != 0 {
		t.Fatalf("截断不应建书，count=%d", count)
	}

	oversize := env.createIntent("oversize.epub", 4)
	_, apiErr = env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      oversize.ID,
		ContentLength: 4,
		ContentType:   "application/octet-stream",
		Body:          strings.NewReader("1234567890"),
	})
	if apiErr == nil || apiErr.Status != 413 {
		t.Fatalf("超限上传 = %+v", apiErr)
	}
	if count := env.bookCount(); count != 0 {
		t.Fatalf("超限不应建书，count=%d", count)
	}
	if parts := env.stagingPartFiles(); len(parts) != 0 {
		t.Fatalf("staging 残留 = %v", parts)
	}
}

type blockingReader struct {
	reader  io.Reader
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *blockingReader) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.started) })
	<-b.release
	return b.reader.Read(p)
}

func TestConcurrentPUTOnlyOneWins(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	intent := env.createIntent("concurrent.epub", 16)
	body := &blockingReader{
		reader:  strings.NewReader("concurrent-bytes"),
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	result := make(chan *Error, 1)
	go func() {
		_, apiErr := env.service.UploadContent(context.Background(), UploadContentInput{
			UploadID:      intent.ID,
			ContentLength: 16,
			ContentType:   "application/octet-stream",
			Body:          body,
		})
		result <- apiErr
	}()
	<-body.started

	_, secondErr := env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: 16,
		ContentType:   "application/octet-stream",
		Body:          strings.NewReader("concurrent-bytes"),
	})
	if secondErr == nil || secondErr.Status != 409 {
		t.Fatalf("并发第二次上传 = %+v", secondErr)
	}
	close(body.release)
	if firstErr := <-result; firstErr != nil {
		t.Fatalf("并发第一次上传 error = %+v", firstErr)
	}
	stored, err := env.store.GetUploadIntent(context.Background(), intent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != StateStored {
		t.Fatalf("最终状态 = %q，期望 stored", stored.State)
	}
}

func TestCancelUploadAndCompletedCancelConflict(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	intent := env.createIntent("cancel.epub", 4)

	cancelled, apiErr := env.service.CancelUpload(context.Background(), intent.ID)
	if apiErr != nil || cancelled.State != StateCancelled {
		t.Fatalf("取消 = %+v, %+v", cancelled, apiErr)
	}
	again, apiErr := env.service.CancelUpload(context.Background(), intent.ID)
	if apiErr != nil || again.State != StateCancelled {
		t.Fatalf("重复取消 = %+v, %+v", again, apiErr)
	}
	_, apiErr = env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: 4,
		ContentType:   "application/octet-stream",
		Body:          strings.NewReader("data"),
	})
	if apiErr == nil || apiErr.Status != 409 {
		t.Fatalf("取消后上传 = %+v", apiErr)
	}

	stored := env.upload("stored.epub", []byte("stored-bytes"))
	_, apiErr = env.service.CancelUpload(context.Background(), stored.ID)
	if apiErr == nil || apiErr.Status != 409 || apiErr.Code != "upload_completed" {
		t.Fatalf("已保存取消 = %+v", apiErr)
	}
	_, apiErr = env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      stored.ID,
		ContentLength: 12,
		ContentType:   "application/octet-stream",
		Body:          strings.NewReader("stored-bytes"),
	})
	if apiErr == nil || apiErr.Status != 409 || apiErr.Code != "upload_completed" {
		t.Fatalf("已保存再次写入 = %+v", apiErr)
	}
	detail, err := env.store.GetBookDetail(context.Background(), *stored.BookID)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(env.booksDir, *stored.BookID, detail.File.SHA256+".epub")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("取消已保存上传不应删除原件: %v", err)
	}
}

func TestCancelDuringUploadPreventsCommit(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	intent := env.createIntent("cancel-race.epub", 16)
	body := &blockingReader{
		reader:  strings.NewReader("cancel-race-data"),
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	result := make(chan *Error, 1)
	go func() {
		_, apiErr := env.service.UploadContent(context.Background(), UploadContentInput{
			UploadID:      intent.ID,
			ContentLength: 16,
			ContentType:   "application/octet-stream",
			Body:          body,
		})
		result <- apiErr
	}()
	<-body.started
	if _, apiErr := env.service.CancelUpload(context.Background(), intent.ID); apiErr != nil {
		t.Fatalf("上传中取消 error = %+v", apiErr)
	}
	close(body.release)
	if apiErr := <-result; apiErr == nil || apiErr.Status != 409 {
		t.Fatalf("取消后写入结果 = %+v", apiErr)
	}
	current, err := env.store.GetUploadIntent(context.Background(), intent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.State != StateCancelled {
		t.Fatalf("最终状态 = %q，期望 cancelled", current.State)
	}
	if count := env.bookCount(); count != 0 {
		t.Fatalf("取消不应建书，count=%d", count)
	}
	if parts := env.stagingPartFiles(); len(parts) != 0 {
		t.Fatalf("staging 残留 = %v", parts)
	}
}

func TestValidationRejectedLeavesNoBook(t *testing.T) {
	validator := &fakeValidator{err: &formats.ValidationError{Reason: formats.ReasonArchivePathTraversal}}
	env := newTestEnv(t, validator)
	intent := env.createIntent("evil.epub", 4)

	_, apiErr := env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: 4,
		ContentType:   "application/octet-stream",
		Body:          strings.NewReader("data"),
	})
	if apiErr == nil || apiErr.Status != 422 || apiErr.Code != "invalid_file" || apiErr.Reason != formats.ReasonArchivePathTraversal {
		t.Fatalf("校验拒绝 = %+v", apiErr)
	}
	failed, err := env.store.GetUploadIntent(context.Background(), intent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failed.State != StateFailed || failed.ErrorCode == nil || *failed.ErrorCode != "invalid_file" {
		t.Fatalf("失败意图 = %+v", failed)
	}
	if failed.ErrorReason == nil || *failed.ErrorReason != formats.ReasonArchivePathTraversal {
		t.Fatalf("ErrorReason = %v，期望 %q", failed.ErrorReason, formats.ReasonArchivePathTraversal)
	}
	if count := env.bookCount(); count != 0 {
		t.Fatalf("校验拒绝不应建书，count=%d", count)
	}
	if parts := env.stagingPartFiles(); len(parts) != 0 {
		t.Fatalf("staging 残留 = %v", parts)
	}
}

func TestUnsupportedSavedWithoutIndexTask(t *testing.T) {
	validator := &fakeValidator{result: formats.Result{
		Readable:          false,
		UnsupportedReason: formats.UnsupportedCBRDeferred,
	}}
	env := newTestEnv(t, validator)
	intent := env.upload("comic.cbr", []byte("rar4-bytes"))

	if intent.State != StateStored || intent.BookID == nil {
		t.Fatalf("intent = %+v", intent)
	}
	if intent.TaskID != nil {
		t.Fatalf("不可读格式不应排索引任务: %v", *intent.TaskID)
	}
	detail, err := env.store.GetBookDetail(context.Background(), *intent.BookID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Status != "unsupported" {
		t.Fatalf("book status = %q，期望 unsupported", detail.Status)
	}
	if detail.Metadata.ExtractionStatus != "unsupported" {
		t.Fatalf("extraction status = %q", detail.Metadata.ExtractionStatus)
	}
	if detail.IndexTaskID != nil {
		t.Fatalf("indexTaskId = %v，期望 null", *detail.IndexTaskID)
	}
	path := filepath.Join(env.booksDir, *intent.BookID, detail.File.SHA256+".cbr")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("原件应保留: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("原件权限 = %o", info.Mode().Perm())
	}
}

func TestFailedUploadCanRetryFromScratch(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	intent := env.createIntent("retry.epub", 4)

	_, apiErr := env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: 4,
		ContentType:   "application/octet-stream",
		Body:          strings.NewReader("ab"),
	})
	if apiErr == nil || apiErr.Status != 400 {
		t.Fatalf("第一次截断 = %+v", apiErr)
	}
	retried, apiErr := env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: 4,
		ContentType:   "application/octet-stream",
		Body:          strings.NewReader("data"),
	})
	if apiErr != nil || retried.State != StateStored {
		t.Fatalf("重试 = %+v, %+v", retried, apiErr)
	}
	if retried.BytesReceived != 4 {
		t.Fatalf("bytesReceived = %d", retried.BytesReceived)
	}
}

func TestExpiredIntentCannotUpload(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	intent := env.createIntent("expired.epub", 4)
	env.clock.Advance(DefaultIntentTTL + time.Minute)

	expired, apiErr := env.service.GetUpload(context.Background(), intent.ID)
	if apiErr != nil || expired.State != StateExpired {
		t.Fatalf("过期读取 = %+v, %+v", expired, apiErr)
	}
	_, apiErr = env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: 4,
		ContentType:   "application/octet-stream",
		Body:          strings.NewReader("data"),
	})
	if apiErr == nil || apiErr.Status != 409 {
		t.Fatalf("过期上传 = %+v", apiErr)
	}
	if parts := env.stagingPartFiles(); len(parts) != 0 {
		t.Fatalf("staging 残留 = %v", parts)
	}
}

func (e *testEnv) preparedUpload(fileName string, data []byte, rename bool) (store.UploadIntent, string) {
	e.t.Helper()
	ctx := context.Background()
	intent := e.createIntent(fileName, int64(len(data)))
	claimed, ok, err := e.store.ClaimUploadContent(ctx, intent.ID, e.service.stagingRelPath(intent.ID), e.clock.Now())
	if err != nil || !ok {
		e.t.Fatalf("ClaimUploadContent() = %v, %v", ok, err)
	}
	intent = claimed
	tempPath := e.service.stagingPath(intent.ID)
	if err := os.WriteFile(tempPath, data, 0o600); err != nil {
		e.t.Fatal(err)
	}
	digest := sha256Hex(data)
	bookID, err := newID()
	if err != nil {
		e.t.Fatal(err)
	}
	taskID, err := newID()
	if err != nil {
		e.t.Fatal(err)
	}
	finalRel := e.service.finalRelPath(bookID, digest, "epub")
	err = e.store.PrepareUploadBook(ctx, store.PrepareUploadBookParams{
		UploadID:         intent.ID,
		BookID:           bookID,
		TaskID:           taskID,
		DisplayTitle:     "恢复测试",
		Format:           "epub",
		MediaType:        formats.MediaTypeEPUB,
		OriginalFileName: fileName,
		Extension:        "epub",
		SHA256:           digest,
		ByteSize:         int64(len(data)),
		StorageRelPath:   finalRel,
		AuthorsJSON:      `["作者"]`,
		Status:           "indexing",
		ExtractionStatus: "pending",
		CreateTask:       true,
		Now:              e.clock.Now(),
	})
	if err != nil {
		e.t.Fatalf("PrepareUploadBook() error = %v", err)
	}
	if rename {
		bookDir := filepath.Join(e.booksDir, bookID)
		if err := os.MkdirAll(bookDir, 0o700); err != nil {
			e.t.Fatal(err)
		}
		finalPath := filepath.Join(e.booksDir, filepath.FromSlash(finalRel))
		if err := os.Rename(tempPath, finalPath); err != nil {
			e.t.Fatal(err)
		}
		if err := e.store.MarkUploadRenamed(ctx, intent.ID, e.clock.Now()); err != nil {
			e.t.Fatal(err)
		}
	}
	return intent, bookID
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestStartupRecoveryCompletesPreparedStaging(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	data := []byte("prepared-staging-bytes")
	intent, bookID := env.preparedUpload("recover.epub", data, false)

	env.restartService()
	recovered, err := env.store.GetUploadIntent(context.Background(), intent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.State != StateStored || recovered.CommitPhase != PhaseCommitted {
		t.Fatalf("恢复后意图 = %+v", recovered)
	}
	detail, err := env.store.GetBookDetail(context.Background(), bookID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Status != "indexing" {
		t.Fatalf("恢复后书籍状态 = %q，绝不直接 ready", detail.Status)
	}
	path := filepath.Join(env.booksDir, bookID, detail.File.SHA256+".epub")
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("恢复后原件 = %v, %v", info, err)
	}
	task, err := env.store.GetTask(context.Background(), *recovered.TaskID)
	if err != nil || task.State != "queued" {
		t.Fatalf("恢复后任务 = %+v, %v", task, err)
	}
}

func TestStartupRecoveryCompletesRenamedFinal(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	data := []byte("prepared-final-bytes")
	intent, bookID := env.preparedUpload("renamed.epub", data, true)

	env.restartService()
	recovered, err := env.store.GetUploadIntent(context.Background(), intent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.State != StateStored || recovered.CommitPhase != PhaseCommitted {
		t.Fatalf("恢复后意图 = %+v", recovered)
	}
	detail, err := env.store.GetBookDetail(context.Background(), bookID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Status != "indexing" {
		t.Fatalf("恢复后状态 = %q", detail.Status)
	}
}

func TestStartupRecoveryRejectsCorruptPreparedFile(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	intent, bookID := env.preparedUpload("corrupt.epub", []byte("original-data"), false)
	if err := os.WriteFile(env.service.stagingPath(intent.ID), []byte("tampered-data"), 0o600); err != nil {
		t.Fatal(err)
	}

	env.restartService()
	recovered, err := env.store.GetUploadIntent(context.Background(), intent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.State != StateFailed {
		t.Fatalf("损坏恢复后意图 = %+v", recovered)
	}
	if _, err := env.store.GetBookDetail(context.Background(), bookID); !errors.Is(err, store.ErrBookNotFound) {
		t.Fatalf("损坏恢复不应保留书籍，error = %v", err)
	}
	if count := env.bookCount(); count != 0 {
		t.Fatalf("损坏恢复不应留下书籍，count=%d", count)
	}
	if parts := env.stagingPartFiles(); len(parts) != 0 {
		t.Fatalf("staging 残留 = %v", parts)
	}
}

func TestStartupRecoveryFailsInterruptedUpload(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	intent := env.createIntent("interrupted.epub", 4)
	claimed, ok, err := env.store.ClaimUploadContent(context.Background(), intent.ID, env.service.stagingRelPath(intent.ID), env.clock.Now())
	if err != nil || !ok {
		t.Fatalf("claim = %v, %v", ok, err)
	}
	if err := os.WriteFile(env.service.stagingPath(intent.ID), []byte("ab"), 0o600); err != nil {
		t.Fatal(err)
	}

	env.restartService()
	recovered, err := env.store.GetUploadIntent(context.Background(), claimed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.State != StateFailed || recovered.ErrorCode == nil || *recovered.ErrorCode != "upload_interrupted" {
		t.Fatalf("中断恢复后意图 = %+v", recovered)
	}
	if parts := env.stagingPartFiles(); len(parts) != 0 {
		t.Fatalf("staging 残留 = %v", parts)
	}
}

func TestDuplicateContentTypeRejected(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	intent := env.createIntent("multipart.epub", 4)
	_, apiErr := env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: 4,
		ContentType:   "multipart/form-data; boundary=x",
		Body:          strings.NewReader("data"),
	})
	if apiErr == nil || apiErr.Status != 415 {
		t.Fatalf("multipart = %+v", apiErr)
	}
	current, err := env.store.GetUploadIntent(context.Background(), intent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.State != StateAwaiting {
		t.Fatalf("拒绝 multipart 不应改变意图状态: %q", current.State)
	}
}

type shortThenUnexpectedEOF struct {
	data []byte
	done bool
}

func (r *shortThenUnexpectedEOF) Read(p []byte) (int, error) {
	if r.done {
		return 0, io.ErrUnexpectedEOF
	}
	r.done = true
	return copy(p, r.data), nil
}

func TestTruncatedHTTPBodyMapsToInvalidRequest(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	intent := env.createIntent("short.epub", 10)
	_, apiErr := env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: 10,
		ContentType:   "application/octet-stream",
		Body:          &shortThenUnexpectedEOF{data: []byte("12345")},
	})
	if apiErr == nil || apiErr.Status != 400 || apiErr.Code != "invalid_request" {
		t.Fatalf("截断 HTTP body = %+v", apiErr)
	}
	failed, err := env.store.GetUploadIntent(context.Background(), intent.ID)
	if err != nil || failed.State != StateFailed {
		t.Fatalf("失败意图 = %+v, %v", failed, err)
	}
}

func TestDuplicateWaitsForPreparedSource(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	data := []byte("pending-duplicate-bytes")
	source, sourceBookID := env.preparedUpload("source.epub", data, true)

	intent := env.createIntent("copy.epub", int64(len(data)))
	_, apiErr := env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: int64(len(data)),
		ContentType:   "application/octet-stream",
		Body:          bytes.NewReader(data),
	})
	if apiErr == nil || apiErr.Status != 409 || apiErr.Code != "state_conflict" {
		t.Fatalf("源文件仍在 prepared 时重复上传 = %+v", apiErr)
	}
	waiting, err := env.store.GetUploadIntent(context.Background(), intent.ID)
	if err != nil || waiting.State != StateFailed {
		t.Fatalf("等待重试意图 = %+v, %v", waiting, err)
	}
	if err := env.store.CommitUpload(context.Background(), source.ID, env.clock.Now()); err != nil {
		t.Fatalf("CommitUpload(source) error = %v", err)
	}

	duplicate, apiErr := env.service.UploadContent(context.Background(), UploadContentInput{
		UploadID:      intent.ID,
		ContentLength: int64(len(data)),
		ContentType:   "application/octet-stream",
		Body:          bytes.NewReader(data),
	})
	if apiErr != nil || duplicate.State != StateDuplicate {
		t.Fatalf("源提交后重试 = %+v, %+v", duplicate, apiErr)
	}
	if duplicate.BookID == nil || *duplicate.BookID != sourceBookID || duplicate.TaskID != nil {
		t.Fatalf("重复关联 = %+v, source=%s", duplicate, sourceBookID)
	}
}
