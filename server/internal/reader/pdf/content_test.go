package pdf_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"iread/server/internal/reader/pdf"
	"iread/server/internal/store"
)

const (
	testBookID   = "0123456789abcdef0123456789abcdef"
	testUploadID = "fedcba9876543210fedcba9876543210"
)

type testEnv struct {
	handler     *pdf.Handler
	booksDir    string
	store       *store.Store
	bookID      string
	fileVersion string
	content     []byte
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	if err := os.MkdirAll(booksDir, 0o750); err != nil {
		t.Fatal(err)
	}

	content := makeTestPDF(200000)
	digest := sha256.Sum256(content)
	fileVersion := hex.EncodeToString(digest[:])
	bookDir := filepath.Join(booksDir, testBookID)
	if err := os.MkdirAll(bookDir, 0o700); err != nil {
		t.Fatal(err)
	}
	relPath := testBookID + "/" + fileVersion + ".pdf"
	if err := os.WriteFile(filepath.Join(booksDir, filepath.FromSlash(relPath)), content, 0o600); err != nil {
		t.Fatal(err)
	}

	database, err := store.Open(context.Background(), filepath.Join(root, "db", "iread.db"))
	if err != nil {
		t.Fatalf("打开测试数据库失败: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	now := time.Now().UTC()
	if _, created, err := database.CreateUploadIntent(context.Background(), store.CreateUploadIntentParams{
		ID:             testUploadID,
		ClientUploadID: "pdf-content-test",
		FileName:       "sample.pdf",
		ExpectedSize:   int64(len(content)),
		ExpiresAt:      now.Add(time.Hour),
		Now:            now,
	}); err != nil || !created {
		t.Fatalf("创建测试上传意图失败: created=%v err=%v", created, err)
	}
	if _, claimed, err := database.ClaimUploadContent(context.Background(), testUploadID,
		".staging/"+testUploadID+".part", now); err != nil || !claimed {
		t.Fatalf("占用测试上传意图失败: claimed=%v err=%v", claimed, err)
	}
	if err := database.PrepareUploadBook(context.Background(), store.PrepareUploadBookParams{
		UploadID:         testUploadID,
		BookID:           testBookID,
		DisplayTitle:     "PDF 测试书",
		Format:           "pdf",
		MediaType:        pdf.MediaType,
		OriginalFileName: "sample.pdf",
		Extension:        "pdf",
		SHA256:           fileVersion,
		ByteSize:         int64(len(content)),
		StorageRelPath:   relPath,
		AuthorsJSON:      "[]",
		Status:           "ready",
		ExtractionStatus: "ok",
		CreateTask:       false,
		Now:              now,
	}); err != nil {
		t.Fatalf("登记测试书籍失败: %v", err)
	}

	handler, err := pdf.NewHandler(pdf.Options{
		Resolver: pdf.NewStoreResolver(database),
		BooksDir: booksDir,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return &testEnv{
		handler:     handler,
		booksDir:    booksDir,
		store:       database,
		bookID:      testBookID,
		fileVersion: fileVersion,
		content:     content,
	}
}

func makeTestPDF(size int) []byte {
	content := make([]byte, size)
	copy(content, "%PDF-1.7\n")
	for i := len("%PDF-1.7\n"); i < size; i++ {
		content[i] = byte(i % 251)
	}
	return content
}

func (e *testEnv) contentURL() string {
	return "/api/v1/books/" + e.bookID + "/versions/" + e.fileVersion + "/content"
}

func (e *testEnv) request(method, target string, headers ...string) *httptest.ResponseRecorder {
	return e.requestHandler(e.handler, method, target, headers...)
}

func (e *testEnv) requestHandler(handler http.Handler, method, target string, headers ...string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	for i := 0; i+1 < len(headers); i += 2 {
		request.Header.Set(headers[i], headers[i+1])
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

type apiErrorEnvelope struct {
	Error struct {
		Code      string         `json:"code"`
		Message   string         `json:"message"`
		RequestID string         `json:"requestId"`
		Details   map[string]any `json:"details"`
	} `json:"error"`
}

func decodeAPIError(t *testing.T, recorder *httptest.ResponseRecorder) apiErrorEnvelope {
	t.Helper()
	var envelope apiErrorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("解码错误包络失败: %v，body=%s", err, recorder.Body.String())
	}
	return envelope
}

func requireHeader(t *testing.T, recorder *httptest.ResponseRecorder, name, want string) {
	t.Helper()
	if got := recorder.Header().Get(name); got != want {
		t.Fatalf("%s = %q，期望 %q", name, got, want)
	}
}

func TestContentFullRepresentation(t *testing.T) {
	env := newTestEnv(t)

	recorder := env.request(http.MethodGet, env.contentURL())
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	if !bytes.Equal(recorder.Body.Bytes(), env.content) {
		t.Fatal("200 body 与原件字节不一致")
	}
	requireHeader(t, recorder, "Content-Type", pdf.MediaType)
	requireHeader(t, recorder, "Accept-Ranges", "bytes")
	requireHeader(t, recorder, "ETag", `"`+env.fileVersion+`"`)
	requireHeader(t, recorder, "Cache-Control", "private, no-cache, no-transform")
	requireHeader(t, recorder, "X-Content-Type-Options", "nosniff")
	requireHeader(t, recorder, "Content-Length", strconv.Itoa(len(env.content)))
	if recorder.Header().Get("Content-Encoding") != "" {
		t.Fatalf("Content-Encoding 不应存在: %q", recorder.Header().Get("Content-Encoding"))
	}
	if recorder.Header().Get("Content-Disposition") != "" {
		t.Fatal("原件流不应设置 Content-Disposition")
	}

	firstModified := recorder.Header().Get("Last-Modified")
	if _, err := http.ParseTime(firstModified); err != nil {
		t.Fatalf("Last-Modified 无效: %q", firstModified)
	}
	second := env.request(http.MethodGet, env.contentURL())
	if got := second.Header().Get("Last-Modified"); got != firstModified {
		t.Fatalf("Last-Modified 不稳定: %q != %q", got, firstModified)
	}
}

func TestExactRangeAndHead(t *testing.T) {
	env := newTestEnv(t)

	recorder := env.request(http.MethodGet, env.contentURL(), "Range", "bytes=0-65535")
	if recorder.Code != http.StatusPartialContent {
		t.Fatalf("0-65535 status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.Len() != 65536 {
		t.Fatalf("0-65535 body 长度 = %d，期望 65536", recorder.Body.Len())
	}
	if !bytes.Equal(recorder.Body.Bytes(), env.content[:65536]) {
		t.Fatal("0-65535 body 与原件字节不一致")
	}
	requireHeader(t, recorder, "Content-Range", fmt.Sprintf("bytes 0-65535/%d", len(env.content)))
	requireHeader(t, recorder, "Content-Length", "65536")
	requireHeader(t, recorder, "Accept-Ranges", "bytes")

	head := env.request(http.MethodHead, env.contentURL())
	if head.Code != http.StatusOK {
		t.Fatalf("HEAD status = %d", head.Code)
	}
	if head.Body.Len() != 0 {
		t.Fatalf("HEAD body 长度 = %d", head.Body.Len())
	}
	requireHeader(t, head, "Content-Length", strconv.Itoa(len(env.content)))
	requireHeader(t, head, "Content-Type", pdf.MediaType)
	requireHeader(t, head, "Accept-Ranges", "bytes")
	requireHeader(t, head, "ETag", `"`+env.fileVersion+`"`)

	// HEAD 不是分页传输：即使带 Range 也应描述完整表示。
	headWithRange := env.request(http.MethodHead, env.contentURL(), "Range", "bytes=0-65535")
	if headWithRange.Code != http.StatusOK {
		t.Fatalf("HEAD+Range status = %d，期望 200", headWithRange.Code)
	}
	if headWithRange.Body.Len() != 0 {
		t.Fatalf("HEAD+Range body 长度 = %d", headWithRange.Body.Len())
	}
	requireHeader(t, headWithRange, "Content-Length", strconv.Itoa(len(env.content)))

	headWithManyRanges := env.request(http.MethodHead, env.contentURL(), "Range", "bytes="+strings.Repeat("0-0,", 20)+"0-0")
	if headWithManyRanges.Code != http.StatusOK {
		t.Fatalf("HEAD+多段 Range status = %d，期望 200", headWithManyRanges.Code)
	}
	if headWithManyRanges.Body.Len() != 0 {
		t.Fatalf("HEAD+多段 Range body 长度 = %d", headWithManyRanges.Body.Len())
	}
	requireHeader(t, headWithManyRanges, "Content-Length", strconv.Itoa(len(env.content)))
}

func TestSuffixAndOpenRanges(t *testing.T) {
	env := newTestEnv(t)
	size := len(env.content)

	suffix := env.request(http.MethodGet, env.contentURL(), "Range", "bytes=-1024")
	if suffix.Code != http.StatusPartialContent {
		t.Fatalf("suffix status = %d", suffix.Code)
	}
	if suffix.Body.Len() != 1024 {
		t.Fatalf("suffix body 长度 = %d", suffix.Body.Len())
	}
	requireHeader(t, suffix, "Content-Range", fmt.Sprintf("bytes %d-%d/%d", size-1024, size-1, size))
	if !bytes.Equal(suffix.Body.Bytes(), env.content[size-1024:]) {
		t.Fatal("suffix body 字节不一致")
	}

	open := env.request(http.MethodGet, env.contentURL(), "Range", "bytes=199000-")
	if open.Code != http.StatusPartialContent {
		t.Fatalf("open status = %d", open.Code)
	}
	if open.Body.Len() != 1000 {
		t.Fatalf("open body 长度 = %d", open.Body.Len())
	}
	requireHeader(t, open, "Content-Range", fmt.Sprintf("bytes 199000-199999/%d", size))
	if !bytes.Equal(open.Body.Bytes(), env.content[199000:]) {
		t.Fatal("open body 字节不一致")
	}
}

func TestConditionalRequests(t *testing.T) {
	env := newTestEnv(t)
	etag := `"` + env.fileVersion + `"`

	notModified := env.request(http.MethodGet, env.contentURL(), "If-None-Match", etag)
	if notModified.Code != http.StatusNotModified {
		t.Fatalf("If-None-Match status = %d，期望 304", notModified.Code)
	}
	if notModified.Body.Len() != 0 {
		t.Fatalf("304 body 长度 = %d", notModified.Body.Len())
	}
	requireHeader(t, notModified, "ETag", etag)

	conditionalRange := env.request(http.MethodGet, env.contentURL(),
		"Range", "bytes=0-99", "If-None-Match", etag)
	if conditionalRange.Code != http.StatusNotModified {
		t.Fatalf("条件优先于 Range status = %d，期望 304", conditionalRange.Code)
	}

	precondition := env.request(http.MethodGet, env.contentURL(), "If-Match", `"0000000000000000000000000000000000000000000000000000000000000000"`)
	if precondition.Code != http.StatusPreconditionFailed {
		t.Fatalf("If-Match 不匹配 status = %d，期望 412", precondition.Code)
	}
	if precondition.Body.Len() != 0 {
		t.Fatalf("412 body 长度 = %d", precondition.Body.Len())
	}

	full := env.request(http.MethodGet, env.contentURL())
	lastModified := full.Header().Get("Last-Modified")
	modifiedSince := env.request(http.MethodGet, env.contentURL(), "If-Modified-Since", lastModified)
	if modifiedSince.Code != http.StatusNotModified {
		t.Fatalf("If-Modified-Since status = %d，期望 304", modifiedSince.Code)
	}

	ifRangeMatch := env.request(http.MethodGet, env.contentURL(),
		"Range", "bytes=100-199", "If-Range", etag)
	if ifRangeMatch.Code != http.StatusPartialContent {
		t.Fatalf("If-Range 命中 status = %d，期望 206", ifRangeMatch.Code)
	}
	if ifRangeMatch.Body.Len() != 100 || !bytes.Equal(ifRangeMatch.Body.Bytes(), env.content[100:200]) {
		t.Fatal("If-Range 命中 body 不正确")
	}

	ifRangeMiss := env.request(http.MethodGet, env.contentURL(),
		"Range", "bytes=100-199", "If-Range", `"deadbeef"`)
	if ifRangeMiss.Code != http.StatusOK {
		t.Fatalf("If-Range 不匹配 status = %d，期望 200", ifRangeMiss.Code)
	}
	if ifRangeMiss.Body.Len() != len(env.content) {
		t.Fatalf("If-Range 不匹配 body 长度 = %d，期望完整 %d", ifRangeMiss.Body.Len(), len(env.content))
	}
	if ifRangeMiss.Header().Get("Content-Range") != "" {
		t.Fatal("If-Range 不匹配不应带 Content-Range")
	}
}

func TestUnsatisfiableAndMultiRange(t *testing.T) {
	env := newTestEnv(t)
	size := len(env.content)

	unsatisfiable := env.request(http.MethodGet, env.contentURL(), "Range", fmt.Sprintf("bytes=%d-", size))
	if unsatisfiable.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("不可满足 Range status = %d，期望 416", unsatisfiable.Code)
	}
	requireHeader(t, unsatisfiable, "Content-Range", fmt.Sprintf("bytes */%d", size))
	if strings.Contains(strings.ToLower(unsatisfiable.Body.String()), "<!doctype html") {
		t.Fatal("416 不应返回 SPA")
	}

	invalid := env.request(http.MethodGet, env.contentURL(), "Range", "bytes=abc")
	if invalid.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("非法 Range status = %d，期望 416", invalid.Code)
	}

	multi := env.request(http.MethodGet, env.contentURL(), "Range", "bytes=0-9,100-109")
	if multi.Code != http.StatusPartialContent {
		t.Fatalf("两段 Range status = %d，期望 206", multi.Code)
	}
	mediaType, params, err := mime.ParseMediaType(multi.Header().Get("Content-Type"))
	if err != nil || mediaType != "multipart/byteranges" {
		t.Fatalf("两段 Range Content-Type = %q err=%v", multi.Header().Get("Content-Type"), err)
	}
	reader := multipart.NewReader(bytes.NewReader(multi.Body.Bytes()), params["boundary"])
	parts := make([][]byte, 0, 2)
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("解析 multipart 失败: %v", err)
		}
		body, err := io.ReadAll(part)
		if err != nil {
			t.Fatalf("读取 multipart 失败: %v", err)
		}
		parts = append(parts, body)
	}
	if len(parts) != 2 || !bytes.Equal(parts[0], env.content[:10]) || !bytes.Equal(parts[1], env.content[100:110]) {
		t.Fatalf("multipart 字节不正确: parts=%d", len(parts))
	}

	tooMany := "bytes=" + strings.Repeat("0-0,", 20) + "0-0"
	abusive := env.request(http.MethodGet, env.contentURL(), "Range", tooMany)
	if abusive.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("超预算多段 Range status = %d，期望 416", abusive.Code)
	}
	requireHeader(t, abusive, "Content-Range", fmt.Sprintf("bytes */%d", size))

	huge := env.request(http.MethodGet, env.contentURL(), "Range", "bytes="+strings.Repeat("0-0,", 2000)+"0-0")
	if huge.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("超长 Range status = %d，期望 416", huge.Code)
	}
}

