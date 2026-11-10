package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestReaderProgressLifecycleAndConflicts(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("epub")
	target := "/api/v1/books/" + bookID + "/progress"

	empty := api.request(http.MethodGet, target, "", true, false, nil)
	if empty.Code != http.StatusOK {
		t.Fatalf("空进度 GET = %d, body=%s", empty.Code, empty.Body.String())
	}
	if data := decodeProgressPointer(t, empty); data != nil {
		t.Fatalf("空进度 data = %+v，期望 null", data)
	}

	body := `{"schemaVersion":1,"fileVersion":"` + fileVersion + `","baseRevision":"0",` +
		`"clientMutationId":"mut-1","format":"epub","locatorType":"epub-cfi",` +
		`"locatorPayload":` + epubCFIPayload("epubcfi(/6/8!/4/2/2:0)") + `,"progressPercent":42.5}`
	created := api.request(http.MethodPut, target, body, true, true, nil)
	if created.Code != http.StatusOK {
		t.Fatalf("首次 PUT = %d, body=%s", created.Code, created.Body.String())
	}
	first := decodeProgressPointer(t, created)
	if first == nil || first.Revision != "1" || first.BookID != bookID ||
		first.FileVersion != fileVersion || first.Format != "epub" ||
		first.LocatorType != "epub-cfi" || first.ProgressPercent != 42.5 {
		t.Fatalf("首次进度 DTO = %+v", first)
	}
	if first.UpdatedAt == "" {
		t.Fatal("首次进度缺少 updatedAt")
	}

	replayed := api.request(http.MethodPut, target, body, true, true, nil)
	if replayed.Code != http.StatusOK {
		t.Fatalf("幂等 PUT = %d, body=%s", replayed.Code, replayed.Body.String())
	}
	second := decodeProgressPointer(t, replayed)
	if second == nil || second.Revision != "1" || second.UpdatedAt != first.UpdatedAt {
		t.Fatalf("幂等结果 = %+v，期望 revision 1 且时间不变", second)
	}

	staleBody := strings.Replace(body, `"baseRevision":"0"`, `"baseRevision":"0"`, 1)
	staleBody = strings.Replace(staleBody, `"clientMutationId":"mut-1"`, `"clientMutationId":"mut-2"`, 1)
	stale := api.request(http.MethodPut, target, staleBody, true, true, nil)
	if stale.Code != http.StatusConflict {
		t.Fatalf("旧 revision PUT = %d, body=%s", stale.Code, stale.Body.String())
	}
	apiErr := decodeAPIError(t, stale)
	if apiErr.Error.Code != "revision_conflict" {
		t.Fatalf("旧 revision code = %q", apiErr.Error.Code)
	}
	var details struct {
		Current *progressDTOAlias `json:"current"`
	}
	if err := json.Unmarshal(apiErr.Error.Details, &details); err != nil {
		t.Fatalf("解析 conflict details: %v", err)
	}
	if details.Current == nil || details.Current.Revision != "1" {
		t.Fatalf("revision_conflict current = %+v", details.Current)
	}

	stateBody := strings.Replace(body, `"progressPercent":42.5`, `"progressPercent":43.5`, 1)
	state := api.request(http.MethodPut, target, stateBody, true, true, nil)
	if state.Code != http.StatusConflict || decodeAPIError(t, state).Error.Code != "state_conflict" {
		t.Fatalf("同 mutationId 不同 body = %d, body=%s", state.Code, state.Body.String())
	}

	get := api.request(http.MethodGet, target, "", true, false, nil)
	if got := decodeProgressPointer(t, get); got == nil || got.Revision != "1" {
		t.Fatalf("GET 进度 = %+v", got)
	}

	nextBody := strings.Replace(body, `"baseRevision":"0"`, `"baseRevision":"1"`, 1)
	nextBody = strings.Replace(nextBody, `"clientMutationId":"mut-1"`, `"clientMutationId":"mut-3"`, 1)
	nextBody = strings.Replace(nextBody, `"progressPercent":42.5`, `"progressPercent":50`, 1)
	next := api.request(http.MethodPut, target, nextBody, true, true, nil)
	if next.Code != http.StatusOK {
		t.Fatalf("revision 2 PUT = %d, body=%s", next.Code, next.Body.String())
	}
	if nextDTO := decodeProgressPointer(t, next); nextDTO == nil || nextDTO.Revision != "2" || nextDTO.ProgressPercent != 50 {
		t.Fatalf("revision 2 结果 = %+v", nextDTO)
	}

	badPercent := strings.Replace(body, `"progressPercent":42.5`, `"progressPercent":101`, 1)
	if code := api.request(http.MethodPut, target, badPercent, true, true, nil).Code; code != http.StatusBadRequest {
		t.Fatalf("progressPercent 101 = %d", code)
	}
	badRevision := strings.Replace(body, `"baseRevision":"0"`, `"baseRevision":"01"`, 1)
	if code := api.request(http.MethodPut, target, badRevision, true, true, nil).Code; code != http.StatusBadRequest {
		t.Fatalf("baseRevision 01 = %d", code)
	}
}

