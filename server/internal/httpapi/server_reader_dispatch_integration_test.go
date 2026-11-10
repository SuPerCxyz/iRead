package httpapi

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"iread/server/internal/reader/comic"
	"iread/server/internal/reader/epub"
	"iread/server/internal/reader/epub/epubtest"
)

// TestServerConstructsComicHandlers 验证 Server 保存了带 CacheDir 的漫画
// handler，并可在关闭时释放 RAR 会话。
func TestServerConstructsComicHandlers(t *testing.T) {
	env := newIntegratedTestEnv(t)
	if env.server.comicHandlers == nil {
		t.Fatal("Server 未构造 comicHandlers")
	}
	if err := env.server.Close(); err != nil {
		t.Fatalf("Server.Close() error = %v", err)
	}
}

func (e *testEnv) setPDFBookState(t *testing.T, bookID, status, extractionStatus string, pageCount int64) {
	t.Helper()
	raw, err := sql.Open("sqlite", readerTestDSN(e.dbPath))
	if err != nil {
		t.Fatalf("打开测试数据库连接: %v", err)
	}
	defer raw.Close()
	if _, err := raw.Exec(`UPDATE books SET status = ?, updated_at = updated_at WHERE id = ?`,
		status, bookID); err != nil {
		t.Fatalf("更新书籍状态: %v", err)
	}
	if _, err := raw.Exec(`UPDATE book_metadata SET extraction_status = ?, page_count = ? WHERE book_id = ?`,
		extractionStatus, pageCount, bookID); err != nil {
		t.Fatalf("更新书籍元数据: %v", err)
	}
}

func (e *testEnv) clearBookManifest(t *testing.T, bookID string) {
	t.Helper()
	raw, err := sql.Open("sqlite", readerTestDSN(e.dbPath))
	if err != nil {
		t.Fatalf("打开测试数据库连接: %v", err)
	}
	defer raw.Close()
	if _, err := raw.Exec(`DELETE FROM book_manifests WHERE book_id = ?`, bookID); err != nil {
		t.Fatalf("清除书籍 manifest: %v", err)
	}
}

