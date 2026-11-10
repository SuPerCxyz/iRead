package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"iread/server/internal/reader/pdf"
)

const (
	pdfHTTPBookID = "11111111111111111111111111111111"
)

type pdfResolverFunc func(ctx context.Context, bookID string) (pdf.Source, error)

func (f pdfResolverFunc) ResolveContent(ctx context.Context, bookID string) (pdf.Source, error) {
	return f(ctx, bookID)
}

type pdfHTTPEnv struct {
	handler     *PDFContentHandler
	mux         *http.ServeMux
	bookID      string
	fileVersion string
	content     []byte
}

func newPDFHTTPEnv(t *testing.T, auth Middleware) *pdfHTTPEnv {
	t.Helper()
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	bookDir := filepath.Join(booksDir, pdfHTTPBookID)
	if err := os.MkdirAll(bookDir, 0o700); err != nil {
		t.Fatal(err)
	}
	content := make([]byte, 200000)
	copy(content, "%PDF-1.7\n")
	for i := len("%PDF-1.7\n"); i < len(content); i++ {
		content[i] = byte(i % 251)
	}
	digest := sha256.Sum256(content)
	fileVersion := hex.EncodeToString(digest[:])
	relPath := pdfHTTPBookID + "/" + fileVersion + ".pdf"
	if err := os.WriteFile(filepath.Join(booksDir, filepath.FromSlash(relPath)), content, 0o600); err != nil {
		t.Fatal(err)
	}

	resolver := pdfResolverFunc(func(_ context.Context, bookID string) (pdf.Source, error) {
		if bookID != pdfHTTPBookID {
			return pdf.Source{}, pdf.ErrBookNotFound
		}
		return pdf.Source{StorageRelPath: relPath, ByteSize: int64(len(content)), SHA256: fileVersion}, nil
	})
	handler, err := NewPDFContentHandler(PDFContentOptions{
		Resolver:    resolver,
		BooksDir:    booksDir,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		RequireAuth: auth,
	})
	if err != nil {
		t.Fatalf("NewPDFContentHandler() error = %v", err)
	}

	mux := http.NewServeMux()
	// 模拟现有书库前缀路由，验证更具体的 PDF 路由不会被它吞掉或冲突。
	mux.Handle("/api/v1/books/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	handler.RegisterPDFRoutes(mux)

	return &pdfHTTPEnv{
		handler:     handler,
		mux:         mux,
		bookID:      pdfHTTPBookID,
		fileVersion: fileVersion,
		content:     content,
	}
}

func (e *pdfHTTPEnv) contentURL() string {
	return "/api/v1/books/" + e.bookID + "/versions/" + e.fileVersion + "/content"
}

func (e *pdfHTTPEnv) request(method, target string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	recorder := httptest.NewRecorder()
	e.mux.ServeHTTP(recorder, request)
	return recorder
}

func TestPDFContentRoutesRequireAuth(t *testing.T) {
	env := newPDFHTTPEnv(t, nil)

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		recorder := env.request(method, env.contentURL())
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d，期望 401", method, recorder.Code)
		}
		if !strings.HasPrefix(recorder.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("%s Content-Type = %q，期望 JSON", method, recorder.Header().Get("Content-Type"))
		}
		if method == http.MethodHead && recorder.Body.Len() != 0 {
			t.Fatalf("HEAD 401 body 长度 = %d", recorder.Body.Len())
		}
		if method == http.MethodGet {
			envelope := decodeLibraryError(t, recorder)
			if envelope.Error.Code != "unauthenticated" {
				t.Fatalf("code = %q", envelope.Error.Code)
			}
		}
	}

	denied := newPDFHTTPEnv(t, denyAuthMiddleware)
	if recorder := denied.request(http.MethodGet, denied.contentURL()); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("注入认证拒绝 status = %d", recorder.Code)
	}
}

func TestPDFContentRouteRegistrationAndMethods(t *testing.T) {
	env := newPDFHTTPEnv(t, allowAllMiddleware)

	// 该请求会同时匹配 /api/v1/books/ 前缀；更具体的 PDF 路由必须获胜。
	recorder := env.request(http.MethodGet, env.contentURL())
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.Len() != len(env.content) {
		t.Fatalf("GET body 长度 = %d，期望 %d", recorder.Body.Len(), len(env.content))
	}

	head := env.request(http.MethodHead, env.contentURL())
	if head.Code != http.StatusOK {
		t.Fatalf("HEAD status = %d", head.Code)
	}
	if head.Body.Len() != 0 {
		t.Fatalf("HEAD body 长度 = %d", head.Body.Len())
	}
	if head.Header().Get("Content-Length") == "" {
		t.Fatal("HEAD 应返回完整表示长度")
	}

	post := env.request(http.MethodPost, env.contentURL())
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d，期望 405", post.Code)
	}
	if allow := post.Header().Get("Allow"); allow != "GET, HEAD" {
		t.Fatalf("Allow = %q", allow)
	}
	if envelope := decodeLibraryError(t, post); envelope.Error.Code != "invalid_request" {
		t.Fatalf("POST code = %q", envelope.Error.Code)
	}
}

func TestPDFContentRouteErrorsUseJSONAndNoSPA(t *testing.T) {
	env := newPDFHTTPEnv(t, allowAllMiddleware)

	cases := []struct {
		name   string
		target string
		status int
		code   string
	}{
		{
			name:   "未知书籍",
			target: "/api/v1/books/" + strings.Repeat("2", 32) + "/versions/" + env.fileVersion + "/content",
			status: http.StatusNotFound,
			code:   "not_found",
		},
		{
			name:   "版本冲突",
			target: "/api/v1/books/" + env.bookID + "/versions/" + strings.Repeat("3", 64) + "/content",
			status: http.StatusConflict,
			code:   "file_version_conflict",
		},
		{
			name:   "编码路径穿越",
			target: "/api/v1/books/" + env.bookID + "%2F..%2Fetc%2Fpasswd/versions/" + env.fileVersion + "/content",
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
				t.Fatalf("Content-Type = %q", recorder.Header().Get("Content-Type"))
			}
			envelope := decodeLibraryError(t, recorder)
			if envelope.Error.Code != testCase.code {
				t.Fatalf("code = %q，期望 %q", envelope.Error.Code, testCase.code)
			}
			if strings.Contains(strings.ToLower(recorder.Body.String()), "<!doctype html") {
				t.Fatal("错误响应不应是 SPA")
			}
			if strings.Contains(recorder.Body.String(), env.fileVersion) {
				t.Fatal("错误响应不应包含内部版本细节")
			}
		})
	}
}

func TestPDFContentUsesStableHTTPDates(t *testing.T) {
	env := newPDFHTTPEnv(t, allowAllMiddleware)
	first := env.request(http.MethodGet, env.contentURL())
	firstModified := first.Header().Get("Last-Modified")
	if _, err := time.Parse(http.TimeFormat, firstModified); err != nil {
		t.Fatalf("Last-Modified 无效: %q", firstModified)
	}
	second := env.request(http.MethodGet, env.contentURL())
	if second.Header().Get("Last-Modified") != firstModified {
		t.Fatal("Last-Modified 不稳定")
	}
}
