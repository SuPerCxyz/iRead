package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"iread/server/internal/formats"
	"iread/server/internal/store"
)

type libraryListPage struct {
	Data []bookDTO `json:"data"`
	Meta struct {
		NextCursor *string `json:"nextCursor"`
		Total      *int64  `json:"total"`
	} `json:"meta"`
}

func (e *libraryHTTPEnv) putBookProgress(bookID string, baseRevision int64, percent float64, locatorType, locatorPayload string) store.ReadingProgress {
	e.t.Helper()
	detail, err := e.store.GetBookDetail(context.Background(), bookID)
	if err != nil {
		e.t.Fatalf("读取进度所需书籍失败: %v", err)
	}
	progress, _, err := e.store.PutReadingProgress(context.Background(), store.PutReadingProgressParams{
		BookID:           bookID,
		FileVersion:      detail.File.SHA256,
		Format:           detail.Format,
		LocatorType:      locatorType,
		LocatorPayload:   json.RawMessage(locatorPayload),
		ProgressPercent:  percent,
		BaseRevision:     baseRevision,
		ClientMutationID: fmt.Sprintf("%s-mutation-%d", bookID, baseRevision),
	})
	if err != nil {
		e.t.Fatalf("写入阅读进度失败: %v", err)
	}
	return progress
}

func (e *libraryHTTPEnv) getList(t *testing.T, target string) libraryListPage {
	t.Helper()
	recorder := e.request(http.MethodGet, target, nil, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("%s status = %d，body=%s", target, recorder.Code, recorder.Body.String())
	}
	var page libraryListPage
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
		t.Fatalf("解析列表失败: %v，body=%s", err, recorder.Body.String())
	}
	return page
}

func bookIDs(page libraryListPage) []string {
	ids := make([]string, 0, len(page.Data))
	for _, book := range page.Data {
		ids = append(ids, book.BookID)
	}
	return ids
}

func requireBookIDs(t *testing.T, page libraryListPage, want ...string) {
	t.Helper()
	got := bookIDs(page)
	if len(got) != len(want) {
		t.Fatalf("书库 ID = %v，期望 %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("书库 ID = %v，期望 %v", got, want)
		}
	}
}

func TestLibraryReadingStateFiltersAndRecentRead(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	unread := env.upload("unread.epub", []byte("unread-book"))
	reading := env.upload("reading.epub", []byte("reading-book"))
	finishedPercent := env.upload("finished-percent.epub", []byte("finished-percent-book"))
	finishedPage := env.upload("finished-page.pdf", []byte("finished-page-book"))

	// 顺序写入，确保 recent-read 的时间顺序稳定。
	env.putBookProgress(*finishedPercent.BookID, 0, 100, "epub-cfi", `{"cfi":"epubcfi(/6/2)"}`)
	time.Sleep(2 * time.Millisecond)
	env.putBookProgress(*reading.BookID, 0, 50, "epub-cfi", `{"cfi":"epubcfi(/6/4)"}`)
	time.Sleep(2 * time.Millisecond)
	env.putBookProgress(*finishedPage.BookID, 0, 10, "pdf-page", `{"page":2}`)

	unreadPage := env.getList(t, "/api/v1/books?readingState=unread")
	requireBookIDs(t, unreadPage, *unread.BookID)
	if unreadPage.Meta.Total == nil || *unreadPage.Meta.Total != 1 {
		t.Fatalf("unread total = %v", unreadPage.Meta.Total)
	}

	readingPage := env.getList(t, "/api/v1/books?readingState=reading")
	requireBookIDs(t, readingPage, *reading.BookID)
	if readingPage.Meta.Total == nil || *readingPage.Meta.Total != 1 {
		t.Fatalf("reading total = %v", readingPage.Meta.Total)
	}
	if readingPage.Data[0].Progress == nil || readingPage.Data[0].Progress.ProgressPercent != 50 {
		t.Fatalf("reading progress = %+v", readingPage.Data[0].Progress)
	}

	finishedPageList := env.getList(t, "/api/v1/books?readingState=finished&sort=recent-read")
	requireBookIDs(t, finishedPageList, *finishedPage.BookID, *finishedPercent.BookID)
	if finishedPageList.Meta.Total == nil || *finishedPageList.Meta.Total != 2 {
		t.Fatalf("finished total = %v", finishedPageList.Meta.Total)
	}

	all := env.getList(t, "/api/v1/books?sort=recent-read")
	requireBookIDs(t, all, *finishedPage.BookID, *reading.BookID, *finishedPercent.BookID, *unread.BookID)
	if all.Meta.Total == nil || *all.Meta.Total != 4 {
		t.Fatalf("recent-read total = %v", all.Meta.Total)
	}
	if all.Data[3].Progress != nil {
		t.Fatalf("未读书籍 progress 应为 null: %+v", all.Data[3].Progress)
	}

	// 完成的书倒退到 40%：finished 排除，reading 纳入。
	env.putBookProgress(*finishedPercent.BookID, 1, 40, "epub-cfi", `{"cfi":"epubcfi(/6/8)"}`)
	finishedAfter := env.getList(t, "/api/v1/books?readingState=finished")
	requireBookIDs(t, finishedAfter, *finishedPage.BookID)
	readingAfter := env.getList(t, "/api/v1/books?readingState=reading&sort=recent-read")
	requireBookIDs(t, readingAfter, *finishedPercent.BookID, *reading.BookID)

	// 详情也应返回真实最近进度，而不是固定 null。
	detailRecorder := env.request(http.MethodGet, "/api/v1/books/"+*reading.BookID, nil, "")
	detail := decodeLibraryData[bookDetailDTO](t, detailRecorder)
	if detail.Progress == nil || detail.Progress.ProgressPercent != 50 || detail.Progress.UpdatedAt == "" {
		t.Fatalf("详情进度 = %+v", detail.Progress)
	}
}