// TestServerReaderDispatchEPUBAndComic 验证统一路由不会让漫画路径遮蔽 EPUB，
// 两套 manifest/资源都能按真实书籍格式返回。
func TestServerReaderDispatchEPUBAndComic(t *testing.T) {
	env := newIntegratedTestEnv(t)

	sample, err := epubtest.Build(epubtest.Options{Version: 3})
	if err != nil {
		t.Fatalf("生成 EPUB 样本: %v", err)
	}
	epubStored := env.uploadReaderFile(t, "dispatch.epub", sample.Data)
	if epubStored.BookID == nil {
		t.Fatal("EPUB 上传未返回 bookId")
	}
	epubID := *epubStored.BookID
	epubDetail := env.readerBookDetail(t, epubID)
	env.setPDFBookState(t, epubID, "ready", "ok", 0)

	epubManifestRecorder := env.request(http.MethodGet,
		"/api/v1/books/"+epubID+"/manifest", "", "")
	if epubManifestRecorder.Code != http.StatusOK {
		t.Fatalf("EPUB manifest status = %d, body=%s",
			epubManifestRecorder.Code, epubManifestRecorder.Body.String())
	}
	epubManifest := decodeData[epub.Manifest](t, epubManifestRecorder)
	if epubManifest.Format != epub.FormatEPUB || epubManifest.BookID != epubID {
		t.Fatalf("EPUB manifest = %+v", epubManifest)
	}
	if len(epubManifest.FormatData.Spine) == 0 {
		t.Fatalf("EPUB manifest spine 为空: %+v", epubManifest)
	}
	epubResourceID := epubManifest.FormatData.Spine[0].ResourceID
	epubResourceURL := "/api/v1/books/" + epubID + "/versions/" +
		epubDetail.FileVersion + "/resources/" + epubResourceID
	epubResource := env.request(http.MethodGet, epubResourceURL, "", "")
	if epubResource.Code != http.StatusOK {
		t.Fatalf("EPUB resource status = %d, body=%s",
			epubResource.Code, epubResource.Body.String())
	}
	if !strings.Contains(epubResource.Body.String(), "Chapter 1") {
		t.Fatalf("EPUB resource body 不含章节内容: %s", epubResource.Body.String())
	}

	archive := buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{
		{"page1.jpg", comicFixture(t, "page1.jpg")},
		{"page2.jpg", comicFixture(t, "page2.jpg")},
	})
	comicStored := env.uploadReaderFile(t, "dispatch.cbz", archive)
	if comicStored.BookID == nil {
		t.Fatal("CBZ 上传未返回 bookId")
	}
	comicID := *comicStored.BookID
	comicDetail := env.readerBookDetail(t, comicID)
	env.setPDFBookState(t, comicID, "ready", "ok", 2)

	comicManifestRecorder := env.request(http.MethodGet,
		"/api/v1/books/"+comicID+"/manifest", "", "")
	if comicManifestRecorder.Code != http.StatusOK {
		t.Fatalf("CBZ manifest status = %d, body=%s",
			comicManifestRecorder.Code, comicManifestRecorder.Body.String())
	}
	comicManifest := decodeData[comic.Manifest](t, comicManifestRecorder)
	if comicManifest.Format != comic.FormatCBZ || comicManifest.BookID != comicID ||
		comicManifest.FormatData.PageCount != 2 {
		t.Fatalf("CBZ manifest = %+v", comicManifest)
	}
	if !comicManifest.ReadingCapabilities.CanRead ||
		comicManifest.ReadingCapabilities.UnavailableReason != "" {
		t.Fatalf("CBZ readingCapabilities = %+v", comicManifest.ReadingCapabilities)
	}
	page := comicManifest.FormatData.Pages[0]
	pageURL := "/api/v1/books/" + comicID + "/versions/" +
		comicDetail.FileVersion + "/resources/" + page.ResourceID + "?variant=screen"
	pageRecorder := env.request(http.MethodGet, pageURL, "", "")
	if pageRecorder.Code != http.StatusOK {
		t.Fatalf("CBZ screen status = %d, body=%s",
			pageRecorder.Code, pageRecorder.Body.String())
	}
	if contentType := pageRecorder.Header().Get("Content-Type"); contentType != comic.MediaTypeJPEG {
		t.Fatalf("CBZ screen Content-Type = %q", contentType)
	}
	if pageRecorder.Body.Len() == 0 {
		t.Fatal("CBZ screen 响应为空")
	}
	headRecorder := env.request(http.MethodHead, pageURL, "", "")
	if headRecorder.Code != http.StatusOK || headRecorder.Body.Len() != 0 {
		t.Fatalf("CBZ HEAD status=%d bodyLen=%d", headRecorder.Code, headRecorder.Body.Len())
	}

	// 漫画请求之后再读 EPUB，确认精确漫画路由没有吞掉 EPUB 的共享路径。
	epubManifestAgain := env.request(http.MethodGet,
		"/api/v1/books/"+epubID+"/manifest", "", "")
	if epubManifestAgain.Code != http.StatusOK {
		t.Fatalf("二次 EPUB manifest status = %d, body=%s",
			epubManifestAgain.Code, epubManifestAgain.Body.String())
	}
	if again := decodeData[epub.Manifest](t, epubManifestAgain); again.Format != epub.FormatEPUB {
		t.Fatalf("二次 EPUB manifest format = %q", again.Format)
	}
	epubResourceAgain := env.request(http.MethodGet, epubResourceURL, "", "")
	if epubResourceAgain.Code != http.StatusOK {
		t.Fatalf("二次 EPUB resource status = %d, body=%s",
			epubResourceAgain.Code, epubResourceAgain.Body.String())
	}
}