func TestPathAndVersionErrors(t *testing.T) {
	env := newTestEnv(t)

	cases := []struct {
		name   string
		target string
		status int
		code   string
	}{
		{
			name:   "未知书籍",
			target: "/api/v1/books/" + strings.Repeat("b", 32) + "/versions/" + env.fileVersion + "/content",
			status: http.StatusNotFound,
			code:   "not_found",
		},
		{
			name:   "错误 fileVersion",
			target: "/api/v1/books/" + env.bookID + "/versions/" + strings.Repeat("0", 64) + "/content",
			status: http.StatusConflict,
			code:   "file_version_conflict",
		},
		{
			name:   "bookId 非 32 hex",
			target: "/api/v1/books/not-a-book/versions/" + env.fileVersion + "/content",
			status: http.StatusNotFound,
			code:   "not_found",
		},
		{
			name:   "bookId 大写",
			target: "/api/v1/books/" + strings.ToUpper(env.bookID) + "/versions/" + env.fileVersion + "/content",
			status: http.StatusNotFound,
			code:   "not_found",
		},
		{
			name:   "fileVersion 非 64 hex",
			target: "/api/v1/books/" + env.bookID + "/versions/" + strings.Repeat("a", 63) + "/content",
			status: http.StatusNotFound,
			code:   "not_found",
		},
		{
			name:   "额外路径段",
			target: "/api/v1/books/" + env.bookID + "/versions/" + env.fileVersion + "/content/extra",
			status: http.StatusNotFound,
			code:   "not_found",
		},
		{
			name:   "编码斜杠",
			target: "/api/v1/books/" + env.bookID + "%2F..%2Fsecret/versions/" + env.fileVersion + "/content",
			status: http.StatusNotFound,
			code:   "not_found",
		},
		{
			name:   "编码反斜杠",
			target: "/api/v1/books/" + env.bookID + "%5C..%5Csecret/versions/" + env.fileVersion + "/content",
			status: http.StatusNotFound,
			code:   "not_found",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := env.request(http.MethodGet, testCase.target)
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d，期望 %d，body=%s", recorder.Code, testCase.status, recorder.Body.String())
			}
			if !strings.HasPrefix(recorder.Header().Get("Content-Type"), "application/json") {
				t.Fatalf("Content-Type = %q，期望 JSON", recorder.Header().Get("Content-Type"))
			}
			envelope := decodeAPIError(t, recorder)
			if envelope.Error.Code != testCase.code {
				t.Fatalf("code = %q，期望 %q", envelope.Error.Code, testCase.code)
			}
			body := recorder.Body.String()
			if strings.Contains(body, env.booksDir) || strings.Contains(strings.ToLower(body), "select ") ||
				strings.Contains(body, env.fileVersion) {
				t.Fatalf("错误响应泄露内部信息: %s", body)
			}
			if strings.Contains(strings.ToLower(body), "<!doctype html") {
				t.Fatal("错误响应不应是 SPA")
			}
		})
	}
}

