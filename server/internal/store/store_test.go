package store

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"iread/server/internal/settings"
)

func openTestStore(t *testing.T, dir string) *Store {
	t.Helper()
	database, err := Open(context.Background(), filepath.Join(dir, "iread.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func sampleValue(theme string) settings.AppearanceValue {
	value := settings.DefaultAppearanceValue()
	value.ThemeMode = theme
	return value
}

func TestOpenEnablesWALAndMigrates(t *testing.T) {
	dir := t.TempDir()
	database := openTestStore(t, dir)

	var journalMode string
	if err := database.db.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if journalMode != "wal" {
		t.Fatalf("journal_mode = %q，期望 wal", journalMode)
	}

	var migrations int
	if err := database.db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&migrations); err != nil {
		t.Fatal(err)
	}
	if migrations != 4 {
		t.Fatalf("迁移数量 = %d，期望 4", migrations)
	}

	var table string
	if err := database.db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'`).Scan(&table); err != nil {
		t.Fatalf("app_settings 表不存在: %v", err)
	}
}

func TestMigrationsAreRepeatable(t *testing.T) {
	dir := t.TempDir()
	first := openTestStore(t, dir)
	if _, err := first.GetAppearance(context.Background()); err != nil {
		t.Fatalf("首次 GetAppearance() error = %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second := openTestStore(t, dir)
	var migrations int
	if err := second.db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&migrations); err != nil {
		t.Fatal(err)
	}
	if migrations != 4 {
		t.Fatalf("重复打开后迁移数量 = %d", migrations)
	}
}

func TestOpenFailure(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(context.Background(), filepath.Join(blocker, "db", "iread.db")); err == nil {
		t.Fatal("父路径为普通文件时 Open 应失败")
	}

	if _, err := Open(context.Background(), dir); err == nil {
		t.Fatal("数据库路径为目录时 Open 应失败")
	}
}

func TestGetAppearanceDefaultsWhenEmpty(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	record, err := database.GetAppearance(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if record.Revision != "0" || record.UpdatedAt != nil || record.SchemaVersion != 1 {
		t.Fatalf("默认记录 = %+v", record)
	}
	if record.Value != settings.DefaultAppearanceValue() {
		t.Fatalf("默认值 = %+v", record.Value)
	}
}

func TestPutAppearanceIncrementsAndPersists(t *testing.T) {
	dir := t.TempDir()
	database := openTestStore(t, dir)
	ctx := context.Background()

	created, err := database.PutAppearance(ctx, 0, sampleValue("dark"))
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != "1" || created.UpdatedAt == nil {
		t.Fatalf("首次写入记录 = %+v", created)
	}
	if created.Value.ThemeMode != "dark" {
		t.Fatalf("首次写入值 = %+v", created.Value)
	}

	updated, err := database.PutAppearance(ctx, 1, sampleValue("light"))
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != "2" {
		t.Fatalf("二次写入 revision = %q", updated.Revision)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	reopened := openTestStore(t, dir)
	got, err := reopened.GetAppearance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != "2" || got.Value.ThemeMode != "light" || got.UpdatedAt == nil {
		t.Fatalf("重开后记录 = %+v", got)
	}
}

func TestPutAppearanceRevisionConflictDoesNotWrite(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	ctx := context.Background()

	first, err := database.PutAppearance(ctx, 0, sampleValue("dark"))
	if err != nil {
		t.Fatal(err)
	}

	_, err = database.PutAppearance(ctx, 0, sampleValue("light"))
	var conflict *RevisionConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("错误类型 = %T, %v", err, err)
	}
	if conflict.Current.Revision != "1" || conflict.Current.Value.ThemeMode != "dark" {
		t.Fatalf("冲突当前记录 = %+v", conflict.Current)
	}
	if conflict.Current.UpdatedAt == nil || first.UpdatedAt == nil || *conflict.Current.UpdatedAt != *first.UpdatedAt {
		t.Fatalf("冲突不应改写 updatedAt: first=%v current=%v", first.UpdatedAt, conflict.Current.UpdatedAt)
	}

	got, err := database.GetAppearance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != "1" || got.Value.ThemeMode != "dark" {
		t.Fatalf("冲突后记录 = %+v", got)
	}
}

func TestNewDatabasePermissions(t *testing.T) {
	dir := t.TempDir()
	databasePath := filepath.Join(dir, "iread.db")
	database, err := Open(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	for _, suffix := range []string{"", "-wal", "-shm"} {
		path := databasePath + suffix
		info, err := os.Stat(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) && suffix != "" {
				continue
			}
			t.Fatalf("%s 不存在: %v", path, err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s 权限 = %o，期望 600", path, info.Mode().Perm())
		}
	}
}

func TestExistingDatabasePermissionsArePreserved(t *testing.T) {
	dir := t.TempDir()
	databasePath := filepath.Join(dir, "iread.db")
	first, err := Open(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(databasePath, 0o644); err != nil {
		t.Fatal(err)
	}

	second, err := Open(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	info, err := os.Stat(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("既有数据库权限被改写为 %o", info.Mode().Perm())
	}
}

func TestTwoStoresConcurrentPutReturnsConflict(t *testing.T) {
	dir := t.TempDir()
	databasePath := filepath.Join(dir, "iread.db")
	first := openTestStore(t, dir)
	second, err := Open(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()

	start := make(chan struct{})
	results := make(chan error, 2)
	for _, database := range []*Store{first, second} {
		go func(database *Store) {
			<-start
			_, err := database.PutAppearance(context.Background(), 0, sampleValue("dark"))
			results <- err
		}(database)
	}
	close(start)

	var successes, conflicts int
	for i := 0; i < 2; i++ {
		err := <-results
		var conflict *RevisionConflictError
		switch {
		case err == nil:
			successes++
		case errors.As(err, &conflict):
			conflicts++
		default:
			t.Fatalf("意外错误: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("success=%d conflict=%d", successes, conflicts)
	}
}

func TestPutAppearanceRevisionLimit(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	ctx := context.Background()
	raw, err := json.Marshal(sampleValue("dark"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.db.ExecContext(ctx, `
		INSERT INTO app_settings ("group", schema_version, value, revision, updated_at)
		VALUES (?, 1, ?, ?, ?)`,
		settings.AppearanceGroup, string(raw), int64(math.MaxInt64), time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}

	_, err = database.PutAppearance(ctx, math.MaxInt64, sampleValue("light"))
	var limit *RevisionLimitError
	if !errors.As(err, &limit) {
		t.Fatalf("错误类型 = %T, %v", err, err)
	}
	if limit.Current.Revision != strconv.FormatInt(math.MaxInt64, 10) {
		t.Fatalf("当前 revision = %q", limit.Current.Revision)
	}

	got, err := database.GetAppearance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != strconv.FormatInt(math.MaxInt64, 10) || got.Value.ThemeMode != "dark" {
		t.Fatalf("上限场景被改写: %+v", got)
	}
}

func TestCheckFailsWhenAppSettingsTableIsMissing(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	if _, err := database.db.Exec(`DROP TABLE app_settings`); err != nil {
		t.Fatal(err)
	}
	if err := database.Check(context.Background()); err == nil {
		t.Fatal("app_settings 缺失时 Check() 应失败")
	}
}

func TestCheckAfterClose(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	ctx := context.Background()
	if err := database.Ping(ctx); err != nil {
		t.Fatalf("Ping() error = %v", err)
	}
	if err := database.Check(ctx); err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if err := database.Ping(ctx); err == nil {
		t.Fatal("关闭后 Ping() 应失败")
	}
	if err := database.Check(ctx); err == nil {
		t.Fatal("关闭后 Check() 应失败")
	}
}