// TestServerReaderDispatchCBRBoundaries 验证 CBR 可读样本、旧版本冲突、未认证
// 门禁与无效归档的明确 409，而不是落回书库/SPA。
func TestServerReaderDispatchCBRBoundaries(t *testing.T) {
	env := newIntegratedTestEnv(t)

	stored := env.uploadReaderFile(t, "dispatch.cbr", comicFixture(t, "comic_rar4.rar"))
	if stored.BookID == nil {
		t.Fatal("CBR 上传未返回 bookId")
	}
	bookID := *stored.BookID
	detail := env.readerBookDetail(t, bookID)

	manifestRecorder := env.request(http.MethodGet,
		"/api/v1/books/"+bookID+"/manifest", "", "")
	if manifestRecorder.Code != http.StatusOK {
		t.Fatalf("CBR manifest status = %d, body=%s",
			manifestRecorder.Code, manifestRecorder.Body.String())
	}
	manifest := decodeData[comic.Manifest](t, manifestRecorder)
	if manifest.Format != comic.FormatCBR || manifest.FormatData.PageCount == 0 {
		t.Fatalf("CBR manifest = %+v", manifest)
	}
	page := manifest.FormatData.Pages[0]
	pageURL := "/api/v1/books/" + bookID + "/versions/" +
		detail.FileVersion + "/resources/" + page.ResourceID + "?variant=screen"
	if recorder := env.request(http.MethodGet, pageURL, "", ""); recorder.Code != http.StatusOK {
		t.Fatalf("CBR screen status = %d, body=%s", recorder.Code, recorder.Body.String())
	}

	staleVersion := strings.Repeat("f", 64)
	staleManifest := env.request(http.MethodGet,
		"/api/v1/books/"+bookID+"/manifest?fileVersion="+staleVersion, "", "")
	if staleManifest.Code != http.StatusConflict {
		t.Fatalf("CBR 旧 manifest status = %d, body=%s",
			staleManifest.Code, staleManifest.Body.String())
	}
	if code := decodeAPIError(t, staleManifest).Error.Code; code != "file_version_conflict" {
		t.Fatalf("CBR 旧 manifest code = %q", code)
	}
	staleResource := env.request(http.MethodGet,
		"/api/v1/books/"+bookID+"/versions/"+staleVersion+"/resources/"+page.ResourceID, "", "")
	if staleResource.Code != http.StatusConflict {
		t.Fatalf("CBR 旧资源 status = %d, body=%s",
			staleResource.Code, staleResource.Body.String())
	}

	encryptedStored := env.uploadReaderFile(t, "dispatch-encrypted.cbr",
		comicFixture(t, "comic_encrypted_rar5.rar"))
	encryptedID := *encryptedStored.BookID
	encryptedManifest := env.request(http.MethodGet,
		"/api/v1/books/"+encryptedID+"/manifest", "", "")
	if encryptedManifest.Code != http.StatusConflict {
		t.Fatalf("加密 CBR manifest status = %d, body=%s",
			encryptedManifest.Code, encryptedManifest.Body.String())
	}
	encryptedErr := decodeAPIError(t, encryptedManifest)
	if encryptedErr.Error.Code != "book_not_readable" ||
		errorDetails(t, encryptedManifest.Body.Bytes())["reason"] != "encrypted_archive" {
		t.Fatalf("加密 CBR 错误 = %+v", encryptedErr.Error)
	}

	unauthManifest := env.do(http.MethodGet,
		"/api/v1/books/"+bookID+"/manifest", "", "", func(request *http.Request) {
			request.Header.Del("Cookie")
		})
	if unauthManifest.Code != http.StatusUnauthorized {
		t.Fatalf("未认证 CBR manifest status = %d", unauthManifest.Code)
	}
	unauthResource := env.do(http.MethodGet, pageURL, "", "", func(request *http.Request) {
		request.Header.Del("Cookie")
	})
	if unauthResource.Code != http.StatusUnauthorized {
		t.Fatalf("未认证 CBR 资源 status = %d", unauthResource.Code)
	}
}

