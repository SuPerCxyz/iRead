package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"iread/server/internal/reader/epub"
	"iread/server/internal/reader/epub/epubtest"
	"iread/server/internal/store"
)

const (
	readerManifestBookID   = "11112222333344445555666677778888"
	readerManifestUploadID = "aaaabbbbccccddddeeeeffff00001111"
	readerManifestTaskID   = "99998888777766665555444433332222"
)

type readerManifestErrorEnvelope struct {
	Error struct {
		Code      string         `json:"code"`
		Message   string         `json:"message"`
		RequestID string         `json:"requestId"`
		Details   map[string]any `json:"details"`
	} `json:"error"`
}

type readerManifestEnv struct {
	handlers    *ReaderManifestHandlers
	noAuth      *ReaderManifestHandlers
	mux         *http.ServeMux
	store       *store.Store
	booksDir    string
	bookID      string
	fileVersion string
	archivePath string
	sample      *epubtest.Sample
}

func newReaderManifestEnv(t *testing.T, options epubtest.Options) *readerManifestEnv {
	t.Helper()
	return newReaderManifestEnvMode(t, options, false)
}

// newReaderManifestUnsupportedEnv 模拟 formats.Validate 把含 encryption.xml 的
// EPUB 标记为 unsupported、且没有索引任务的真实登记形态。
func newReaderManifestUnsupportedEnv(t *testing.T, options epubtest.Options) *readerManifestEnv {
	t.Helper()
	return newReaderManifestEnvMode(t, options, true)
}

func newReaderManifestEnvMode(t *testing.T, options epubtest.Options, unsupported bool) *readerManifestEnv {
	t.Helper()
	sample, err := epubtest.Build(options)
	if err != nil {
		t.Fatalf("生成 EPUB 样本失败: %v", err)
	}
	return newReaderManifestSampleEnvMode(t, sample, unsupported)
}

