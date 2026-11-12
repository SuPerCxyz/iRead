package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

func newReaderTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	database := openTestStore(t, t.TempDir())
	bookID := fmt.Sprintf("%032x", 1)
	insertBook(t, database.db, bookID)
	return database, bookID
}

func newReaderTestBook(t *testing.T, database *Store, seed int) string {
	t.Helper()
	bookID := fmt.Sprintf("%032x", seed)
	insertBook(t, database.db, bookID)
	return bookID
}

func readerSHA(char string) string { return strings.Repeat(char, 64) }

func TestBookManifestUpsertAndGet(t *testing.T) {
	database, bookID := newReaderTestStore(t)
	ctx := context.Background()

	if _, found, err := database.GetBookManifest(ctx, bookID); err != nil || found {
		t.Fatalf("空 manifest 查询 = found:%v err:%v", found, err)
	}

	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	database.now = func() time.Time { return now }
	first, err := database.UpsertBookManifest(ctx, BookManifest{
		BookID:       bookID,
		FileVersion:  readerSHA("a"),
		Format:       ReaderFormatEPUB,
		IndexVersion: 2,
		ManifestJSON: json.RawMessage(`{"schemaVersion":1,"bookId":"..."}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.SchemaVersion != ReaderSchemaVersion || first.IndexVersion != 2 ||
		first.Format != ReaderFormatEPUB || !first.CreatedAt.Equal(now) || !first.UpdatedAt.Equal(now) {
		t.Fatalf("首次 manifest = %+v", first)
	}

	got, found, err := database.GetBookManifest(ctx, bookID)
	if err != nil || !found {
		t.Fatalf("读取 manifest = found:%v err:%v", found, err)
	}
	if got.FileVersion != readerSHA("a") || string(got.ManifestJSON) != `{"schemaVersion":1,"bookId":"..."}` {
		t.Fatalf("读取 manifest = %+v", got)
	}

	now = now.Add(time.Hour)
	second, err := database.UpsertBookManifest(ctx, BookManifest{
		BookID:        bookID,
		FileVersion:   readerSHA("b"),
		Format:        ReaderFormatPDF,
		IndexVersion:  3,
		SchemaVersion: 1,
		ManifestJSON:  json.RawMessage(`{"schemaVersion":1,"bookId":"...","format":"pdf"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !second.CreatedAt.Equal(first.CreatedAt) || !second.UpdatedAt.Equal(now) ||
		second.FileVersion != readerSHA("b") || second.IndexVersion != 3 {
		t.Fatalf("更新后 manifest = %+v", second)
	}
	if got := countRows(t, database.db, "book_manifests"); got != 1 {
		t.Fatalf("manifest 行数 = %d，期望 1", got)
	}

	unknownBook := fmt.Sprintf("%032x", 99)
	if _, err := database.UpsertBookManifest(ctx, BookManifest{
		BookID: unknownBook, FileVersion: readerSHA("a"), Format: ReaderFormatEPUB,
		ManifestJSON: json.RawMessage(`{}`),
	}); !errors.Is(err, ErrBookNotFound) {
		t.Fatalf("未知书籍 manifest 错误 = %v", err)
	}
	if _, _, err := database.GetBookManifest(ctx, unknownBook); !errors.Is(err, ErrBookNotFound) {
		t.Fatalf("未知书籍读取 manifest 错误 = %v", err)
	}
	badManifests := []BookManifest{
		{BookID: bookID, FileVersion: readerSHA("a"), Format: "mobi", ManifestJSON: json.RawMessage(`{}`)},
		{BookID: bookID, FileVersion: strings.Repeat("A", 64), Format: ReaderFormatEPUB, ManifestJSON: json.RawMessage(`{}`)},
		{BookID: bookID, FileVersion: readerSHA("a"), Format: ReaderFormatEPUB, ManifestJSON: json.RawMessage(`[]`)},
		{BookID: bookID, FileVersion: readerSHA("a"), Format: ReaderFormatEPUB, ManifestJSON: json.RawMessage(`{`)},
		{BookID: bookID, FileVersion: readerSHA("a"), Format: ReaderFormatEPUB, IndexVersion: -1, ManifestJSON: json.RawMessage(`{}`)},
	}
	for i, manifest := range badManifests {
		if _, err := database.UpsertBookManifest(ctx, manifest); !errors.Is(err, ErrReaderInvalidInput) {
			t.Fatalf("非法 manifest[%d] 错误 = %v", i, err)
		}
	}
}

func TestReadingProgressCASIdempotencyAndFileVersion(t *testing.T) {
	database, bookID := newReaderTestStore(t)
	ctx := context.Background()
	fileA := readerSHA("a")
	fileB := readerSHA("b")

	if progress, err := database.GetReadingProgress(ctx, bookID); err != nil || progress != nil {
		t.Fatalf("未读书籍进度 = %+v, err=%v", progress, err)
	}

	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	database.now = func() time.Time { return now }
	firstParams := PutReadingProgressParams{
		BookID:           bookID,
		FileVersion:      fileA,
		Format:           ReaderFormatEPUB,
		LocatorType:      "epub-cfi",
		LocatorPayload:   json.RawMessage(`{"locatorVersion":1,"spineIndex":3,"cfi":"epubcfi(/6/8!/4/2/1:0)","chapterProgress":0.42}`),
		ProgressPercent:  42.5,
		BaseRevision:     0,
		ClientMutationID: "mut-1",
	}
	first, replayed, err := database.PutReadingProgress(ctx, firstParams)
	if err != nil {
		t.Fatal(err)
	}
	if replayed || first.Revision != 1 || first.ClientMutationID != "mut-1" ||
		first.FileVersion != fileA || !first.UpdatedAt.Equal(now) {
		t.Fatalf("首次进度 = %+v replayed=%v", first, replayed)
	}
	if !strings.Contains(string(first.LocatorPayload), `"spineIndex":3`) {
		t.Fatalf("规范化 locator = %s", first.LocatorPayload)
	}

	replay, replayed, err := database.PutReadingProgress(ctx, firstParams)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed || replay.Revision != 1 || !replay.UpdatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("幂等重放 = %+v replayed=%v", replay, replayed)
	}

	now = now.Add(time.Minute)
	secondParams := firstParams
	secondParams.FileVersion = fileB
	secondParams.Format = ReaderFormatPDF
	secondParams.LocatorType = "pdf-page"
	secondParams.LocatorPayload = json.RawMessage(`{"locatorVersion":1,"page":128,"pageOffset":0.37}`)
	secondParams.ProgressPercent = 43
	secondParams.BaseRevision = 1
	secondParams.ClientMutationID = "mut-2"
	second, replayed, err := database.PutReadingProgress(ctx, secondParams)
	if err != nil {
		t.Fatal(err)
	}
	if replayed || second.Revision != 2 || second.FileVersion != fileB || second.Format != ReaderFormatPDF {
		t.Fatalf("第二次进度 = %+v replayed=%v", second, replayed)
	}

	// 旧 mutation 的重放返回当时确认的快照，而不是覆盖后的当前行。
	replay, replayed, err = database.PutReadingProgress(ctx, firstParams)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed || replay.Revision != 1 || replay.FileVersion != fileA {
		t.Fatalf("旧 mutation 重放 = %+v replayed=%v", replay, replayed)
	}

	oldBase := secondParams
	oldBase.BaseRevision = 1
	oldBase.ClientMutationID = "mut-3"
	_, _, err = database.PutReadingProgress(ctx, oldBase)
	var revisionConflict *ProgressRevisionConflictError
	if !errors.As(err, &revisionConflict) || revisionConflict.Current == nil ||
		revisionConflict.Current.Revision != 2 {
		t.Fatalf("旧 baseRevision 错误 = %T %v", err, err)
	}

	sameMutation := secondParams
	sameMutation.ProgressPercent = 99
	sameMutation.BaseRevision = 2
	_, _, err = database.PutReadingProgress(ctx, sameMutation)
	var stateConflict *ProgressStateConflictError
	if !errors.As(err, &stateConflict) || stateConflict.Current == nil ||
		stateConflict.Current.Revision != 2 {
		t.Fatalf("同 mutation 不同请求错误 = %T %v", err, err)
	}

	var mutationCount int
	if err := database.db.QueryRow(`
		SELECT COUNT(*) FROM progress_mutations WHERE book_id = ?`, bookID).Scan(&mutationCount); err != nil {
		t.Fatal(err)
	}
	if mutationCount != 2 {
		t.Fatalf("进度幂等记录数 = %d，期望 2", mutationCount)
	}
	var requestHash string
	if err := database.db.QueryRow(`
		SELECT request_hash FROM progress_mutations
		WHERE book_id = ? AND client_mutation_id = 'mut-1'`, bookID).Scan(&requestHash); err != nil {
		t.Fatal(err)
	}
	if len(requestHash) != 64 || requestHash != strings.ToLower(requestHash) {
		t.Fatalf("request_hash = %q", requestHash)
	}

	noProgressBook := newReaderTestBook(t, database, 3)
	noRowParams := firstParams
	noRowParams.BookID = noProgressBook
	noRowParams.BaseRevision = 5
	noRowParams.ClientMutationID = "mut-4"
	_, _, err = database.PutReadingProgress(ctx, noRowParams)
	if !errors.As(err, &revisionConflict) || revisionConflict.Current != nil {
		t.Fatalf("无记录非零 baseRevision 错误 = %T %v", err, err)
	}

	unknownBook := fmt.Sprintf("%032x", 99)
	unknownParams := firstParams
	unknownParams.BookID = unknownBook
	if _, _, err := database.PutReadingProgress(ctx, unknownParams); !errors.Is(err, ErrBookNotFound) {
		t.Fatalf("未知书籍进度错误 = %v", err)
	}
	if _, err := database.GetReadingProgress(ctx, unknownBook); !errors.Is(err, ErrBookNotFound) {
		t.Fatalf("未知书籍读取进度错误 = %v", err)
	}

	badParams := []PutReadingProgressParams{
		{BookID: bookID, FileVersion: fileA, Format: ReaderFormatEPUB, LocatorType: "epub-cfi", LocatorPayload: json.RawMessage(`{}`), ProgressPercent: 100.1, BaseRevision: 2, ClientMutationID: "bad-1"},
		{BookID: bookID, FileVersion: fileA, Format: ReaderFormatEPUB, LocatorType: "epub-cfi", LocatorPayload: json.RawMessage(`{}`), ProgressPercent: math.NaN(), BaseRevision: 2, ClientMutationID: "bad-2"},
		{BookID: bookID, FileVersion: strings.Repeat("A", 64), Format: ReaderFormatEPUB, LocatorType: "epub-cfi", LocatorPayload: json.RawMessage(`{}`), ProgressPercent: 1, BaseRevision: 2, ClientMutationID: "bad-3"},
		{BookID: bookID, FileVersion: fileA, Format: "mobi", LocatorType: "epub-cfi", LocatorPayload: json.RawMessage(`{}`), ProgressPercent: 1, BaseRevision: 2, ClientMutationID: "bad-4"},
		{BookID: bookID, FileVersion: fileA, Format: ReaderFormatEPUB, LocatorType: "epub-cfi", LocatorPayload: json.RawMessage(`[]`), ProgressPercent: 1, BaseRevision: 2, ClientMutationID: "bad-5"},
		{BookID: bookID, FileVersion: fileA, Format: ReaderFormatEPUB, LocatorType: "epub-cfi", LocatorPayload: json.RawMessage(`{}`), ProgressPercent: 1, BaseRevision: 2, ClientMutationID: ""},
	}
	for i, params := range badParams {
		if _, _, err := database.PutReadingProgress(ctx, params); !errors.Is(err, ErrReaderInvalidInput) {
			t.Fatalf("非法进度[%d] 错误 = %v", i, err)
		}
	}
}

func TestBookmarksCreateListDeleteAndDedupe(t *testing.T) {
	database, bookID := newReaderTestStore(t)
	secondBookID := newReaderTestBook(t, database, 2)
	ctx := context.Background()
	fileA := readerSHA("a")
	fileB := readerSHA("b")

	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	database.now = func() time.Time { return now }

	first, created, err := database.CreateBookmark(ctx, CreateBookmarkParams{
		BookID: bookID, FileVersion: fileA, Format: ReaderFormatPDF,
		LocatorType: "pdf-page", LocatorPayload: json.RawMessage(`{"locatorVersion":1,"page":1}`),
		LocatorKey: "page:1", Label: "第一页", ClientMutationID: "bm-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !created || first.Revision != 1 || first.BookmarkID == "" || first.Label != "第一页" {
		t.Fatalf("创建书签 = %+v created=%v", first, created)
	}

	duplicateMutation, created, err := database.CreateBookmark(ctx, CreateBookmarkParams{
		BookID: bookID, FileVersion: fileA, Format: ReaderFormatPDF,
		LocatorType: "pdf-page", LocatorPayload: json.RawMessage(`{"locatorVersion":1,"page":2}`),
		LocatorKey: "page:2", Label: "另一页", ClientMutationID: "bm-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created || duplicateMutation.BookmarkID != first.BookmarkID {
		t.Fatalf("同 mutationId 去重 = %+v created=%v", duplicateMutation, created)
	}

	duplicateLocator, created, err := database.CreateBookmark(ctx, CreateBookmarkParams{
		BookID: bookID, FileVersion: fileA, Format: ReaderFormatPDF,
		LocatorType: "pdf-page", LocatorPayload: json.RawMessage(`{"page":1}`),
		LocatorKey: "page:1", Label: "重复定位", ClientMutationID: "bm-new",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created || duplicateLocator.BookmarkID != first.BookmarkID {
		t.Fatalf("同 locator_key 去重 = %+v created=%v", duplicateLocator, created)
	}

	now = now.Add(time.Minute)
	second, created, err := database.CreateBookmark(ctx, CreateBookmarkParams{
		BookID: bookID, FileVersion: fileA, Format: ReaderFormatPDF,
		LocatorType: "pdf-page", LocatorPayload: json.RawMessage(`{"locatorVersion":1,"page":2}`),
		LocatorKey: "page:2", Label: "第二页", ClientMutationID: "bm-2",
	})
	if err != nil || !created {
		t.Fatalf("创建第二书签 = %+v created=%v err=%v", second, created, err)
	}

	now = now.Add(time.Minute)
	third, created, err := database.CreateBookmark(ctx, CreateBookmarkParams{
		BookID: bookID, FileVersion: fileB, Format: ReaderFormatEPUB,
		LocatorType: "epub-cfi", LocatorPayload: json.RawMessage(`{"locatorVersion":1,"spineIndex":2}`),
		LocatorKey: "cfi:2", Label: "新区间", ClientMutationID: "bm-3",
	})
	if err != nil || !created {
		t.Fatalf("创建旧版本外书签 = %+v created=%v err=%v", third, created, err)
	}

	now = now.Add(time.Minute)
	otherBookBookmark, created, err := database.CreateBookmark(ctx, CreateBookmarkParams{
		BookID: secondBookID, FileVersion: fileA, Format: ReaderFormatPDF,
		LocatorType: "pdf-page", LocatorPayload: json.RawMessage(`{"locatorVersion":1,"page":9}`),
		LocatorKey: "page:9", Label: "别书", ClientMutationID: "bm-4",
	})
	if err != nil || !created {
		t.Fatalf("创建别书书签 = %+v created=%v err=%v", otherBookBookmark, created, err)
	}

	page, err := database.ListBookmarks(ctx, BookmarkListQuery{
		BookID: bookID, FileVersion: fileA, Limit: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Bookmarks) != 1 || page.Bookmarks[0].BookmarkID != second.BookmarkID || !page.HasMore {
		t.Fatalf("第一页书签 = %+v", page)
	}
	next, err := database.ListBookmarks(ctx, BookmarkListQuery{
		BookID: bookID, FileVersion: fileA, Limit: 1, HasCursor: true,
		CursorCreatedAt: page.Bookmarks[0].CreatedAt, CursorID: page.Bookmarks[0].BookmarkID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Bookmarks) != 1 || next.Bookmarks[0].BookmarkID != first.BookmarkID || next.HasMore {
		t.Fatalf("第二页书签 = %+v", next)
	}

	all, err := database.ListBookmarks(ctx, BookmarkListQuery{BookID: bookID, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Bookmarks) != 3 || all.Bookmarks[0].BookmarkID != third.BookmarkID ||
		all.Bookmarks[1].BookmarkID != second.BookmarkID || all.Bookmarks[2].BookmarkID != first.BookmarkID {
		t.Fatalf("全部书签顺序 = %+v", all.Bookmarks)
	}
	versioned, err := database.ListBookmarks(ctx, BookmarkListQuery{BookID: bookID, FileVersion: fileB, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(versioned.Bookmarks) != 1 || versioned.Bookmarks[0].BookmarkID != third.BookmarkID {
		t.Fatalf("按 fileVersion 列表 = %+v", versioned.Bookmarks)
	}

	if _, _, err := database.PutReadingProgress(ctx, PutReadingProgressParams{
		BookID: bookID, FileVersion: fileA, Format: ReaderFormatPDF, LocatorType: "pdf-page",
		LocatorPayload:  json.RawMessage(`{"locatorVersion":1,"page":5}`),
		ProgressPercent: 10, BaseRevision: 0, ClientMutationID: "progress-before-delete",
	}); err != nil {
		t.Fatal(err)
	}

	var bookmarkConflict *BookmarkRevisionConflictError
	err = database.DeleteBookmark(ctx, bookID, first.BookmarkID, 99)
	if !errors.As(err, &bookmarkConflict) || bookmarkConflict.Current.BookmarkID != first.BookmarkID {
		t.Fatalf("错误 revision 删除 = %T %v", err, err)
	}
	if err := database.DeleteBookmark(ctx, bookID, first.BookmarkID, 1); err != nil {
		t.Fatalf("正确删除书签失败: %v", err)
	}
	if err := database.DeleteBookmark(ctx, bookID, first.BookmarkID, 1); !errors.Is(err, ErrBookmarkNotFound) {
		t.Fatalf("重复删除错误 = %v", err)
	}
	if err := database.DeleteBookmark(ctx, bookID, otherBookBookmark.BookmarkID, 1); !errors.Is(err, ErrBookmarkNotFound) {
		t.Fatalf("跨书删除错误 = %v", err)
	}
	if err := database.DeleteBookmark(ctx, fmt.Sprintf("%032x", 99), first.BookmarkID, 1); !errors.Is(err, ErrBookNotFound) {
		t.Fatalf("未知书籍删除错误 = %v", err)
	}

	if got := countRows(t, database.db, "bookmarks"); got != 3 {
		t.Fatalf("删除后书签行数 = %d，期望 3", got)
	}
	if progress, err := database.GetReadingProgress(ctx, bookID); err != nil || progress == nil {
		t.Fatalf("删除书签不应影响进度: progress=%+v err=%v", progress, err)
	}
	var bookCount int
	if err := database.db.QueryRow(`SELECT COUNT(*) FROM books WHERE id = ?`, bookID).Scan(&bookCount); err != nil {
		t.Fatal(err)
	}
	if bookCount != 1 {
		t.Fatalf("删除书签不应删除书籍")
	}

	if _, _, err := database.CreateBookmark(ctx, CreateBookmarkParams{
		BookID: fmt.Sprintf("%032x", 99), FileVersion: fileA, Format: ReaderFormatPDF,
		LocatorType: "pdf-page", LocatorPayload: json.RawMessage(`{}`),
		LocatorKey: "page:1", ClientMutationID: "bm-unknown",
	}); !errors.Is(err, ErrBookNotFound) {
		t.Fatalf("未知书籍创建书签错误 = %v", err)
	}
	if _, err := database.ListBookmarks(ctx, BookmarkListQuery{
		BookID: fmt.Sprintf("%032x", 99), Limit: 10,
	}); !errors.Is(err, ErrBookNotFound) {
		t.Fatalf("未知书籍列表错误 = %v", err)
	}
}

func TestBookReaderOverridesSparseAndRevision(t *testing.T) {
	database, bookID := newReaderTestStore(t)
	secondBookID := newReaderTestBook(t, database, 2)
	ctx := context.Background()

	if record, err := database.GetBookReaderOverrides(ctx, bookID); err != nil {
		t.Fatal(err)
	} else if record.Revision != 0 || record.UpdatedAt != nil || string(record.Overrides) != "{}" ||
		record.SchemaVersion != ReaderSchemaVersion {
		t.Fatalf("无记录默认值 = %+v", record)
	}

	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	database.now = func() time.Time { return now }
	first, err := database.PutBookReaderOverrides(ctx, PutBookReaderOverridesParams{
		BookID: bookID, BaseRevision: 0,
		Overrides: json.RawMessage(`{"fontSize":18,"pagination":"scroll"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || first.UpdatedAt == nil || !first.UpdatedAt.Equal(now) {
		t.Fatalf("首次单书覆盖 = %+v", first)
	}
	if !strings.Contains(string(first.Overrides), `"fontSize":18`) {
		t.Fatalf("稀疏覆盖 = %s", first.Overrides)
	}
	got, err := database.GetBookReaderOverrides(ctx, bookID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != 1 || !strings.Contains(string(got.Overrides), `"pagination":"scroll"`) {
		t.Fatalf("读取单书覆盖 = %+v", got)
	}

	now = now.Add(time.Minute)
	reset, err := database.PutBookReaderOverrides(ctx, PutBookReaderOverridesParams{
		BookID: bookID, BaseRevision: 1, Overrides: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if reset.Revision != 2 || !strings.Contains(string(reset.Overrides), `"profiles"`) {
		t.Fatalf("空对象恢复默认 = %+v", reset)
	}
	var resetEnvelope struct {
		SchemaVersion int64                      `json:"schemaVersion"`
		Profiles      map[string]json.RawMessage `json:"profiles"`
	}
	if err := json.Unmarshal(reset.Overrides, &resetEnvelope); err != nil {
		t.Fatalf("解析覆盖信封: %v", err)
	}
	if resetEnvelope.SchemaVersion != ReaderSchemaVersion ||
		string(resetEnvelope.Profiles["web"]) != "{}" ||
		string(resetEnvelope.Profiles["mobile"]) != "{}" {
		t.Fatalf("空对象信封 = %s", reset.Overrides)
	}

	var conflict *ReaderOverridesRevisionConflictError
	if _, err := database.PutBookReaderOverrides(ctx, PutBookReaderOverridesParams{
		BookID: bookID, BaseRevision: 1, Overrides: json.RawMessage(`{"fontSize":20}`),
	}); !errors.As(err, &conflict) || conflict.Current.Revision != 2 {
		t.Fatalf("过时 baseRevision 错误 = %T %v", err, err)
	}

	conflict = nil
	if _, err := database.PutBookReaderOverrides(ctx, PutBookReaderOverridesParams{
		BookID: secondBookID, BaseRevision: 1, Overrides: json.RawMessage(`{}`),
	}); !errors.As(err, &conflict) || conflict.Current.Revision != 0 {
		t.Fatalf("无记录非零 baseRevision 错误 = %T %v", err, err)
	}
	empty, err := database.PutBookReaderOverrides(ctx, PutBookReaderOverridesParams{
		BookID: secondBookID, BaseRevision: 0, Overrides: json.RawMessage(`{}`),
	})
	if err != nil || empty.Revision != 1 || !strings.Contains(string(empty.Overrides), `"profiles"`) {
		t.Fatalf("首次空对象 = %+v err=%v", empty, err)
	}

	badOverrides := []json.RawMessage{
		json.RawMessage(`null`),
		json.RawMessage(`{"fontSize":null}`),
		json.RawMessage(`[]`),
		json.RawMessage(`"text"`),
		json.RawMessage(`{"fontSize":18} trailing`),
	}
	for i, raw := range badOverrides {
		if _, err := database.PutBookReaderOverrides(ctx, PutBookReaderOverridesParams{
			BookID: bookID, BaseRevision: 2, Overrides: raw,
		}); !errors.Is(err, ErrReaderInvalidInput) {
			t.Fatalf("非法覆盖[%d] 错误 = %v", i, err)
		}
	}
	if _, err := database.PutBookReaderOverrides(ctx, PutBookReaderOverridesParams{
		BookID: bookID, SchemaVersion: 2, BaseRevision: 2, Overrides: json.RawMessage(`{}`),
	}); !errors.Is(err, ErrReaderInvalidInput) {
		t.Fatalf("未知 schemaVersion 错误 = %v", err)
	}
	unknownBook := fmt.Sprintf("%032x", 99)
	if _, err := database.PutBookReaderOverrides(ctx, PutBookReaderOverridesParams{
		BookID: unknownBook, BaseRevision: 0, Overrides: json.RawMessage(`{}`),
	}); !errors.Is(err, ErrBookNotFound) {
		t.Fatalf("未知书籍覆盖错误 = %v", err)
	}
	if _, err := database.GetBookReaderOverrides(ctx, unknownBook); !errors.Is(err, ErrBookNotFound) {
		t.Fatalf("未知书籍读取覆盖错误 = %v", err)
	}
}

func TestPruneProgressMutationsRetention(t *testing.T) {
	database, bookID := newReaderTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	database.now = func() time.Time { return now }

	for i := 0; i < 205; i++ {
		created := now.Add(-time.Duration(i) * time.Minute)
		mustExec(t, database.db, `
			INSERT INTO progress_mutations (
				book_id, client_mutation_id, request_hash, revision, response_json, created_at
			) VALUES (?, ?, ?, 1, '{}', ?)`,
			bookID, fmt.Sprintf("mut-%03d", i), strings.Repeat("0", 64), formatStoreTime(created))
	}
	deleted, err := database.PruneProgressMutations(ctx, bookID)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 5 {
		t.Fatalf("按数量清理删除 %d 行，期望 5", deleted)
	}
	if got := countRows(t, database.db, "progress_mutations"); got != ProgressMutationRetentionCount {
		t.Fatalf("按数量清理后行数 = %d，期望 %d", got, ProgressMutationRetentionCount)
	}
	for _, id := range []string{"mut-199", "mut-200", "mut-204"} {
		var count int
		if err := database.db.QueryRow(`SELECT COUNT(*) FROM progress_mutations WHERE book_id = ? AND client_mutation_id = ?`, bookID, id).Scan(&count); err != nil {
			t.Fatal(err)
		}
		want := 1
		if id != "mut-199" {
			want = 0
		}
		if count != want {
			t.Fatalf("%s 行数 = %d，期望 %d", id, count, want)
		}
	}

	mustExec(t, database.db, `
		INSERT INTO progress_mutations (
			book_id, client_mutation_id, request_hash, revision, response_json, created_at
		) VALUES (?, 'mut-old', ?, 1, '{}', ?)`,
		bookID, strings.Repeat("0", 64), formatStoreTime(now.Add(-31*24*time.Hour)))
	deleted, err = database.PruneProgressMutations(ctx, bookID)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 1 {
		t.Fatalf("按时间清理删除 %d 行，期望 1", deleted)
	}
	var oldCount int
	if err := database.db.QueryRow(`SELECT COUNT(*) FROM progress_mutations WHERE client_mutation_id = 'mut-old'`).Scan(&oldCount); err != nil {
		t.Fatal(err)
	}
	if oldCount != 0 {
		t.Fatalf("过期幂等记录未删除")
	}

	if _, err := database.PruneProgressMutations(ctx, fmt.Sprintf("%032x", 99)); !errors.Is(err, ErrBookNotFound) {
		t.Fatalf("未知书籍清理错误 = %v", err)
	}
}