// TestServerReaderManifestCBRIndexFailureReasons 验证 books.status=error 的 CBR
// 不再被状态门禁统一改写成 index_failed：C6 能给出稳定归档原因时返回真实
// 409/503；归档可解析（无解析错误）时仍保留索引失败语义。
func TestServerReaderManifestCBRIndexFailureReasons(t *testing.T) {
	env := newIntegratedTestEnv(t)

	cases := []struct {
		name    string
		fixture string
		reason  string
	}{
		{"encrypted", "comic_encrypted_rar5.rar", "encrypted_archive"},
		{"multivolume", "comic_multi.part1.rar", "unsupported_archive"},
		{"unsafe", "comic_symlink_rar5.rar", "unsafe_archive"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			stored := env.uploadReaderFile(t, "error-"+test.name+".cbr",
				comicFixture(t, test.fixture))
			if stored.BookID == nil {
				t.Fatalf("CBR 上传未返回 bookId: %+v", stored)
			}
			bookID := *stored.BookID
			env.setPDFBookState(t, bookID, "error", "failed", 0)
			env.clearBookManifest(t, bookID)

			recorder := env.request(http.MethodGet,
				"/api/v1/books/"+bookID+"/manifest", "", "")
			if recorder.Code != http.StatusConflict {
				t.Fatalf("CBR error manifest status = %d, body=%s",
					recorder.Code, recorder.Body.String())
			}
			if code := decodeAPIError(t, recorder).Error.Code; code != "book_not_readable" {
				t.Fatalf("CBR error manifest code = %q", code)
			}
			if got := errorDetails(t, recorder.Body.Bytes())["reason"]; got != test.reason {
				t.Fatalf("CBR error manifest reason = %v, want %q（index_failed 会掩盖真实原因）",
					got, test.reason)
			}
		})
	}

	t.Run("parseable original keeps index_failed", func(t *testing.T) {
		stored := env.uploadReaderFile(t, "error-parseable.cbr",
			comicFixture(t, "comic_rar4.rar"))
		if stored.BookID == nil {
			t.Fatalf("CBR 上传未返回 bookId: %+v", stored)
		}
		bookID := *stored.BookID
		env.setPDFBookState(t, bookID, "error", "failed", 0)
		env.clearBookManifest(t, bookID)

		recorder := env.request(http.MethodGet,
			"/api/v1/books/"+bookID+"/manifest", "", "")
		if recorder.Code != http.StatusConflict {
			t.Fatalf("可解析但索引失败 manifest status = %d, body=%s",
				recorder.Code, recorder.Body.String())
		}
		if code := decodeAPIError(t, recorder).Error.Code; code != "book_not_readable" {
			t.Fatalf("可解析但索引失败 manifest code = %q", code)
		}
		if got := errorDetails(t, recorder.Body.Bytes())["reason"]; got != "index_failed" {
			t.Fatalf("可解析但索引失败 manifest reason = %v, want index_failed", got)
		}
	})
}