func TestRecentReadPaginationAcrossProgressAndUnread(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	unread := env.upload("unread.epub", []byte("pagination-unread"))
	older := env.upload("older.epub", []byte("pagination-older"))
	newer := env.upload("newer.epub", []byte("pagination-newer"))
	env.putBookProgress(*older.BookID, 0, 30, "epub-cfi", `{"cfi":"epubcfi(/6/2)"}`)
	time.Sleep(2 * time.Millisecond)
	env.putBookProgress(*newer.BookID, 0, 60, "epub-cfi", `{"cfi":"epubcfi(/6/4)"}`)

	first := env.getList(t, "/api/v1/books?sort=recent-read&limit=2")
	requireBookIDs(t, first, *newer.BookID, *older.BookID)
	if first.Meta.NextCursor == nil || first.Meta.Total == nil || *first.Meta.Total != 3 {
		t.Fatalf("第一页 = %+v", first)
	}
	second := env.getList(t, "/api/v1/books?sort=recent-read&limit=2&cursor="+*first.Meta.NextCursor)
	requireBookIDs(t, second, *unread.BookID)
	if second.Meta.NextCursor != nil {
		t.Fatalf("第二页不应有 nextCursor")
	}

	one := env.getList(t, "/api/v1/books?sort=recent-read&limit=1")
	requireBookIDs(t, one, *newer.BookID)
	if one.Meta.NextCursor == nil {
		t.Fatal("limit=1 第一页缺少 nextCursor")
	}
	two := env.getList(t, "/api/v1/books?sort=recent-read&limit=1&cursor="+*one.Meta.NextCursor)
	requireBookIDs(t, two, *older.BookID)
	if two.Meta.NextCursor == nil {
		t.Fatal("limit=1 第二页缺少 nextCursor")
	}
	three := env.getList(t, "/api/v1/books?sort=recent-read&limit=1&cursor="+*two.Meta.NextCursor)
	requireBookIDs(t, three, *unread.BookID)
	if three.Meta.NextCursor != nil {
		t.Fatal("limit=1 第三页不应有 nextCursor")
	}

	if recorder := env.request(http.MethodGet, "/api/v1/books?sort=recent-read&readingState=unread&cursor="+*one.Meta.NextCursor, nil, ""); recorder.Code != http.StatusBadRequest {
		t.Fatalf("recent-read cursor 绑定 readingState status = %d", recorder.Code)
	}
	if recorder := env.request(http.MethodGet, "/api/v1/books?sort=recent-added&cursor="+*one.Meta.NextCursor, nil, ""); recorder.Code != http.StatusBadRequest {
		t.Fatalf("cursor 绑定 sort status = %d", recorder.Code)
	}
	unreadOnly := env.getList(t, "/api/v1/books?sort=recent-read&readingState=unread&limit=1")
	requireBookIDs(t, unreadOnly, *unread.BookID)
	if unreadOnly.Meta.NextCursor != nil {
		t.Fatal("unread-only 不应有 nextCursor")
	}

	// 无进度分组自身也需要可翻页（recent-read 游标 key 为空）。
	secondUnread := env.upload("unread-two.epub", []byte("pagination-unread-two"))
	unreadFirst := env.getList(t, "/api/v1/books?sort=recent-read&readingState=unread&limit=1")
	if unreadFirst.Meta.NextCursor == nil {
		t.Fatal("两个无进度书籍应产生 nextCursor")
	}
	unreadSecond := env.getList(t, "/api/v1/books?sort=recent-read&readingState=unread&limit=1&cursor="+*unreadFirst.Meta.NextCursor)
	unreadSeen := map[string]bool{}
	for _, id := range append(bookIDs(unreadFirst), bookIDs(unreadSecond)...) {
		unreadSeen[id] = true
	}
	if !unreadSeen[*unread.BookID] || !unreadSeen[*secondUnread.BookID] {
		t.Fatalf("无进度分页遗漏: %v", unreadSeen)
	}
}