type resolverFunc func(ctx context.Context, bookID string) (pdf.Source, error)

func (f resolverFunc) ResolveContent(ctx context.Context, bookID string) (pdf.Source, error) {
	return f(ctx, bookID)
}

func TestResolverCannotEscapeBooksDir(t *testing.T) {
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	if err := os.MkdirAll(booksDir, 0o750); err != nil {
		t.Fatal(err)
	}
	secret := makeTestPDF(4096)
	secretPath := filepath.Join(root, "secret.pdf")
	if err := os.WriteFile(secretPath, secret, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(secret)
	fileVersion := hex.EncodeToString(digest[:])

	for _, rel := range []string{
		"../secret.pdf",
		"book/../secret.pdf",
		"book/../../secret.pdf",
		secretPath,
		"book/%2e%2e/%2e%2e/secret.pdf",
		"book\\..\\secret.pdf",
	} {
		t.Run(rel, func(t *testing.T) {
			handler, err := pdf.NewHandler(pdf.Options{
				Resolver: resolverFunc(func(context.Context, string) (pdf.Source, error) {
					return pdf.Source{StorageRelPath: rel, ByteSize: int64(len(secret)), SHA256: fileVersion}, nil
				}),
				BooksDir: booksDir,
				Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
			})
			if err != nil {
				t.Fatal(err)
			}
			target := "/api/v1/books/" + testBookID + "/versions/" + fileVersion + "/content"
			request := httptest.NewRequest(http.MethodGet, target, nil)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("越界路径 status = %d，期望 404", recorder.Code)
			}
			body := recorder.Body.String()
			if strings.Contains(body, root) || strings.Contains(body, "secret") {
				t.Fatalf("响应泄露越界路径: %s", body)
			}
		})
	}
}