// newReaderManifestSampleEnvMode 用调用方提供的 EPUB 样本登记书籍，
// 供需要替换资源内容的测试复用同一套存储与路由环境。
func newReaderManifestSampleEnvMode(t *testing.T, sample *epubtest.Sample, unsupported bool) *readerManifestEnv {
	t.Helper()
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	if err := os.MkdirAll(filepath.Join(booksDir, readerManifestBookID), 0o700); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(sample.Data)
	fileVersion := hex.EncodeToString(digest[:])
	rel := readerManifestBookID + "/" + fileVersion + ".epub"
	archivePath := filepath.Join(booksDir, filepath.FromSlash(rel))
	if err := os.WriteFile(archivePath, sample.Data, 0o600); err != nil {
		t.Fatal(err)
	}

	database, err := store.Open(context.Background(), filepath.Join(root, "db", "iread.db"))
	if err != nil {
		t.Fatalf("打开测试数据库失败: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	now := time.Now().UTC()
	if _, created, err := database.CreateUploadIntent(context.Background(), store.CreateUploadIntentParams{
		ID:             readerManifestUploadID,
		ClientUploadID: "reader-manifest-test",
		FileName:       "sample.epub",
		ExpectedSize:   int64(len(sample.Data)),
		ExpiresAt:      now.Add(time.Hour),
		Now:            now,
	}); err != nil || !created {
		t.Fatalf("创建上传意图失败: created=%v err=%v", created, err)
	}
	if _, claimed, err := database.ClaimUploadContent(context.Background(), readerManifestUploadID,
		".staging/"+readerManifestUploadID+".part", now); err != nil || !claimed {
		t.Fatalf("占用上传意图失败: claimed=%v err=%v", claimed, err)
	}
	params := store.PrepareUploadBookParams{
		UploadID:         readerManifestUploadID,
		BookID:           readerManifestBookID,
		DisplayTitle:     "Reader Sample",
		Format:           "epub",
		MediaType:        "application/epub+zip",
		OriginalFileName: "sample.epub",
		Extension:        "epub",
		SHA256:           fileVersion,
		ByteSize:         int64(len(sample.Data)),
		StorageRelPath:   rel,
		AuthorsJSON:      "[]",
		Status:           "indexing",
		ExtractionStatus: "pending",
		CreateTask:       true,
		TaskID:           readerManifestTaskID,
		Now:              now,
	}
	if unsupported {
		params.Status = "unsupported"
		params.ExtractionStatus = "unsupported"
		params.CreateTask = false
		params.TaskID = ""
	}
	if err := database.PrepareUploadBook(context.Background(), params); err != nil {
		t.Fatalf("登记测试书籍失败: %v", err)
	}
	if err := database.CommitUpload(context.Background(), readerManifestUploadID, now); err != nil {
		t.Fatalf("提交测试上传失败: %v", err)
	}
	if !unsupported {
		task, found, err := database.ClaimNextTask(context.Background(), time.Minute)
		if err != nil || !found {
			t.Fatalf("领取测试任务失败: found=%v err=%v", found, err)
		}
		indexVersion, err := database.FinalizeBookIndexTask(context.Background(), task.ID, store.BookIndexData{
			ExtractionStatus: "ok",
		})
		if err != nil || indexVersion != 1 {
			t.Fatalf("提交索引失败: version=%d err=%v", indexVersion, err)
		}
	}

	resolver := NewReaderManifestStoreResolver(database)
	handlers, err := NewReaderManifestHandlers(ReaderManifestOptions{
		Resolver:    resolver,
		Store:       database,
		BooksDir:    booksDir,
		RequireAuth: func(next http.Handler) http.Handler { return next },
	})
	if err != nil {
		t.Fatalf("构造 manifest handler 失败: %v", err)
	}
	noAuth, err := NewReaderManifestHandlers(ReaderManifestOptions{
		Resolver: resolver,
		Store:    database,
		BooksDir: booksDir,
	})
	if err != nil {
		t.Fatalf("构造无认证 handler 失败: %v", err)
	}
	mux := http.NewServeMux()
	handlers.RegisterReaderManifestRoutes(mux)
	return &readerManifestEnv{
		handlers:    handlers,
		noAuth:      noAuth,
		mux:         mux,
		store:       database,
		booksDir:    booksDir,
		bookID:      readerManifestBookID,
		fileVersion: fileVersion,
		archivePath: archivePath,
		sample:      sample,
	}
}

func (e *readerManifestEnv) request(method, target string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	e.mux.ServeHTTP(recorder, httptest.NewRequest(method, target, nil))
	return recorder
}

func (e *readerManifestEnv) manifestURL() string {
	return "/api/v1/books/" + e.bookID + "/manifest"
}

func (e *readerManifestEnv) resourceURL(resourceID string) string {
	return "/api/v1/books/" + e.bookID + "/versions/" + e.fileVersion + "/resources/" + resourceID
}

func decodeReaderManifest(t *testing.T, recorder *httptest.ResponseRecorder) epub.Manifest {
	t.Helper()
	var envelope struct {
		Data epub.Manifest `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("解码 manifest 失败: %v，body=%s", err, recorder.Body.String())
	}
	return envelope.Data
}

func readerManifestResourceID(manifest epub.Manifest, href string) string {
	for resourceID, resource := range manifest.FormatData.Resources {
		if resource.Href == href {
			return resourceID
		}
	}
	return ""
}

func TestReaderManifestEPUB3(t *testing.T) {
	env := newReaderManifestEnv(t, epubtest.Options{Version: 3})

	recorder := env.request(http.MethodGet, env.manifestURL())
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("nosniff = %q", got)
	}
	manifest := decodeReaderManifest(t, recorder)
	if manifest.SchemaVersion != 1 || manifest.BookID != env.bookID ||
		manifest.FileVersion != env.fileVersion || manifest.Format != "epub" ||
		manifest.IndexVersion != 1 {
		t.Fatalf("manifest = %+v", manifest)
	}
	if !manifest.ReadingCapabilities.CanRead || manifest.ReadingCapabilities.UnavailableReason != "" {
		t.Fatalf("capabilities = %+v", manifest.ReadingCapabilities)
	}
	for _, feature := range manifest.ReadingCapabilities.Features {
		if feature == "search" {
			t.Fatalf("features 不应包含 search: %v", manifest.ReadingCapabilities.Features)
		}
	}
	if len(manifest.FormatData.Spine) != 2 || manifest.FormatData.Spine[0].Href != env.sample.ChapterPaths[0] {
		t.Fatalf("spine = %+v", manifest.FormatData.Spine)
	}
	if len(manifest.TOC) != 2 || manifest.TOC[0].Title != "Chapter 1" {
		t.Fatalf("toc = %+v", manifest.TOC)
	}

	stored, found, err := env.store.GetBookManifest(context.Background(), env.bookID)
	if err != nil || !found {
		t.Fatalf("manifest 未持久化: found=%v err=%v", found, err)
	}
	if stored.FileVersion != env.fileVersion || stored.IndexVersion != 1 {
		t.Fatalf("持久化 manifest = %+v", stored)
	}

	oldVersion := strings.Repeat("0", 64)
	if oldVersion == env.fileVersion {
		oldVersion = strings.Repeat("1", 64)
	}
	current := env.request(http.MethodGet, env.manifestURL()+"?fileVersion="+env.fileVersion)
	if current.Code != http.StatusOK {
		t.Fatalf("当前 fileVersion status = %d，body=%s", current.Code, current.Body.String())
	}
	conflict := env.request(http.MethodGet, env.manifestURL()+"?fileVersion="+oldVersion)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("旧 fileVersion status = %d，body=%s", conflict.Code, conflict.Body.String())
	}
	var envelope readerManifestErrorEnvelope
	if err := json.Unmarshal(conflict.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != "file_version_conflict" ||
		envelope.Error.Details["current"] != env.fileVersion {
		t.Fatalf("冲突包络 = %+v", envelope.Error)
	}

	unknown := env.request(http.MethodGet, "/api/v1/books/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/manifest")
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("未知书籍 status = %d", unknown.Code)
	}
	malformed := env.request(http.MethodGet, "/api/v1/books/not-a-book/manifest")
	if malformed.Code != http.StatusNotFound {
		t.Fatalf("非法书籍 ID status = %d", malformed.Code)
	}
	method := env.request(http.MethodPost, env.manifestURL())
	if method.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", method.Code)
	}
	if method.Header().Get("Allow") != "GET" {
		t.Fatalf("Allow = %q", method.Header().Get("Allow"))
	}
}

func TestReaderResourceBytesAndHeaders(t *testing.T) {
	env := newReaderManifestEnv(t, epubtest.Options{Version: 3})
	manifest := decodeReaderManifest(t, env.request(http.MethodGet, env.manifestURL()))

	chapterID := readerManifestResourceID(manifest, env.sample.ChapterPaths[0])
	if chapterID == "" {
		t.Fatal("manifest 缺少章节资源")
	}
	recorder := env.request(http.MethodGet, env.resourceURL(chapterID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	if !bytes.Equal(recorder.Body.Bytes(), env.sample.ChapterData[0]) {
		t.Fatalf("章节字节错误")
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/xhtml+xml" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := recorder.Header().Get("Content-Length"); got != strconv.Itoa(len(env.sample.ChapterData[0])) {
		t.Fatalf("Content-Length = %q", got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("nosniff = %q", got)
	}

	fontID := readerManifestResourceID(manifest, env.sample.FontPath)
	fontRecorder := env.request(http.MethodGet, env.resourceURL(fontID))
	if fontRecorder.Code != http.StatusOK || !bytes.Equal(fontRecorder.Body.Bytes(), env.sample.FontPlain) {
		t.Fatalf("字体资源错误: status=%d", fontRecorder.Code)
	}
	if got := fontRecorder.Header().Get("Content-Type"); got != "font/otf" {
		t.Fatalf("字体 Content-Type = %q", got)
	}

	head := env.request(http.MethodHead, env.resourceURL(chapterID))
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("HEAD status=%d body=%q", head.Code, head.Body.String())
	}
	if got := head.Header().Get("Content-Length"); got != strconv.Itoa(len(env.sample.ChapterData[0])) {
		t.Fatalf("HEAD Content-Length = %q", got)
	}

	unknownID := "00000000000000000000000000000000"
	if unknownID == chapterID {
		unknownID = "11111111111111111111111111111111"
	}
	unknown := env.request(http.MethodGet, env.resourceURL(unknownID))
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("未知资源 status = %d", unknown.Code)
	}
	badHex := env.request(http.MethodGet, env.resourceURL("not-a-resource"))
	if badHex.Code != http.StatusNotFound {
		t.Fatalf("非法资源 ID status = %d", badHex.Code)
	}
	traversal := env.request(http.MethodGet, env.resourceURL("..%2f..%2fetc%2fpasswd"))
	if traversal.Code != http.StatusNotFound {
		t.Fatalf("穿越资源 ID status = %d，body=%s", traversal.Code, traversal.Body.String())
	}

	audioID := epub.ResourceID(env.sample.AudioPath)
	audio := env.request(http.MethodGet, env.resourceURL(audioID))
	if audio.Code != http.StatusNotFound {
		t.Fatalf("白名单外资源 status = %d", audio.Code)
	}

	oldVersion := strings.Repeat("0", 64)
	if oldVersion == env.fileVersion {
		oldVersion = strings.Repeat("1", 64)
	}
	old := env.request(http.MethodGet,
		"/api/v1/books/"+env.bookID+"/versions/"+oldVersion+"/resources/"+chapterID)
	if old.Code != http.StatusConflict {
		t.Fatalf("旧 fileVersion status = %d，body=%s", old.Code, old.Body.String())
	}
	var envelope readerManifestErrorEnvelope
	if err := json.Unmarshal(old.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != "file_version_conflict" {
		t.Fatalf("冲突错误 = %+v", envelope.Error)
	}

	// manifest 声明的每个资源都必须可实际读取，避免索引与端点白名单不一致。
	for resourceID, resource := range manifest.FormatData.Resources {
		recorder := env.request(http.MethodGet, env.resourceURL(resourceID))
		if recorder.Code != http.StatusOK {
			t.Fatalf("资源 %s(%s) status = %d", resourceID, resource.Href, recorder.Code)
		}
		if recorder.Body.Len() != int(resource.Size) {
			t.Fatalf("资源 %s 长度 = %d，期望 %d", resourceID, recorder.Body.Len(), resource.Size)
		}
		if got := recorder.Header().Get("Content-Length"); got != strconv.FormatInt(resource.Size, 10) {
			t.Fatalf("资源 %s Content-Length = %q", resourceID, got)
		}
	}
}

func TestReaderResourceBuildsManifestOnDemand(t *testing.T) {
	env := newReaderManifestEnv(t, epubtest.Options{Version: 2})
	manifest, err := epub.NewBuilder(env.booksDir)
	if err != nil {
		t.Fatal(err)
	}
	built, err := manifest.Build(context.Background(), epub.Source{
		BookID:         env.bookID,
		FileVersion:    env.fileVersion,
		Format:         "epub",
		StorageRelPath: env.bookID + "/" + env.fileVersion + ".epub",
		IndexVersion:   1,
	})
	if err != nil {
		t.Fatal(err)
	}
	chapterID := readerManifestResourceID(built, env.sample.ChapterPaths[0])
	// 新库没有 manifest 记录；直接请求资源应先按需构建并持久化。
	recorder := env.request(http.MethodGet, env.resourceURL(chapterID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	if !bytes.Equal(recorder.Body.Bytes(), env.sample.ChapterData[0]) {
		t.Fatalf("按需构建后资源字节错误")
	}
	if _, found, err := env.store.GetBookManifest(context.Background(), env.bookID); err != nil || !found {
		t.Fatalf("按需 manifest 未持久化: found=%v err=%v", found, err)
	}
}

func TestReaderManifestUnauthenticated(t *testing.T) {
	env := newReaderManifestEnv(t, epubtest.Options{Version: 3})
	mux := http.NewServeMux()
	env.noAuth.RegisterReaderManifestRoutes(mux)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, env.manifestURL(), nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	var envelope readerManifestErrorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != "unauthenticated" {
		t.Fatalf("错误 = %+v", envelope.Error)
	}
}

func TestReaderManifestFontObfuscationAndContentEncryption(t *testing.T) {
	t.Run("font", func(t *testing.T) {
		env := newReaderManifestEnv(t, epubtest.Options{Version: 3, ObfuscateFont: "idpf"})
		before, err := os.ReadFile(env.archivePath)
		if err != nil {
			t.Fatal(err)
		}
		manifest := decodeReaderManifest(t, env.request(http.MethodGet, env.manifestURL()))
		if !manifest.ReadingCapabilities.CanRead ||
			!manifest.FormatData.ContentProtection.FontObfuscated ||
			manifest.FormatData.ContentProtection.ContentEncrypted {
			t.Fatalf("字体混淆 manifest = %+v", manifest.FormatData.ContentProtection)
		}
		fontID := readerManifestResourceID(manifest, env.sample.FontPath)
		recorder := env.request(http.MethodGet, env.resourceURL(fontID))
		if recorder.Code != http.StatusOK || !bytes.Equal(recorder.Body.Bytes(), env.sample.FontPlain) {
			t.Fatalf("字体资源错误: status=%d", recorder.Code)
		}
		after, err := os.ReadFile(env.archivePath)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(before, after) {
			t.Fatalf("读取后原件 hash 发生变化")
		}
	})

	t.Run("encrypted", func(t *testing.T) {
		env := newReaderManifestEnv(t, epubtest.Options{Version: 3, EncryptContent: true})
		recorder := env.request(http.MethodGet, env.manifestURL())
		if recorder.Code != http.StatusConflict {
			t.Fatalf("加密书 manifest status = %d，body=%s", recorder.Code, recorder.Body.String())
		}
		var envelope readerManifestErrorEnvelope
		if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Error.Code != "book_not_readable" ||
			envelope.Error.Details["reason"] != "drm_protected" {
			t.Fatalf("错误 = %+v", envelope.Error)
		}
	})
}

func TestReaderManifestFormatsDRMStatusIsRejected(t *testing.T) {
	env := newReaderManifestUnsupportedEnv(t, epubtest.Options{Version: 3, ObfuscateFont: "adobe"})
	recorder := env.request(http.MethodGet, env.manifestURL())
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	var envelope readerManifestErrorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != "book_not_readable" ||
		envelope.Error.Details["reason"] != "drm_protected" {
		t.Fatalf("错误 = %+v", envelope.Error)
	}
}

func TestReaderResourceUnknownBookTraversalAndUnauthenticated(t *testing.T) {
	env := newReaderManifestEnv(t, epubtest.Options{Version: 3})
	manifest := decodeReaderManifest(t, env.request(http.MethodGet, env.manifestURL()))
	chapterID := readerManifestResourceID(manifest, env.sample.ChapterPaths[0])

	unknownBook := env.request(http.MethodGet,
		"/api/v1/books/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/versions/"+env.fileVersion+"/resources/"+chapterID)
	if unknownBook.Code != http.StatusNotFound {
		t.Fatalf("未知书籍资源 status = %d", unknownBook.Code)
	}

	// 直接调用 handler，避免 ServeMux 对 ".." 路径做重定向，验证解析层拒绝。
	traversalTarget := "/api/v1/books/" + env.bookID + "/versions/" + env.fileVersion + "/resources/.."
	traversalRecorder := httptest.NewRecorder()
	env.handlers.handleResource(traversalRecorder, httptest.NewRequest(http.MethodGet, traversalTarget, nil))
	if traversalRecorder.Code != http.StatusNotFound {
		t.Fatalf("裸穿越 resourceId status = %d", traversalRecorder.Code)
	}

	noAuthMux := http.NewServeMux()
	env.noAuth.RegisterReaderManifestRoutes(noAuthMux)
	unauth := httptest.NewRecorder()
	noAuthMux.ServeHTTP(unauth, httptest.NewRequest(http.MethodGet, env.resourceURL(chapterID), nil))
	if unauth.Code != http.StatusUnauthorized {
		t.Fatalf("未认证资源 status = %d，body=%s", unauth.Code, unauth.Body.String())
	}
}

func TestReaderManifestRoutePrecedenceOverBookSubtree(t *testing.T) {
	env := newReaderManifestEnv(t, epubtest.Options{Version: 3})
	mux := http.NewServeMux()
	mux.Handle("/api/v1/books/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	env.handlers.RegisterReaderManifestRoutes(mux)

	for _, target := range []string{
		env.manifestURL(),
		env.resourceURL(readerManifestResourceID(decodeReaderManifest(t,
			env.request(http.MethodGet, env.manifestURL())), env.sample.ChapterPaths[0])),
	} {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d，body=%s", target, recorder.Code, recorder.Body.String())
		}
	}
}

func TestReaderManifestInvalidBookHasNoPath(t *testing.T) {
	env := newReaderManifestEnv(t, epubtest.Options{Version: 3})
	if err := os.WriteFile(env.archivePath, []byte("not a zip"), 0o600); err != nil {
		t.Fatal(err)
	}
	recorder := env.request(http.MethodGet, env.manifestURL())
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d，body=%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if strings.Contains(body, env.booksDir) || strings.Contains(body, ".epub") ||
		strings.Contains(body, "not a zip") {
		t.Fatalf("错误响应泄露路径或底层内容: %s", body)
	}
	var envelope readerManifestErrorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != "book_not_readable" ||
		envelope.Error.Details["reason"] != "invalid_epub" {
		t.Fatalf("错误 = %+v", envelope.Error)
	}
}
