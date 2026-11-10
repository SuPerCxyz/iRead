package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	readersettings "iread/server/internal/reader/settings"
)

func TestReaderSettingsDefaultsCASAndIsolation(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	ctx := context.Background()

	defaultRecord, err := database.GetReaderSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if defaultRecord.Revision != 0 || defaultRecord.UpdatedAt != nil ||
		string(defaultRecord.Value) != "{}" || defaultRecord.SchemaVersion != 1 {
		t.Fatalf("默认阅读设置 = %+v", defaultRecord)
	}

	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	database.now = func() time.Time { return now }
	first, err := database.PutReaderSettings(ctx, 0, json.RawMessage(`{"reflow":{"fontSize":20}}`))
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || first.UpdatedAt == nil || !first.UpdatedAt.Equal(now) ||
		string(first.Value) != `{"reflow":{"fontSize":20}}` {
		t.Fatalf("首次阅读设置 = %+v", first)
	}

	var stale *ReaderSettingsRevisionConflictError
	if _, err := database.PutReaderSettings(ctx, 0, json.RawMessage(`{"reflow":{"fontSize":21}}`)); !errors.As(err, &stale) {
		t.Fatalf("过时写入错误 = %v", err)
	} else if stale.Current.Revision != 1 {
		t.Fatalf("冲突 current = %+v", stale.Current)
	}

	if _, err := database.PutReaderSettings(ctx, 1, json.RawMessage(`[1]`)); !errors.Is(err, ErrReaderInvalidInput) {
		t.Fatalf("数组设置错误 = %v", err)
	}
	if _, err := database.PutReaderSettings(ctx, 1, json.RawMessage(`{"reflow":{"fontSize":null}}`)); !errors.Is(err, ErrReaderInvalidInput) {
		t.Fatalf("null 设置错误 = %v", err)
	}

	now = now.Add(time.Minute)
	second, err := database.PutReaderSettings(ctx, 1, json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision != 2 || string(second.Value) != "{}" {
		t.Fatalf("空对象阅读设置 = %+v", second)
	}

	// 与 appearance 分组隔离：阅读设置写入不应创建或改变 appearance 行。
	if _, err := database.GetAppearance(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := database.db.QueryRow(`SELECT COUNT(*) FROM app_settings WHERE "group" = ?`,
		readersettings.Group).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("reader 分组行数 = %d", count)
	}
}