func TestLibrarySearchFormatUpdatedAndCursorBinding(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	alpha := env.upload("alpha.epub", []byte("alpha-book"))
	beta := env.upload("beta.pdf", []byte("beta-book"))
	gamma := env.upload("gamma.epub", []byte("gamma-book"))

	alphaPage := env.getList(t, "/api/v1/books?q=alpha")
	requireBookIDs(t, alphaPage, *alpha.BookID)
	if alphaPage.Meta.Total == nil || *alphaPage.Meta.Total != 1 {
		t.Fatalf("q=alpha total = %v", alphaPage.Meta.Total)
	}
	authorPage := env.getList(t, "/api/v1/books?q=HTTP%20%E4%BD%9C%E8%80%85")
	if authorPage.Meta.Total == nil || *authorPage.Meta.Total != 3 {
		t.Fatalf("q=作者 total = %v", authorPage.Meta.Total)
	}
	pdfPage := env.getList(t, "/api/v1/books?format=pdf")
	requireBookIDs(t, pdfPage, *beta.BookID)
	if pdfPage.Meta.Total == nil || *pdfPage.Meta.Total != 1 {
		t.Fatalf("format=pdf total = %v", pdfPage.Meta.Total)
	}

	var seen []string
	var cursor *string
	for i := 0; i < 3; i++ {
		target := "/api/v1/books?sort=updated&limit=1"
		if cursor != nil {
			target += "&cursor=" + *cursor
		}
		page := env.getList(t, target)
		if page.Meta.Total == nil || *page.Meta.Total != 3 {
			t.Fatalf("sort=updated total = %v", page.Meta.Total)
		}
		seen = append(seen, bookIDs(page)...)
		cursor = page.Meta.NextCursor
	}
	if cursor != nil || len(seen) != 3 {
		t.Fatalf("sort=updated 分页 = %v, cursor=%v", seen, cursor)
	}
	unique := map[string]bool{}
	for _, id := range seen {
		if unique[id] {
			t.Fatalf("sort=updated 重复书籍 %s", id)
		}
		unique[id] = true
	}
	for _, id := range []string{*alpha.BookID, *beta.BookID, *gamma.BookID} {
		if !unique[id] {
			t.Fatalf("sort=updated 遗漏 %s", id)
		}
	}

	first := env.getList(t, "/api/v1/books?q=HTTP%20%E4%BD%9C%E8%80%85&limit=1")
	if first.Meta.NextCursor == nil {
		t.Fatal("q=作者 缺少 cursor")
	}
	if recorder := env.request(http.MethodGet, "/api/v1/books?q=alpha&limit=1&cursor="+*first.Meta.NextCursor, nil, ""); recorder.Code != http.StatusBadRequest {
		t.Fatalf("cursor 绑定 q status = %d", recorder.Code)
	}
	if recorder := env.request(http.MethodGet, "/api/v1/books?sort=bogus", nil, ""); recorder.Code != http.StatusBadRequest {
		t.Fatalf("未知 sort status = %d", recorder.Code)
	}
	if recorder := env.request(http.MethodGet, "/api/v1/books?readingState=bogus", nil, ""); recorder.Code != http.StatusBadRequest {
		t.Fatalf("未知 readingState status = %d", recorder.Code)
	}
}

func TestFinishedThresholdWithoutPageCount(t *testing.T) {
	validator := validatorFunc(func(_ context.Context, _ string, ext string) (formats.Result, error) {
		return formats.Result{Format: ext, MediaType: testMediaType(ext), Readable: true, Title: "无页数"}, nil
	})
	env := newLibraryHTTPEnv(t, validator, allowAllMiddleware, allowAllMiddleware)
	book := env.upload("threshold.epub", []byte("threshold-book"))
	env.putBookProgress(*book.BookID, 0, 99.4, "epub-cfi", `{"cfi":"epubcfi(/6/2)"}`)
	if page := env.getList(t, "/api/v1/books?readingState=finished"); len(page.Data) != 0 {
		t.Fatalf("99.4 不应 finished: %+v", page.Data)
	}
	env.putBookProgress(*book.BookID, 1, 99.5, "epub-cfi", `{"cfi":"epubcfi(/6/2)"}`)
	page := env.getList(t, "/api/v1/books?readingState=finished")
	requireBookIDs(t, page, *book.BookID)
}
