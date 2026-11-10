package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func bookmarkCreateBody(fileVersion, cfi, mutationID, label string) string {
	labelField := ""
	if label != "" {
		labelField = `,"label":` + strconvQuote(label)
	}
	return fmt.Sprintf(`{"schemaVersion":1,"fileVersion":%q,"format":"epub",`+
		`"locatorType":"epub-cfi","locatorPayload":%s,"clientMutationId":%q%s}`,
		fileVersion, epubCFIPayload(cfi), mutationID, labelField)
}

func strconvQuote(value string) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

func TestReaderBookmarksLifecycleAndDedup(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("epub")
	collection := "/api/v1/books/" + bookID + "/bookmarks"

	body := bookmarkCreateBody(fileVersion, "epubcfi(/6/8!/4/2/2:0)", "bm-mut-1", "")
	created := api.request(http.MethodPost, collection, body, true, true, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("首次创建书签 = %d, body=%s", created.Code, created.Body.String())
	}
	var createdEnvelope struct {
		Data struct {
			BookmarkID string `json:"bookmarkId"`
			Label      string `json:"label"`
			Revision   string `json:"revision"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &createdEnvelope); err != nil {
		t.Fatal(err)
	}
	bookmarkID := createdEnvelope.Data.BookmarkID
	if bookmarkID == "" || createdEnvelope.Data.Revision != "1" || createdEnvelope.Data.Label != "示例文字" {
		t.Fatalf("创建结果 = %s", created.Body.String())
	}

	replayed := api.request(http.MethodPost, collection, body, true, true, nil)
	if replayed.Code != http.StatusOK {
		t.Fatalf("同 mutationId 重试 = %d", replayed.Code)
	}
	if !strings.Contains(replayed.Body.String(), bookmarkID) {
		t.Fatalf("重试未返回已有书签: %s", replayed.Body.String())
	}

	duplicate := api.request(http.MethodPost, collection,
		bookmarkCreateBody(fileVersion, "epubcfi(/6/8!/4/2/2:0)", "bm-mut-2", "另一个标签"), true, true, nil)
	if duplicate.Code != http.StatusOK {
		t.Fatalf("同 locator 重复创建 = %d, body=%s", duplicate.Code, duplicate.Body.String())
	}
	if !strings.Contains(duplicate.Body.String(), bookmarkID) {
		t.Fatalf("同 locator 未返回已有书签: %s", duplicate.Body.String())
	}

	list := api.request(http.MethodGet, collection, "", true, false, nil)
	if list.Code != http.StatusOK {
		t.Fatalf("书签列表 = %d, body=%s", list.Code, list.Body.String())
	}
	payload := decodeBookmarkList(t, list)
	if len(payload.Data) != 1 || payload.Data[0].BookmarkID != bookmarkID || payload.Meta.NextCursor != nil {
		t.Fatalf("书签列表 = %+v", payload)
	}

	withoutIfMatch := api.request(http.MethodDelete, collection+"/"+bookmarkID, "", true, true, nil)
	if withoutIfMatch.Code != http.StatusBadRequest {
		t.Fatalf("缺 If-Match = %d", withoutIfMatch.Code)
	}
	stale := api.request(http.MethodDelete, collection+"/"+bookmarkID, "", true, true, func(r *http.Request) {
		r.Header.Set("If-Match", `"2"`)
	})
	if stale.Code != http.StatusPreconditionFailed || decodeAPIError(t, stale).Error.Code != "precondition_failed" {
		t.Fatalf("过时 If-Match = %d, body=%s", stale.Code, stale.Body.String())
	}
	removed := api.request(http.MethodDelete, collection+"/"+bookmarkID, "", true, true, func(r *http.Request) {
		r.Header.Set("If-Match", `"1"`)
	})
	if removed.Code != http.StatusNoContent {
		t.Fatalf("删除书签 = %d, body=%s", removed.Code, removed.Body.String())
	}
	if removed.Body.Len() != 0 {
		t.Fatalf("204 不应带 body: %s", removed.Body.String())
	}
	again := api.request(http.MethodDelete, collection+"/"+bookmarkID, "", true, true, func(r *http.Request) {
		r.Header.Set("If-Match", `"1"`)
	})
	if again.Code != http.StatusNotFound {
		t.Fatalf("重复删除 = %d", again.Code)
	}

	// 只删书签：书籍与进度接口仍然可用。
	if code := api.request(http.MethodGet, "/api/v1/books/"+bookID+"/progress", "", true, false, nil).Code; code != http.StatusOK {
		t.Fatalf("删除书签后书籍不可用 = %d", code)
	}
}

func TestReaderBookmarkListOldVersionAndCursor(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("epub")
	collection := "/api/v1/books/" + bookID + "/bookmarks"

	for i, cfi := range []string{"epubcfi(/6/8!/4/2/2:0)", "epubcfi(/6/10!/4/2/2:0)"} {
		body := bookmarkCreateBody(fileVersion, cfi, fmt.Sprintf("bm-mut-%d", i), fmt.Sprintf("书签 %d", i+1))
		if code := api.request(http.MethodPost, collection, body, true, true, nil).Code; code != http.StatusCreated {
			t.Fatalf("创建书签 %d = %d", i, code)
		}
	}

	firstPage := api.request(http.MethodGet, collection+"?limit=1", "", true, false, nil)
	if firstPage.Code != http.StatusOK {
		t.Fatalf("分页第一页 = %d", firstPage.Code)
	}
	page := decodeBookmarkList(t, firstPage)
	if len(page.Data) != 1 || page.Meta.NextCursor == nil {
		t.Fatalf("分页第一页 = %+v", page)
	}
	secondPage := api.request(http.MethodGet, collection+"?limit=1&cursor="+*page.Meta.NextCursor, "", true, false, nil)
	if secondPage.Code != http.StatusOK {
		t.Fatalf("分页第二页 = %d, body=%s", secondPage.Code, secondPage.Body.String())
	}
	second := decodeBookmarkList(t, secondPage)
	if len(second.Data) != 1 || second.Data[0].BookmarkID == page.Data[0].BookmarkID {
		t.Fatalf("分页第二页 = %+v", second)
	}

	oldVersion := strings.Repeat("c", 64)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := api.db.Exec(`
		INSERT INTO bookmarks (
			bookmark_id, book_id, file_version, format, locator_type, locator_payload,
			locator_key, label, client_mutation_id, revision, created_at, updated_at
		) VALUES (?, ?, ?, 'epub', 'epub-cfi', ?, ?, '旧版本', 'bm-old', 1, ?, ?)`,
		strings.Repeat("d", 32), bookID, oldVersion,
		epubCFIPayload("epubcfi(/6/2!/4/2/2:0)"), strings.Repeat("e", 64), now, now); err != nil {
		t.Fatalf("插入旧版本书签: %v", err)
	}
	oldList := api.request(http.MethodGet, collection+"?fileVersion="+oldVersion, "", true, false, nil)
	if oldList.Code != http.StatusOK {
		t.Fatalf("旧版本书签列表 = %d, body=%s", oldList.Code, oldList.Body.String())
	}
	oldPayload := decodeBookmarkList(t, oldList)
	if len(oldPayload.Data) != 1 || oldPayload.Data[0].FileVersion != oldVersion || oldPayload.Data[0].Label != "旧版本" {
		t.Fatalf("旧版本书签 = %+v", oldPayload)
	}
	currentList := api.request(http.MethodGet, collection, "", true, false, nil)
	if current := decodeBookmarkList(t, currentList); len(current.Data) != 2 {
		t.Fatalf("当前版本列表 = %+v", current)
	}
}

func TestReaderBookmarkValidation(t *testing.T) {
	api := newReaderAPIEnv(t)
	bookID, fileVersion := api.insertBook("epub")
	collection := "/api/v1/books/" + bookID + "/bookmarks"

	longLabel := strings.Repeat("长", 201)
	if code := api.request(http.MethodPost, collection,
		bookmarkCreateBody(fileVersion, "epubcfi(/6/8!/4/2/2:0)", "bm-long", longLabel),
		true, true, nil).Code; code != http.StatusBadRequest {
		t.Fatalf("超长 label = %d", code)
	}
	if code := api.request(http.MethodPost, collection,
		bookmarkCreateBody(strings.Repeat("b", 64), "epubcfi(/6/8!/4/2/2:0)", "bm-version", ""),
		true, true, nil).Code; code != http.StatusConflict {
		t.Fatalf("fileVersion 失配 = %d", code)
	}
	badLocator := fmt.Sprintf(`{"schemaVersion":1,"fileVersion":%q,"format":"epub",`+
		`"locatorType":"pdf-page","locatorPayload":{"locatorVersion":1,"page":1,"pageOffset":0},`+
		`"clientMutationId":"bm-bad"}`, fileVersion)
	if code := api.request(http.MethodPost, collection, badLocator, true, true, nil).Code; code != http.StatusUnprocessableEntity {
		t.Fatalf("非法 locator = %d", code)
	}
	if code := api.request(http.MethodGet, collection+"?bogus=1", "", true, false, nil).Code; code != http.StatusBadRequest {
		t.Fatalf("未知查询参数 = %d", code)
	}
	if code := api.request(http.MethodGet, collection+"?limit=201", "", true, false, nil).Code; code != http.StatusBadRequest {
		t.Fatalf("limit 201 = %d", code)
	}
	if code := api.request(http.MethodPost, collection,
		bookmarkCreateBody(fileVersion, "epubcfi(/6/8!/4/2/2:0)", "bm-csrf", ""),
		true, false, nil).Code; code != http.StatusForbidden {
		t.Fatalf("缺 CSRF = %d", code)
	}
	if code := api.request(http.MethodGet, collection, "", false, false, nil).Code; code != http.StatusUnauthorized {
		t.Fatalf("未认证列表 = %d", code)
	}
	if code := api.request(http.MethodGet, "/api/v1/books/"+strings.Repeat("f", 32)+"/bookmarks", "", true, false, nil).Code; code != http.StatusNotFound {
		t.Fatalf("未知书籍书签 = %d", code)
	}
}
