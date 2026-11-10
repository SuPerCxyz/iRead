package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"iread/server/internal/formats"
	"iread/server/internal/jobs"
	"iread/server/internal/library"
)

// newRealIndexingTestEnv 构造真实格式校验 + 可控后台 worker 的 Server，
// 用于验证“真实 PDF 上传 → book.index succeeded → ready → manifest”链路。
// 返回的 startWorker 只启动一次，便于在真实索引开始前观察 indexing 状态。
func newRealIndexingTestEnv(t *testing.T) (*testEnv, func()) {
	t.Helper()
	env := newTestEnv(t)
	booksDir := filepath.Join(env.root, "books")
	cacheDir := filepath.Join(env.root, "cache")
	service, err := library.NewService(library.Config{
		Store:    env.store,
		BooksDir: booksDir,
		CacheDir: cacheDir,
		Validator: validatorFunc(func(ctx context.Context, tempPath, ext string) (formats.Result, error) {
			return formats.Validate(ctx, tempPath, ext)
		}),
	})
	if err != nil {
		t.Fatalf("library.NewService() error = %v", err)
	}
	manager, err := jobs.NewManager(jobs.Options{
		Store:    env.store,
		BooksDir: booksDir,
		CacheDir: cacheDir,
		Workers:  1,
		Poll:     10 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("jobs.NewManager() error = %v", err)
	}
	startWorker := func() {
		if err := manager.Start(context.Background()); err != nil {
			t.Fatalf("jobs.Manager.Start() error = %v", err)
		}
	}
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.Stop(stopCtx)
	})
	server, err := New(Options{
		Store:        env.store,
		WebDir:       env.webDir,
		Version:      testVersion,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		StorageDirs:  env.dirs,
		PublicOrigin: env.publicOrigin,
		BooksDir:     booksDir,
		CacheDir:     cacheDir,
		Library:      service,
		Jobs:         manager,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })
	env.server = server
	env.handler = server.Handler()
	env.setupAdmin(t, testAdminPassword)
	return env, startWorker
}