// TestServerReaderManifestStateMatrix 验证 EPUB/CBZ/CBR 与 PDF 一致的状态门禁：
// indexing=200/not_ready、ready=200/canRead、error=409/index_failed、
// 永久 unsupported 返回格式原因；CBR unsupported 仍交给真实解析器判定。
func TestServerReaderManifestStateMatrix(t *testing.T) {
	env := newIntegratedTestEnv(t)

	epubSample, err := epubtest.Build(epubtest.Options{Version: 3})
	if err != nil {
		t.Fatalf("生成 EPUB 样本: %v", err)
	}
	epubStored := env.uploadReaderFile(t, "matrix.epub", epubSample.Data)
	cbzStored := env.uploadReaderFile(t, "matrix.cbz", buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{
		{"page1.jpg", comicFixture(t, "page1.jpg")},
		{"page2.jpg", comicFixture(t, "page2.jpg")},
	}))
	cbrStored := env.uploadReaderFile(t, "matrix.cbr", comicFixture(t, "comic_rar4.rar"))
	if epubStored.BookID == nil || cbzStored.BookID == nil || cbrStored.BookID == nil {
		t.Fatalf("上传未返回 bookId: epub=%+v cbz=%+v cbr=%+v", epubStored, cbzStored, cbrStored)
	}
	epubID, cbzID, cbrID := *epubStored.BookID, *cbzStored.BookID, *cbrStored.BookID

	assertManifestState := func(t *testing.T, name, bookID, status, extraction string,
		wantCode int, wantCanRead bool, wantReason string) {
		t.Helper()
		env.setPDFBookState(t, bookID, status, extraction, 0)
		recorder := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/manifest", "", "")
		if recorder.Code != wantCode {
			t.Fatalf("%s status = %d, body=%s", name, recorder.Code, recorder.Body.String())
		}
		if wantCode == http.StatusConflict {
			if code := decodeAPIError(t, recorder).Error.Code; code != "book_not_readable" {
				t.Fatalf("%s code = %q", name, code)
			}
			if got := errorDetails(t, recorder.Body.Bytes())["reason"]; got != wantReason {
				t.Fatalf("%s reason = %v, want %q", name, got, wantReason)
			}
			return
		}
		var envelope struct {
			Data struct {
				ReadingCapabilities struct {
					CanRead           bool     `json:"canRead"`
					UnavailableReason string   `json:"unavailableReason"`
					Features          []string `json:"features"`
				} `json:"readingCapabilities"`
			} `json:"data"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("%s 解析 manifest 失败: %v, body=%s", name, err, recorder.Body.String())
		}
		capabilities := envelope.Data.ReadingCapabilities
		if capabilities.CanRead != wantCanRead ||
			capabilities.UnavailableReason != wantReason {
			t.Fatalf("%s capabilities = %+v, want canRead=%v reason=%q",
				name, capabilities, wantCanRead, wantReason)
		}
	}

	// 索引中：三种格式都返回 200 + canRead=false/not_ready，让 UI 等待任务。
	assertManifestState(t, "EPUB indexing", epubID, "indexing", "pending",
		http.StatusOK, false, "not_ready")
	assertManifestState(t, "CBZ indexing", cbzID, "indexing", "pending",
		http.StatusOK, false, "not_ready")
	assertManifestState(t, "CBR indexing", cbrID, "indexing", "pending",
		http.StatusOK, false, "not_ready")

	// CBR unsupported 但 RAR4 可解析：清掉缓存后必须真实解析并允许 200。
	env.clearBookManifest(t, cbrID)
	assertManifestState(t, "CBR unsupported parseable", cbrID, "unsupported", "unsupported",
		http.StatusOK, true, "")

	// ready：三种格式均 200 + canRead=true。
	assertManifestState(t, "EPUB ready", epubID, "ready", "ok",
		http.StatusOK, true, "")
	assertManifestState(t, "CBZ ready", cbzID, "ready", "ok",
		http.StatusOK, true, "")
	assertManifestState(t, "CBR ready", cbrID, "ready", "ok",
		http.StatusOK, true, "")

	// 索引失败：三种格式均 409 + index_failed。
	assertManifestState(t, "EPUB error", epubID, "error", "failed",
		http.StatusConflict, false, "index_failed")
	assertManifestState(t, "CBZ error", cbzID, "error", "failed",
		http.StatusConflict, false, "index_failed")
	assertManifestState(t, "CBR error", cbrID, "error", "failed",
		http.StatusConflict, false, "index_failed")

	// 永久不可读：EPUB/CBZ 返回格式原因，CBR 仍由解析器判定。
	assertManifestState(t, "EPUB DRM", epubID, "unsupported", "unsupported",
		http.StatusConflict, false, "drm_protected")
	assertManifestState(t, "CBZ unsupported", cbzID, "unsupported", "unsupported",
		http.StatusConflict, false, "unsupported_archive")

	// 旧 fileVersion 对三种格式都返回 409 file_version_conflict。
	for _, test := range []struct {
		name   string
		bookID string
	}{
		{"EPUB", epubID},
		{"CBZ", cbzID},
		{"CBR", cbrID},
	} {
		t.Run(test.name+" stale fileVersion", func(t *testing.T) {
			env.setPDFBookState(t, test.bookID, "ready", "ok", 0)
			stale := strings.Repeat("f", 64)
			recorder := env.request(http.MethodGet,
				"/api/v1/books/"+test.bookID+"/manifest?fileVersion="+stale, "", "")
			if recorder.Code != http.StatusConflict {
				t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
			}
			if code := decodeAPIError(t, recorder).Error.Code; code != "file_version_conflict" {
				t.Fatalf("code = %q", code)
			}
		})
	}
}

// TestServerReaderDispatchPDFManifest 验证 PDF 最小 manifest 的字段、可读边界
// 与 content/Range，仍由 PDF 专属 /content 提供原件。
func TestServerReaderDispatchPDFManifest(t *testing.T) {
	env := newIntegratedTestEnv(t)

	pdfData := make([]byte, 200000)
	copy(pdfData, "%PDF-1.7\n")
	for i := len("%PDF-1.7\n"); i < len(pdfData); i++ {
		pdfData[i] = byte(i % 251)
	}
	stored := env.uploadReaderFile(t, "dispatch.pdf", pdfData)
	if stored.BookID == nil {
		t.Fatal("PDF 上传未返回 bookId")
	}
	bookID := *stored.BookID
	detail := env.readerBookDetail(t, bookID)

	type pdfManifestResponse struct {
		SchemaVersion       int    `json:"schemaVersion"`
		BookID              string `json:"bookId"`
		FileVersion         string `json:"fileVersion"`
		Format              string `json:"format"`
		IndexVersion        int64  `json:"indexVersion"`
		ReadingCapabilities struct {
			CanRead           bool     `json:"canRead"`
			UnavailableReason string   `json:"unavailableReason"`
			Features          []string `json:"features"`
		} `json:"readingCapabilities"`
		TOC        []any `json:"toc"`
		FormatData struct {
			ContentHref string `json:"contentHref"`
			ByteSize    int64  `json:"byteSize"`
			ETag        string `json:"etag"`
			PageCount   int64  `json:"pageCount"`
		} `json:"formatData"`
	}

	manifestURL := "/api/v1/books/" + bookID + "/manifest"
	manifestRecorder := env.request(http.MethodGet, manifestURL, "", "")
	if manifestRecorder.Code != http.StatusOK {
		t.Fatalf("PDF manifest status = %d, body=%s",
			manifestRecorder.Code, manifestRecorder.Body.String())
	}
	manifest := decodeData[pdfManifestResponse](t, manifestRecorder)
	wantHref := "/api/v1/books/" + bookID + "/versions/" + detail.FileVersion + "/content"
	if manifest.SchemaVersion != 1 || manifest.BookID != bookID ||
		manifest.FileVersion != detail.FileVersion || manifest.Format != "pdf" {
		t.Fatalf("PDF manifest 身份字段 = %+v", manifest)
	}
	if manifest.ReadingCapabilities.CanRead {
		t.Fatalf("indexing PDF 不应可读: %+v", manifest.ReadingCapabilities)
	}
	if manifest.ReadingCapabilities.UnavailableReason != "not_ready" {
		t.Fatalf("indexing PDF reason = %q", manifest.ReadingCapabilities.UnavailableReason)
	}
	if len(manifest.ReadingCapabilities.Features) != 3 ||
		manifest.ReadingCapabilities.Features[0] != "bookmarks" ||
		manifest.ReadingCapabilities.Features[1] != "settings" ||
		manifest.ReadingCapabilities.Features[2] != "text-selection" {
		t.Fatalf("PDF features = %v", manifest.ReadingCapabilities.Features)
	}
	if manifest.TOC == nil || len(manifest.TOC) != 0 {
		t.Fatalf("PDF toc = %#v", manifest.TOC)
	}
	wantPageCount := int64(0)
	if detail.Metadata != nil && detail.Metadata.PageCount != nil {
		wantPageCount = *detail.Metadata.PageCount
	}
	if manifest.FormatData.ContentHref != wantHref ||
		manifest.FormatData.ByteSize != int64(len(pdfData)) ||
		manifest.FormatData.ETag != `"`+detail.FileVersion+`"` ||
		manifest.FormatData.PageCount != wantPageCount {
		t.Fatalf("PDF formatData = %+v, want pageCount=%d", manifest.FormatData, wantPageCount)
	}

	env.setPDFBookState(t, bookID, "ready", "ok", 7)
	readyRecorder := env.request(http.MethodGet, manifestURL, "", "")
	if readyRecorder.Code != http.StatusOK {
		t.Fatalf("ready PDF manifest status = %d, body=%s",
			readyRecorder.Code, readyRecorder.Body.String())
	}
	readyManifest := decodeData[pdfManifestResponse](t, readyRecorder)
	if !readyManifest.ReadingCapabilities.CanRead ||
		readyManifest.ReadingCapabilities.UnavailableReason != "" ||
		readyManifest.FormatData.PageCount != 7 {
		t.Fatalf("ready PDF manifest = %+v", readyManifest)
	}

	pdfURL := "/api/v1/books/" + bookID + "/versions/" + detail.FileVersion + "/content"
	rangeRecorder := env.do(http.MethodGet, pdfURL, "", "", func(request *http.Request) {
		request.Header.Set("Range", "bytes=0-8")
	})
	if rangeRecorder.Code != http.StatusPartialContent || rangeRecorder.Body.String() != "%PDF-1.7\n" {
		t.Fatalf("PDF Range status=%d body=%q",
			rangeRecorder.Code, rangeRecorder.Body.String())
	}
	resourceRecorder := env.request(http.MethodGet,
		"/api/v1/books/"+bookID+"/versions/"+detail.FileVersion+"/resources/"+
			strings.Repeat("a", 32), "", "")
	if resourceRecorder.Code != http.StatusNotFound {
		t.Fatalf("PDF /resources status = %d, body=%s",
			resourceRecorder.Code, resourceRecorder.Body.String())
	}

	env.setPDFBookState(t, bookID, "unsupported", "unsupported", 0)
	blockedRecorder := env.request(http.MethodGet, manifestURL, "", "")
	if blockedRecorder.Code != http.StatusConflict {
		t.Fatalf("unsupported PDF manifest status = %d, body=%s",
			blockedRecorder.Code, blockedRecorder.Body.String())
	}
	blockedErr := decodeAPIError(t, blockedRecorder)
	if blockedErr.Error.Code != "book_not_readable" ||
		errorDetails(t, blockedRecorder.Body.Bytes())["reason"] != "pdf_encrypted" {
		t.Fatalf("unsupported PDF error = %+v", blockedErr.Error)
	}

	env.setPDFBookState(t, bookID, "error", "failed", 0)
	failedRecorder := env.request(http.MethodGet, manifestURL, "", "")
	if failedRecorder.Code != http.StatusConflict {
		t.Fatalf("index_failed PDF manifest status = %d, body=%s",
			failedRecorder.Code, failedRecorder.Body.String())
	}
	failedErr := decodeAPIError(t, failedRecorder)
	if failedErr.Error.Code != "book_not_readable" ||
		errorDetails(t, failedRecorder.Body.Bytes())["reason"] != "index_failed" {
		t.Fatalf("index_failed PDF error = %+v", failedErr.Error)
	}

	// ready 但元数据被标记 unsupported 时，仍按加密/不可读处理，不能误报可读。
	env.setPDFBookState(t, bookID, "ready", "unsupported", 0)
	readyUnsupported := env.request(http.MethodGet, manifestURL, "", "")
	if readyUnsupported.Code != http.StatusConflict {
		t.Fatalf("ready+unsupported PDF manifest status = %d, body=%s",
			readyUnsupported.Code, readyUnsupported.Body.String())
	}
	readyUnsupportedErr := decodeAPIError(t, readyUnsupported)
	if readyUnsupportedErr.Error.Code != "book_not_readable" ||
		errorDetails(t, readyUnsupported.Body.Bytes())["reason"] != "pdf_encrypted" {
		t.Fatalf("ready+unsupported PDF error = %+v", readyUnsupportedErr.Error)
	}

	staleVersion := strings.Repeat("e", 64)
	staleRecorder := env.request(http.MethodGet, manifestURL+"?fileVersion="+staleVersion, "", "")
	if staleRecorder.Code != http.StatusConflict {
		t.Fatalf("PDF 旧 manifest status = %d, body=%s",
			staleRecorder.Code, staleRecorder.Body.String())
	}
}

// TestServerReaderDispatchRouteErrors 验证未知路径仍是 JSON 404，且写请求的
// CSRF 门禁没有因为 dispatcher 改动而绕过。
func TestServerReaderDispatchRouteErrors(t *testing.T) {
	env := newIntegratedTestEnv(t)

	unknownManifest := env.request(http.MethodGet,
		"/api/v1/books/"+strings.Repeat("0", 32)+"/manifest", "", "")
	if unknownManifest.Code != http.StatusNotFound {
		t.Fatalf("未知 manifest status = %d, body=%s",
			unknownManifest.Code, unknownManifest.Body.String())
	}
	if contentType := unknownManifest.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("未知 manifest Content-Type = %q", contentType)
	}
	unknownResource := env.request(http.MethodGet,
		"/api/v1/books/"+strings.Repeat("0", 32)+"/versions/"+
			strings.Repeat("0", 64)+"/resources/"+strings.Repeat("0", 32), "", "")
	if unknownResource.Code != http.StatusNotFound {
		t.Fatalf("未知资源 status = %d, body=%s",
			unknownResource.Code, unknownResource.Body.String())
	}
	extraPath := env.request(http.MethodGet,
		"/api/v1/books/"+strings.Repeat("0", 32)+"/versions/"+
			strings.Repeat("0", 64)+"/resources/"+strings.Repeat("0", 32)+"/extra", "", "")
	if extraPath.Code != http.StatusNotFound {
		t.Fatalf("多余资源段 status = %d, body=%s", extraPath.Code, extraPath.Body.String())
	}
	if contentType := extraPath.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("多余资源段 Content-Type = %q", contentType)
	}

	postManifest := env.do(http.MethodPost,
		"/api/v1/books/"+strings.Repeat("0", 32)+"/manifest", "", "",
		func(request *http.Request) { request.Header.Del(csrfHeaderName) })
	if postManifest.Code != http.StatusForbidden {
		t.Fatalf("POST manifest 无 CSRF status = %d, body=%s",
			postManifest.Code, postManifest.Body.String())
	}
}
