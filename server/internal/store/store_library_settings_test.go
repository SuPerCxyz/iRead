package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	librarysettings "iread/server/internal/library/settings"
	"iread/server/internal/settings"
)

func TestLibrarySettingsDefaultAndCAS(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	ctx := context.Background()

	record, err := database.GetLibrarySettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if record.SchemaVersion != 1 || record.Revision != 0 || record.UpdatedAt != nil {
		t.Fatalf("默认记录 = %+v", record)
	}
	defaults, err := librarysettings.ParseValue(record.Value)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(defaults, librarysettings.DefaultValue()) {
		t.Fatalf("默认值 = %+v", defaults)
	}

	value := librarysettings.DefaultValue()
	value.ViewMode = "list"
	value.Columns = librarysettings.Columns{Count: 4}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	written, err := database.PutLibrarySettings(ctx, 0, raw)
	if err != nil {
		t.Fatal(err)
	}
	if written.Revision != 1 || written.UpdatedAt == nil {
		t.Fatalf("首次写入 = %+v", written)
	}
	parsed, err := librarysettings.ParseValue(written.Value)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(parsed, value) {
		t.Fatalf("写入值 = %+v", parsed)
	}

	if _, err := database.PutLibrarySettings(ctx, 0, raw); err == nil {
		t.Fatal("旧 baseRevision 应冲突")
	} else {
		var conflict *LibrarySettingsRevisionConflictError
		if !errors.As(err, &conflict) || conflict.Current.Revision != 1 {
			t.Fatalf("冲突 = %+v", err)
		}
	}

	value.ViewMode = "grid"
	raw, _ = json.Marshal(value)
	next, err := database.PutLibrarySettings(ctx, 1, raw)
	if err != nil || next.Revision != 2 {
		t.Fatalf("revision 2 = %+v, %v", next, err)
	}

	if _, err := database.PutLibrarySettings(ctx, 2, json.RawMessage(`{"viewMode":"grid"}`)); err == nil {
		t.Fatal("缺字段应拒绝")
	} else {
		var validation *librarysettings.ValidationError
		if !errors.As(err, &validation) {
			t.Fatalf("校验错误类型 = %T", err)
		}
	}
}

func TestLibrarySettingsIndependentFromAppearance(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	ctx := context.Background()

	appearanceBefore, err := database.GetAppearance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	value := librarysettings.DefaultValue()
	raw, _ := json.Marshal(value)
	if _, err := database.PutLibrarySettings(ctx, 0, raw); err != nil {
		t.Fatal(err)
	}
	appearanceAfter, err := database.GetAppearance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if appearanceAfter.Revision != appearanceBefore.Revision {
		t.Fatalf("library 写入污染 appearance: %+v", appearanceAfter)
	}

	if _, err := database.PutAppearance(ctx, 0, settings.DefaultAppearanceValue()); err != nil {
		t.Fatal(err)
	}
	libraryAfter, err := database.GetLibrarySettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if libraryAfter.Revision != 1 {
		t.Fatalf("appearance 写入污染 library: %+v", libraryAfter)
	}
}