// buildRealPDF 生成带经典 xref、3 页、标题/作者元数据的可解析 PDF。
func buildRealPDF(t *testing.T, title, author string, pages int) []byte {
	t.Helper()
	if pages < 1 {
		pages = 1
	}
	objects := make([]string, 0, pages+3)
	objects = append(objects, `<< /Type /Catalog /Pages 2 0 R >>`)
	kids := ""
	for page := 0; page < pages; page++ {
		if page > 0 {
			kids += " "
		}
		kids += fmt.Sprintf("%d 0 R", page+3)
	}
	objects = append(objects, fmt.Sprintf(`<< /Type /Pages /Kids [%s] /Count %d >>`, kids, pages))
	for page := 0; page < pages; page++ {
		objects = append(objects, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>`)
	}
	infoNumber := pages + 3
	info := "<<"
	if title != "" {
		info += " /Title (" + title + ")"
	}
	if author != "" {
		info += " /Author (" + author + ")"
	}
	info += " >>"
	objects = append(objects, info)

	buffer := []byte("%PDF-1.4\n")
	offsets := make([]int, len(objects)+1)
	for index, object := range objects {
		offsets[index+1] = len(buffer)
		buffer = append(buffer, []byte(fmt.Sprintf("%d 0 obj\n%s\nendobj\n", index+1, object))...)
	}
	xrefOffset := len(buffer)
	buffer = append(buffer, []byte(fmt.Sprintf("xref\n0 %d\n", len(objects)+1))...)
	buffer = append(buffer, []byte("0000000000 65535 f \n")...)
	for index := 1; index <= len(objects); index++ {
		buffer = append(buffer, []byte(fmt.Sprintf("%010d 00000 n \n", offsets[index]))...)
	}
	buffer = append(buffer, []byte(fmt.Sprintf(
		"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n",
		len(objects)+1, infoNumber, xrefOffset))...)
	return buffer
}

func waitIndexReady(t *testing.T, env *testEnv, taskID, bookID string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		taskRecorder := env.request(http.MethodGet, "/api/v1/tasks/"+taskID, "", "")
		if taskRecorder.Code == http.StatusOK {
			var taskEnvelope struct {
				Data struct {
					State string `json:"state"`
				} `json:"data"`
			}
			if err := json.Unmarshal(taskRecorder.Body.Bytes(), &taskEnvelope); err == nil &&
				taskEnvelope.Data.State == "succeeded" {
				detailRecorder := env.request(http.MethodGet, "/api/v1/books/"+bookID, "", "")
				if detailRecorder.Code != http.StatusOK {
					t.Fatalf("读取书籍详情 status = %d, body=%s",
						detailRecorder.Code, detailRecorder.Body.String())
				}
				var detailEnvelope struct {
					Data map[string]any `json:"data"`
				}
				if err := json.Unmarshal(detailRecorder.Body.Bytes(), &detailEnvelope); err != nil {
					t.Fatalf("解析书籍详情失败: %v", err)
				}
				return detailEnvelope.Data
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("book.index 任务未在超时内完成: taskId=%s", taskID)
	return nil
}

func TestPDFManifestAfterRealIndexReady(t *testing.T) {
	env, startWorker := newRealIndexingTestEnv(t)
	startWorker()
	pdfData := buildRealPDF(t, "真实 PDF 标题", "测试作者", 3)
	stored := env.uploadReaderFile(t, "real-index.pdf", pdfData)
	if stored.BookID == nil || stored.TaskID == nil {
		t.Fatalf("上传结果缺少 bookId/taskId: %+v", stored)
	}
	detail := waitIndexReady(t, env, *stored.TaskID, *stored.BookID)

	if detail["status"] != "ready" {
		t.Fatalf("book status = %v", detail["status"])
	}
	metadata, _ := detail["metadata"].(map[string]any)
	if metadata == nil || metadata["extractionStatus"] != "ok" {
		t.Fatalf("book metadata = %+v", detail["metadata"])
	}
	pageCount, ok := metadata["pageCount"].(float64)
	if !ok || int64(pageCount) != 3 {
		t.Fatalf("book pageCount = %v", metadata["pageCount"])
	}
	fileVersion, _ := detail["fileVersion"].(string)
	if len(fileVersion) != 64 {
		t.Fatalf("fileVersion = %q", fileVersion)
	}

	manifestRecorder := env.request(http.MethodGet,
		"/api/v1/books/"+*stored.BookID+"/manifest", "", "")
	if manifestRecorder.Code != http.StatusOK {
		t.Fatalf("ready PDF manifest status = %d, body=%s",
			manifestRecorder.Code, manifestRecorder.Body.String())
	}
	manifest := decodeData[pdfManifest](t, manifestRecorder)
	if manifest.Format != "pdf" || manifest.BookID != *stored.BookID ||
		manifest.FileVersion != fileVersion {
		t.Fatalf("PDF manifest 身份字段 = %+v", manifest)
	}
	if !manifest.ReadingCapabilities.CanRead ||
		manifest.ReadingCapabilities.UnavailableReason != "" {
		t.Fatalf("ready PDF canRead = %+v", manifest.ReadingCapabilities)
	}
	wantHref := "/api/v1/books/" + *stored.BookID + "/versions/" + fileVersion + "/content"
	if manifest.FormatData.ContentHref != wantHref ||
		manifest.FormatData.PageCount != 3 ||
		manifest.FormatData.ByteSize != int64(len(pdfData)) ||
		manifest.FormatData.ETag != `"`+fileVersion+`"` {
		t.Fatalf("PDF formatData = %+v", manifest.FormatData)
	}
}

func TestPDFManifestStateMatrix(t *testing.T) {
	env, startWorker := newRealIndexingTestEnv(t)
	pdfData := buildRealPDF(t, "状态矩阵", "测试作者", 2)
	stored := env.uploadReaderFile(t, "state-matrix.pdf", pdfData)
	if stored.BookID == nil || stored.TaskID == nil {
		t.Fatalf("上传结果缺少 bookId/taskId: %+v", stored)
	}
	bookID := *stored.BookID
	manifestURL := "/api/v1/books/" + bookID + "/manifest"

	// 索引中统一返回 200 + canRead=false/not_ready，让 UI 显示“正在整理”并等待，
	// 不把尚在索引的 PDF 当作坏文件（409）。
	early := env.request(http.MethodGet, manifestURL, "", "")
	if early.Code != http.StatusOK {
		t.Fatalf("indexing manifest status = %d, body=%s", early.Code, early.Body.String())
	}
	earlyManifest := decodeData[pdfManifest](t, early)
	if earlyManifest.ReadingCapabilities.CanRead ||
		earlyManifest.ReadingCapabilities.UnavailableReason != "not_ready" {
		t.Fatalf("indexing manifest capabilities = %+v", earlyManifest.ReadingCapabilities)
	}

	startWorker()
	waitIndexReady(t, env, *stored.TaskID, bookID)

	ready := env.request(http.MethodGet, manifestURL, "", "")
	if ready.Code != http.StatusOK {
		t.Fatalf("ready manifest status = %d, body=%s", ready.Code, ready.Body.String())
	}
	readyManifest := decodeData[pdfManifest](t, ready)
	if !readyManifest.ReadingCapabilities.CanRead ||
		readyManifest.ReadingCapabilities.UnavailableReason != "" {
		t.Fatalf("ready capabilities = %+v", readyManifest.ReadingCapabilities)
	}

	env.setPDFBookState(t, bookID, "unsupported", "unsupported", 0)
	encrypted := env.request(http.MethodGet, manifestURL, "", "")
	assertPDFUnreadable(t, encrypted, "pdf_encrypted")

	env.setPDFBookState(t, bookID, "error", "failed", 0)
	failed := env.request(http.MethodGet, manifestURL, "", "")
	assertPDFUnreadable(t, failed, "index_failed")
}

// assertPDFUnreadable 断言永久不可读的 PDF 返回 409 book_not_readable，
// 并用稳定 reason 区分加密与索引失败。
func assertPDFUnreadable(t *testing.T, recorder *httptest.ResponseRecorder, wantReason string) {
	t.Helper()
	if recorder.Code != http.StatusConflict {
		t.Fatalf("unreadable manifest status = %d, body=%s",
			recorder.Code, recorder.Body.String())
	}
	envelope := decodeAPIError(t, recorder)
	if envelope.Error.Code != "book_not_readable" {
		t.Fatalf("unreadable manifest code = %q", envelope.Error.Code)
	}
	if got := errorDetails(t, recorder.Body.Bytes())["reason"]; got != wantReason {
		t.Fatalf("unreadable manifest reason = %v, want %q", got, wantReason)
	}
}
