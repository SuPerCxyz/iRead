package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"iread/server/internal/reader/epub"
	"iread/server/internal/reader/epub/epubtest"
)

func (e *testEnv) uploadReaderFile(t *testing.T, fileName string, data []byte) uploadDTO {
	t.Helper()
	body := fmt.Sprintf(`{"clientUploadId":%q,"fileName":%q,"byteSize":%d}`,
		"reader-integration-"+fileName, fileName, len(data))
	recorder := e.request(http.MethodPost, "/api/v1/uploads", body, "application/json")
	if recorder.Code != http.StatusCreated {
		t.Fatalf("创建 %s 上传意图 status = %d, body=%s", fileName, recorder.Code, recorder.Body.String())
	}
	intent := decodeData[uploadDTO](t, recorder)
	recorder = e.request(http.MethodPut, "/api/v1/uploads/"+intent.UploadID+"/content",
		string(data), "application/octet-stream")
	if recorder.Code != http.StatusOK {
		t.Fatalf("上传 %s status = %d, body=%s", fileName, recorder.Code, recorder.Body.String())
	}
	return decodeData[uploadDTO](t, recorder)
}

func (e *testEnv) readerBookDetail(t *testing.T, bookID string) bookDetailDTO {
	t.Helper()
	recorder := e.request(http.MethodGet, "/api/v1/books/"+bookID, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("读取书籍详情 status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	return decodeData[bookDetailDTO](t, recorder)
}

func TestServerReaderRoutesIntegration(t *testing.T) {
	env := newIntegratedTestEnv(t)
	sample, err := epubtest.Build(epubtest.Options{Version: 3})
	if err != nil {
		t.Fatalf("生成 EPUB 样本: %v", err)
	}

	stored := env.uploadReaderFile(t, "reader.epub", sample.Data)
	if stored.BookID == nil {
		t.Fatal("EPUB 上传未返回 bookId")
	}
	bookID := *stored.BookID
	detail := env.readerBookDetail(t, bookID)
	fileVersion := detail.FileVersion
	if len(fileVersion) != 64 {
		t.Fatalf("fileVersion = %q", fileVersion)
	}

	manifestRecorder := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/manifest", "", "")
	if manifestRecorder.Code != http.StatusOK {
		t.Fatalf("manifest status = %d, body=%s", manifestRecorder.Code, manifestRecorder.Body.String())
	}
	manifest := decodeData[epub.Manifest](t, manifestRecorder)
	if manifest.BookID != bookID || manifest.FileVersion != fileVersion || manifest.Format != "epub" {
		t.Fatalf("manifest = %+v", manifest)
	}
	if len(manifest.FormatData.Spine) == 0 || manifest.FormatData.Spine[0].ResourceID == "" {
		t.Fatalf("manifest spine 为空: %+v", manifest.FormatData.Spine)
	}

	resourceID := manifest.FormatData.Spine[0].ResourceID
	resourceURL := "/api/v1/books/" + bookID + "/versions/" + fileVersion + "/resources/" + resourceID
	resource := env.request(http.MethodGet, resourceURL, "", "")
	if resource.Code != http.StatusOK {
		t.Fatalf("resource status = %d, body=%s", resource.Code, resource.Body.String())
	}
	if !strings.Contains(resource.Body.String(), "Chapter 1") {
		t.Fatalf("resource body 不含章节内容: %s", resource.Body.String())
	}

	staleVersion := strings.Repeat("f", 64)
	staleManifest := env.request(http.MethodGet,
		"/api/v1/books/"+bookID+"/manifest?fileVersion="+staleVersion, "", "")
	if staleManifest.Code != http.StatusConflict {
		t.Fatalf("旧 fileVersion manifest status = %d, body=%s", staleManifest.Code, staleManifest.Body.String())
	}
	if decodeAPIError(t, staleManifest).Error.Code != "file_version_conflict" {
		t.Fatalf("旧 fileVersion manifest code = %q", decodeAPIError(t, staleManifest).Error.Code)
	}
	staleResourceURL := "/api/v1/books/" + bookID + "/versions/" + staleVersion + "/resources/" + resourceID
	staleResource := env.request(http.MethodGet, staleResourceURL, "", "")
	if staleResource.Code != http.StatusConflict {
		t.Fatalf("旧 fileVersion resource status = %d, body=%s", staleResource.Code, staleResource.Body.String())
	}
	if decodeAPIError(t, staleResource).Error.Code != "file_version_conflict" {
		t.Fatalf("旧 fileVersion resource code = %q", decodeAPIError(t, staleResource).Error.Code)
	}

	locator := fmt.Sprintf(`{"locatorVersion":1,"spineIndex":0,"chapterProgress":0.1,`+
		`"resourceId":%q,"cfi":"epubcfi(/6/4[ch1]!/4/2/1:0)"}`, resourceID)
	progressBody := fmt.Sprintf(`{"schemaVersion":1,"fileVersion":%q,"baseRevision":"0",`+
		`"clientMutationId":"reader-mut-1","format":"epub","locatorType":"epub-cfi",`+
		`"locatorPayload":%s,"progressPercent":10}`, fileVersion, locator)
	progressRecorder := env.request(http.MethodPut, "/api/v1/books/"+bookID+"/progress", progressBody, "application/json")
	if progressRecorder.Code != http.StatusOK {
		t.Fatalf("PUT progress status = %d, body=%s", progressRecorder.Code, progressRecorder.Body.String())
	}
	progress := decodeData[map[string]any](t, progressRecorder)
	if progress["revision"] != "1" || progress["fileVersion"] != fileVersion {
		t.Fatalf("progress = %+v", progress)
	}
	getProgress := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/progress", "", "")
	if getProgress.Code != http.StatusOK {
		t.Fatalf("GET progress status = %d", getProgress.Code)
	}
	if got := decodeData[map[string]any](t, getProgress); got["revision"] != "1" {
		t.Fatalf("GET progress = %+v", got)
	}
	staleProgressBody := strings.Replace(progressBody, fileVersion, staleVersion, 1)
	staleProgress := env.request(http.MethodPut, "/api/v1/books/"+bookID+"/progress", staleProgressBody, "application/json")
	if staleProgress.Code != http.StatusConflict {
		t.Fatalf("旧 fileVersion progress status = %d, body=%s", staleProgress.Code, staleProgress.Body.String())
	}

	bookmarkBody := fmt.Sprintf(`{"schemaVersion":1,"fileVersion":%q,"format":"epub",`+
		`"locatorType":"epub-cfi","locatorPayload":%s,"clientMutationId":"bookmark-mut-1","label":"联调书签"}`,
		fileVersion, locator)
	bookmarkRecorder := env.request(http.MethodPost, "/api/v1/books/"+bookID+"/bookmarks", bookmarkBody, "application/json")
	if bookmarkRecorder.Code != http.StatusCreated {
		t.Fatalf("POST bookmark status = %d, body=%s", bookmarkRecorder.Code, bookmarkRecorder.Body.String())
	}
	var bookmark struct {
		Data struct {
			BookmarkID string `json:"bookmarkId"`
			Revision   string `json:"revision"`
		} `json:"data"`
	}
	if err := json.Unmarshal(bookmarkRecorder.Body.Bytes(), &bookmark); err != nil {
		t.Fatal(err)
	}
	if bookmark.Data.BookmarkID == "" || bookmark.Data.Revision != "1" {
		t.Fatalf("bookmark = %+v", bookmark)
	}
	list := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/bookmarks", "", "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), bookmark.Data.BookmarkID) {
		t.Fatalf("GET bookmarks status=%d body=%s", list.Code, list.Body.String())
	}
	deleteBookmark := env.do(http.MethodDelete,
		"/api/v1/books/"+bookID+"/bookmarks/"+bookmark.Data.BookmarkID, "", "", func(request *http.Request) {
			request.Header.Set("If-Match", `"1"`)
		})
	if deleteBookmark.Code != http.StatusNoContent {
		t.Fatalf("DELETE bookmark status = %d, body=%s", deleteBookmark.Code, deleteBookmark.Body.String())
	}

	settingsRecorder := env.request(http.MethodGet, "/api/v1/settings/reader", "", "")
	if settingsRecorder.Code != http.StatusOK {
		t.Fatalf("GET reader settings status = %d, body=%s", settingsRecorder.Code, settingsRecorder.Body.String())
	}
	settingsPut := env.request(http.MethodPut, "/api/v1/settings/reader",
		`{"schemaVersion":1,"baseRevision":"0","value":{"reflow":{"fontSize":20}}}`, "application/json")
	if settingsPut.Code != http.StatusOK {
		t.Fatalf("PUT reader settings status = %d, body=%s", settingsPut.Code, settingsPut.Body.String())
	}

	bookSettingsURL := "/api/v1/books/" + bookID + "/reader-settings"
	bookSettings := env.request(http.MethodGet, bookSettingsURL, "", "")
	if bookSettings.Code != http.StatusOK {
		t.Fatalf("GET book reader settings status = %d, body=%s", bookSettings.Code, bookSettings.Body.String())
	}
	bookSettingsBody := fmt.Sprintf(`{"schemaVersion":1,"fileVersion":%q,"baseRevision":"0",`+
		`"overrides":{"reflow":{"fontSize":21}}}`, fileVersion)
	bookSettingsPut := env.request(http.MethodPut, bookSettingsURL, bookSettingsBody, "application/json")
	if bookSettingsPut.Code != http.StatusOK {
		t.Fatalf("PUT book reader settings status = %d, body=%s", bookSettingsPut.Code, bookSettingsPut.Body.String())
	}
	legacyOverrides := env.request(http.MethodGet, "/api/v1/books/"+bookID+"/reader-overrides", "", "")
	if legacyOverrides.Code != http.StatusOK {
		t.Fatalf("GET legacy reader-overrides status = %d, body=%s", legacyOverrides.Code, legacyOverrides.Body.String())
	}

	// 外层 apiGuard 与 handler 内 CSRF 只校验一次；缺 CSRF 仍应是 403。
	noCSRF := env.do(http.MethodPut, "/api/v1/books/"+bookID+"/progress", progressBody, "application/json",
		func(request *http.Request) { request.Header.Del(csrfHeaderName) })
	if noCSRF.Code != http.StatusForbidden {
		t.Fatalf("无 CSRF progress status = %d, body=%s", noCSRF.Code, noCSRF.Body.String())
	}

	// PDF 原件流与 Range；使用真实登记文件与同一认证门禁。
	pdfData := make([]byte, 200000)
	copy(pdfData, "%PDF-1.7\n")
	for i := len("%PDF-1.7\n"); i < len(pdfData); i++ {
		pdfData[i] = byte(i % 251)
	}
	pdfStored := env.uploadReaderFile(t, "reader.pdf", pdfData)
	pdfID := *pdfStored.BookID
	pdfDetail := env.readerBookDetail(t, pdfID)
	pdfURL := "/api/v1/books/" + pdfID + "/versions/" + pdfDetail.FileVersion + "/content"
	pdfRange := env.do(http.MethodGet, pdfURL, "", "", func(request *http.Request) {
		request.Header.Set("Range", "bytes=0-8")
	})
	if pdfRange.Code != http.StatusPartialContent {
		t.Fatalf("PDF Range status = %d, body=%s", pdfRange.Code, pdfRange.Body.String())
	}
	if pdfRange.Body.String() != "%PDF-1.7\n" {
		t.Fatalf("PDF Range body = %q", pdfRange.Body.String())
	}

	// 未认证请求必须 401，不能落回 SPA；放在最后避免清理测试会话 Cookie。
	unauth := env.do(http.MethodGet, "/api/v1/books/"+bookID+"/manifest", "", "", func(request *http.Request) {
		request.Header.Del("Cookie")
	})
	if unauth.Code != http.StatusUnauthorized {
		t.Fatalf("未认证 manifest status = %d, body=%s", unauth.Code, unauth.Body.String())
	}
	if decodeAPIError(t, unauth).Error.Code != "unauthenticated" {
		t.Fatalf("未认证 manifest code = %q", decodeAPIError(t, unauth).Error.Code)
	}
}