func TestSymlinkEscapeRejected(t *testing.T) {
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	bookDir := filepath.Join(booksDir, testBookID)
	if err := os.MkdirAll(bookDir, 0o700); err != nil {
		t.Fatal(err)
	}
	secret := makeTestPDF(4096)
	secretPath := filepath.Join(root, "secret.pdf")
	if err := os.WriteFile(secretPath, secret, 0o600); err != nil {
		t.Fatal(err)
	}
	linkPath := filepath.Join(bookDir, "link.pdf")
	if err := os.Symlink(secretPath, linkPath); err != nil {
		t.Skipf("当前环境不支持符号链接: %v", err)
	}
	digest := sha256.Sum256(secret)
	fileVersion := hex.EncodeToString(digest[:])

	handler, err := pdf.NewHandler(pdf.Options{
		Resolver: resolverFunc(func(context.Context, string) (pdf.Source, error) {
			return pdf.Source{
				StorageRelPath: testBookID + "/link.pdf",
				ByteSize:       int64(len(secret)),
				SHA256:         fileVersion,
			}, nil
		}),
		BooksDir: booksDir,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/books/"+testBookID+"/versions/"+fileVersion+"/content", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code == http.StatusOK {
		t.Fatal("符号链接逃逸不应返回 200")
	}
	if strings.Contains(recorder.Body.String(), root) {
		t.Fatal("响应泄露宿主路径")
	}
}

func TestMissingFileAndSizeMismatch(t *testing.T) {
	t.Run("文件缺失", func(t *testing.T) {
		env := newTestEnv(t)
		path := filepath.Join(env.booksDir, testBookID, env.fileVersion+".pdf")
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		recorder := env.request(http.MethodGet, env.contentURL())
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("文件缺失 status = %d，期望 503", recorder.Code)
		}
		if envelope := decodeAPIError(t, recorder); envelope.Error.Code != "storage_unavailable" {
			t.Fatalf("code = %q", envelope.Error.Code)
		}
	})

	t.Run("大小不一致", func(t *testing.T) {
		env := newTestEnv(t)
		handler, err := pdf.NewHandler(pdf.Options{
			Resolver: resolverFunc(func(context.Context, string) (pdf.Source, error) {
				return pdf.Source{
					StorageRelPath: testBookID + "/" + env.fileVersion + ".pdf",
					ByteSize:       int64(len(env.content) + 1),
					SHA256:         env.fileVersion,
				}, nil
			}),
			BooksDir: env.booksDir,
			Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
		if err != nil {
			t.Fatal(err)
		}
		recorder := env.requestHandler(handler, http.MethodGet, env.contentURL())
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("大小不一致 status = %d，期望 503", recorder.Code)
		}
	})
}

func TestStoreResolver(t *testing.T) {
	env := newTestEnv(t)
	resolver := pdf.NewStoreResolver(env.store)

	source, err := resolver.ResolveContent(context.Background(), env.bookID)
	if err != nil {
		t.Fatalf("ResolveContent() error = %v", err)
	}
	if source.SHA256 != env.fileVersion || source.ByteSize != int64(len(env.content)) {
		t.Fatalf("resolver 返回错误元数据: %+v", source)
	}

	if _, err := resolver.ResolveContent(context.Background(), strings.Repeat("b", 32)); !errors.Is(err, pdf.ErrBookNotFound) {
		t.Fatalf("未知书籍 error = %v，期望 ErrBookNotFound", err)
	}

	// 登记一本 EPUB，确认 resolver 不把非 PDF 原件当内容流。
	now := time.Now().UTC()
	epubID := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	uploadID := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	epubSHA := strings.Repeat("c", 64)
	if _, created, err := env.store.CreateUploadIntent(context.Background(), store.CreateUploadIntentParams{
		ID:             uploadID,
		ClientUploadID: "pdf-content-epub-test",
		FileName:       "sample.epub",
		ExpectedSize:   16,
		ExpiresAt:      now.Add(time.Hour),
		Now:            now,
	}); err != nil || !created {
		t.Fatalf("创建 EPUB 意图失败: created=%v err=%v", created, err)
	}
	if _, claimed, err := env.store.ClaimUploadContent(context.Background(), uploadID,
		".staging/"+uploadID+".part", now); err != nil || !claimed {
		t.Fatalf("占用 EPUB 意图失败: claimed=%v err=%v", claimed, err)
	}
	if err := env.store.PrepareUploadBook(context.Background(), store.PrepareUploadBookParams{
		UploadID:         uploadID,
		BookID:           epubID,
		DisplayTitle:     "EPUB 测试书",
		Format:           "epub",
		MediaType:        "application/epub+zip",
		OriginalFileName: "sample.epub",
		Extension:        "epub",
		SHA256:           epubSHA,
		ByteSize:         16,
		StorageRelPath:   epubID + "/" + epubSHA + ".epub",
		AuthorsJSON:      "[]",
		Status:           "ready",
		ExtractionStatus: "ok",
		CreateTask:       false,
		Now:              now,
	}); err != nil {
		t.Fatalf("登记 EPUB 失败: %v", err)
	}
	if _, err := resolver.ResolveContent(context.Background(), epubID); !errors.Is(err, pdf.ErrContentNotFound) {
		t.Fatalf("非 PDF error = %v，期望 ErrContentNotFound", err)
	}
}

func TestNoTransparentCompression(t *testing.T) {
	env := newTestEnv(t)
	recorder := env.request(http.MethodGet, env.contentURL(), "Accept-Encoding", "gzip, br")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if encoding := recorder.Header().Get("Content-Encoding"); encoding != "" {
		t.Fatalf("Content-Encoding = %q，原件流不应透明压缩", encoding)
	}
	if !bytes.Equal(recorder.Body.Bytes(), env.content) {
		t.Fatal("压缩协商后 body 发生变化")
	}
}