func TestReaderProgressRejectsWrongOriginalAndLocator(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("epub")
	target := "/api/v1/books/" + bookID + "/progress"

	makeBody := func(fileVersion, format, locatorType, payload string) string {
		return fmt.Sprintf(`{"schemaVersion":1,"fileVersion":%q,"baseRevision":"0",`+
			`"clientMutationId":"mut","format":%q,"locatorType":%q,`+
			`"locatorPayload":%s,"progressPercent":10}`, fileVersion, format, locatorType, payload)
	}

	wrongVersion := api.request(http.MethodPut, target,
		makeBody(strings.Repeat("b", 64), "epub", "epub-cfi", epubCFIPayload("epubcfi(/6/8!/4/2/2:0)")),
		true, true, nil)
	if wrongVersion.Code != http.StatusConflict || decodeAPIError(t, wrongVersion).Error.Code != "file_version_conflict" {
		t.Fatalf("fileVersion 失配 = %d, body=%s", wrongVersion.Code, wrongVersion.Body.String())
	}

	wrongFormat := api.request(http.MethodPut, target,
		makeBody(fileVersion, "pdf", "pdf-page", `{"locatorVersion":1,"page":1,"pageOffset":0}`),
		true, true, nil)
	if wrongFormat.Code != http.StatusUnprocessableEntity || decodeAPIError(t, wrongFormat).Error.Code != "unsupported_locator" {
		t.Fatalf("format 失配 = %d, body=%s", wrongFormat.Code, wrongFormat.Body.String())
	}

	wrongLocatorType := api.request(http.MethodPut, target,
		makeBody(fileVersion, "epub", "pdf-page", `{"locatorVersion":1,"page":1,"pageOffset":0}`),
		true, true, nil)
	if wrongLocatorType.Code != http.StatusUnprocessableEntity {
		t.Fatalf("locatorType 失配 = %d", wrongLocatorType.Code)
	}

	missingField := api.request(http.MethodPut, target,
		makeBody(fileVersion, "epub", "epub-cfi", `{"locatorVersion":1,"spineIndex":0,"cfi":"epubcfi(/6/2)"}`),
		true, true, nil)
	if missingField.Code != http.StatusUnprocessableEntity {
		t.Fatalf("缺少 chapterProgress = %d", missingField.Code)
	}

	arrayPayload := api.request(http.MethodPut, target,
		makeBody(fileVersion, "epub", "epub-cfi", `[]`), true, true, nil)
	if arrayPayload.Code != http.StatusUnprocessableEntity {
		t.Fatalf("数组 locator = %d", arrayPayload.Code)
	}

	unknown := api.request(http.MethodGet, "/api/v1/books/"+strings.Repeat("f", 32)+"/progress", "", true, false, nil)
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("未知书籍进度 = %d", unknown.Code)
	}

	unknownField := strings.Replace(
		makeBody(fileVersion, "epub", "epub-cfi", epubCFIPayload("epubcfi(/6/8!/4/2/2:0)")),
		`"progressPercent":10`, `"progressPercent":10,"updatedAt":"x"`, 1)
	if code := api.request(http.MethodPut, target, unknownField, true, true, nil).Code; code != http.StatusBadRequest {
		t.Fatalf("未知字段 = %d", code)
	}
}

func TestReaderProgressRequiresAuthAndCSRF(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("epub")
	target := "/api/v1/books/" + bookID + "/progress"

	if code := api.request(http.MethodGet, target, "", false, false, nil).Code; code != http.StatusUnauthorized {
		t.Fatalf("未认证 GET = %d", code)
	}
	body := fmt.Sprintf(`{"schemaVersion":1,"fileVersion":%q,"baseRevision":"0",`+
		`"clientMutationId":"mut","format":"epub","locatorType":"epub-cfi",`+
		`"locatorPayload":%s,"progressPercent":1}`, fileVersion, epubCFIPayload("epubcfi(/6/2/2:0)"))
	if code := api.request(http.MethodPut, target, body, true, false, nil).Code; code != http.StatusForbidden {
		t.Fatalf("缺 CSRF PUT = %d", code)
	}
	if code := api.request(http.MethodPut, target, body, false, true, nil).Code; code != http.StatusUnauthorized {
		t.Fatalf("未认证 PUT = %d", code)
	}
	huge := strings.Repeat(" ", readerMaxBodyBytes+1)
	if code := api.request(http.MethodPut, target, huge, true, true, nil).Code; code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超过 1 MiB = %d", code)
	}
	if code := api.request(http.MethodGet, "/api/v1/settings/reader", "", false, false, nil).Code; code != http.StatusUnauthorized {
		t.Fatalf("未认证设置 GET = %d", code)
	}
}
