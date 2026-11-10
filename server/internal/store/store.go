// Package store 提供 SQLite 迁移、事务与外观设置持久化。
package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // 纯 Go SQLite 驱动，注册名 "sqlite"

	"iread/server/internal/settings"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// RevisionConflictError 表示 baseRevision 与服务端当前 revision 不一致。
type RevisionConflictError struct {
	Current settings.AppearanceRecord
}

func (e *RevisionConflictError) Error() string {
	return "设置已在另一处更新"
}

// RevisionLimitError 表示 revision 已达到 int64 上限，无法继续递增。
type RevisionLimitError struct {
	Current settings.AppearanceRecord
}

func (e *RevisionLimitError) Error() string {
	return "设置 revision 已达上限，无法继续写入"
}

// Store 封装阶段1单进程 SQLite 访问。
type Store struct {
	db     *sql.DB
	mu     sync.Mutex
	now    func() time.Time
	logger *slog.Logger
}

// Open 打开数据库、启用 WAL/pragmas 并执行版本化迁移。
func Open(ctx context.Context, databasePath string) (*Store, error) {
	return OpenWithLogger(ctx, databasePath, nil)
}

// OpenWithLogger 与 Open 相同，但允许注入应用 logger，避免回滚日志绕过日志配置。
func OpenWithLogger(ctx context.Context, databasePath string, logger *slog.Logger) (*Store, error) {
	if strings.TrimSpace(databasePath) == "" {
		return nil, errors.New("数据库路径不能为空")
	}
	_, statErr := os.Stat(databasePath)
	newDatabase := errors.Is(statErr, os.ErrNotExist)
	if statErr != nil && !newDatabase {
		return nil, fmt.Errorf("检查数据库文件失败: %w", statErr)
	}
	if err := os.MkdirAll(filepath.Dir(databasePath), 0o750); err != nil {
		return nil, fmt.Errorf("创建数据库目录失败: %w", err)
	}

	db, err := sql.Open("sqlite", buildDSN(databasePath))
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	// 阶段1单用户：单连接避免同进程写锁竞争；跨进程并发仍由 busy_timeout 兜底。
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("连接数据库失败: %w", err)
	}
	if newDatabase {
		if err := hardenDatabaseFiles(databasePath); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("收紧数据库文件权限失败: %w", err)
		}
	}
	if err := migrate(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	if newDatabase {
		if err := hardenDatabaseFiles(databasePath); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("收紧数据库文件权限失败: %w", err)
		}
	}

	store := &Store{db: db, now: time.Now, logger: logger}
	if err := store.Check(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("数据库自检失败: %w", err)
	}
	return store, nil
}

// hardenDatabaseFiles 仅用于本次新建的数据库；既有用户卷文件不做 chmod。
func hardenDatabaseFiles(databasePath string) error {
	for _, candidate := range []string{databasePath, databasePath + "-wal", databasePath + "-shm"} {
		info, err := os.Stat(candidate)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return err
		}
		if info.Mode().Perm() == 0o600 {
			continue
		}
		if err := os.Chmod(candidate, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func buildDSN(databasePath string) string {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(databasePath)}
	query := url.Values{}
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "synchronous(NORMAL)")
	query.Set("_txlock", "immediate")
	u.RawQuery = query.Encode()
	return u.String()
}

// Close 关闭数据库连接。
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// Ping 真正查询数据库连接。
func (s *Store) Ping(ctx context.Context) error {
	var one int
	if err := s.db.QueryRowContext(ctx, `SELECT 1`).Scan(&one); err != nil {
		return err
	}
	return nil
}

// requiredTables 是当前 schema 版本必须可读的表；仅使用编译期常量拼接查询。
var requiredTables = []string{
	"schema_migrations",
	"app_settings",
	"users",
	"sessions",
	"auth_contexts",
	"books",
	"book_files",
	"book_metadata",
	"background_tasks",
	"upload_intents",
	"book_manifests",
	"reading_progress",
	"progress_mutations",
	"bookmarks",
	"book_reader_overrides",
}

// Check 执行轻量真实查询，供健康检查使用；只返回表级错误，不泄露数据库路径。
func (s *Store) Check(ctx context.Context) error {
	if err := s.Ping(ctx); err != nil {
		return err
	}
	var migrations int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&migrations); err != nil {
		return err
	}
	if migrations == 0 {
		return errors.New("数据库尚未迁移")
	}
	for _, table := range requiredTables {
		var one int
		err := s.db.QueryRowContext(ctx, `SELECT 1 FROM "`+table+`" LIMIT 1`).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			// 表存在但为空也是可用状态。
			continue
		}
		if err != nil {
			return fmt.Errorf("数据库表 %s 不可用: %w", table, err)
		}
	}
	return nil
}

// GetAppearance 返回外观记录；无行时返回 revision "0" 的默认记录而不是错误。
func (s *Store) GetAppearance(ctx context.Context) (settings.AppearanceRecord, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT schema_version, value, revision, updated_at
		FROM app_settings
		WHERE "group" = ?`, settings.AppearanceGroup)
	record, found, err := scanAppearance(row)
	if err != nil {
		return settings.AppearanceRecord{}, err
	}
	if !found {
		return settings.DefaultAppearanceRecord(), nil
	}
	return record, nil
}

// PutAppearance 在互斥锁与事务内按 baseRevision 比较并写入，冲突时不写任何字段。
func (s *Store) PutAppearance(ctx context.Context, baseRevision int64, value settings.AppearanceValue) (settings.AppearanceRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return settings.AppearanceRecord{}, fmt.Errorf("开始事务失败: %w", err)
	}
	defer func() { _ = s.rollback(tx) }()

	row := tx.QueryRowContext(ctx, `
		SELECT schema_version, value, revision, updated_at
		FROM app_settings
		WHERE "group" = ?`, settings.AppearanceGroup)
	current, found, err := scanAppearance(row)
	if err != nil {
		return settings.AppearanceRecord{}, err
	}
	currentRevision := int64(0)
	if found {
		parsed, parseErr := settings.ParseRevision(current.Revision)
		if parseErr != nil {
			return settings.AppearanceRecord{}, fmt.Errorf("数据库 revision 无效: %w", parseErr)
		}
		currentRevision = parsed
	}
	if baseRevision != currentRevision {
		return settings.AppearanceRecord{}, &RevisionConflictError{Current: current}
	}
	if currentRevision == math.MaxInt64 {
		return settings.AppearanceRecord{}, &RevisionLimitError{Current: current}
	}

	rawValue, err := marshalAppearanceValue(value)
	if err != nil {
		return settings.AppearanceRecord{}, err
	}
	now := s.now().UTC()
	updatedAtNano := now.Format(time.RFC3339Nano)
	nextRevision := currentRevision + 1

	if found {
		result, err := tx.ExecContext(ctx, `
			UPDATE app_settings
			SET schema_version = ?, value = ?, revision = ?, updated_at = ?
			WHERE "group" = ? AND revision = ?`,
			settings.AppearanceSchemaVersion, rawValue, nextRevision, updatedAtNano,
			settings.AppearanceGroup, currentRevision)
		if err != nil {
			return settings.AppearanceRecord{}, fmt.Errorf("写入设置失败: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return settings.AppearanceRecord{}, fmt.Errorf("读取写入结果失败: %w", err)
		}
		if affected != 1 {
			// 事务仍持有唯一连接，先回滚再读取最新记录。
			if err := s.rollback(tx); err != nil {
				return settings.AppearanceRecord{}, fmt.Errorf("回滚设置事务失败: %w", err)
			}
			latest, getErr := s.GetAppearance(ctx)
			if getErr != nil {
				return settings.AppearanceRecord{}, getErr
			}
			return settings.AppearanceRecord{}, &RevisionConflictError{Current: latest}
		}
	} else {
		result, err := tx.ExecContext(ctx, `
			INSERT INTO app_settings ("group", schema_version, value, revision, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT("group") DO NOTHING`,
			settings.AppearanceGroup, settings.AppearanceSchemaVersion, rawValue, nextRevision, updatedAtNano)
		if err != nil {
			return settings.AppearanceRecord{}, fmt.Errorf("写入设置失败: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return settings.AppearanceRecord{}, fmt.Errorf("读取写入结果失败: %w", err)
		}
		if affected == 0 {
			// 其他进程先插入；回滚后返回当前记录，绝不覆盖。
			if err := s.rollback(tx); err != nil {
				return settings.AppearanceRecord{}, fmt.Errorf("回滚设置事务失败: %w", err)
			}
			latest, getErr := s.GetAppearance(ctx)
			if getErr != nil {
				return settings.AppearanceRecord{}, getErr
			}
			return settings.AppearanceRecord{}, &RevisionConflictError{Current: latest}
		}
	}

	if err := tx.Commit(); err != nil {
		return settings.AppearanceRecord{}, fmt.Errorf("提交设置失败: %w", err)
	}

	updatedAt := now.Format(time.RFC3339)
	return settings.AppearanceRecord{
		SchemaVersion: settings.AppearanceSchemaVersion,
		Revision:      settings.FormatRevision(nextRevision),
		UpdatedAt:     &updatedAt,
		Value:         value,
	}, nil
}

func (s *Store) rollback(tx *sql.Tx) error {
	err := tx.Rollback()
	if err == nil || errors.Is(err, sql.ErrTxDone) {
		return nil
	}
	if s.logger != nil {
		s.logger.Warn("回滚设置事务失败", "error", err)
	}
	return err
}

func marshalAppearanceValue(value settings.AppearanceValue) (string, error) {
	if err := value.Validate(); err != nil {
		return "", err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("序列化设置失败: %w", err)
	}
	return string(raw), nil
}

func scanAppearance(row *sql.Row) (settings.AppearanceRecord, bool, error) {
	var schemaVersion int64
	var rawValue, updatedAt string
	var revision int64
	if err := row.Scan(&schemaVersion, &rawValue, &revision, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return settings.DefaultAppearanceRecord(), false, nil
		}
		return settings.AppearanceRecord{}, false, fmt.Errorf("读取设置失败: %w", err)
	}
	if schemaVersion != settings.AppearanceSchemaVersion {
		return settings.AppearanceRecord{}, false, fmt.Errorf("数据库设置 schemaVersion 不受支持: %d", schemaVersion)
	}
	value, err := settings.ParseAppearanceValue([]byte(rawValue))
	if err != nil {
		return settings.AppearanceRecord{}, false, fmt.Errorf("数据库设置值无效: %w", err)
	}
	parsedTime, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return settings.AppearanceRecord{}, false, fmt.Errorf("数据库 updated_at 无效: %w", err)
	}
	apiTime := parsedTime.UTC().Format(time.RFC3339)
	return settings.AppearanceRecord{
		SchemaVersion: settings.AppearanceSchemaVersion,
		Revision:      settings.FormatRevision(revision),
		UpdatedAt:     &apiTime,
		Value:         value,
	}, true, nil
}

func migrate(ctx context.Context, db *sql.DB) error {
	return migrateFS(ctx, db, migrationFiles)
}

// migrateFS 在独立事务中应用尚未登记的迁移；拆分 fs.FS 便于验证失败回滚。
func migrateFS(ctx context.Context, db *sql.DB, migrationFS fs.FS) error {
	if _, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		)`); err != nil {
		return fmt.Errorf("创建迁移表失败: %w", err)
	}

	files, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("读取迁移文件失败: %w", err)
	}
	sort.Strings(files)

	for _, name := range files {
		version, err := migrationVersion(name)
		if err != nil {
			return err
		}

		var applied int
		err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, version).Scan(&applied)
		if err != nil {
			return fmt.Errorf("查询迁移状态失败: %w", err)
		}
		if applied > 0 {
			continue
		}

		script, err := fs.ReadFile(migrationFS, name)
		if err != nil {
			return fmt.Errorf("读取迁移 %s 失败: %w", name, err)
		}

		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("开始迁移事务失败: %w", err)
		}
		if _, err := tx.ExecContext(ctx, string(script)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("执行迁移 %s 失败: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
			version, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("登记迁移 %s 失败: %w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("提交迁移 %s 失败: %w", name, err)
		}
	}
	return nil
}

func migrationVersion(name string) (int, error) {
	base := path.Base(name)
	separator := strings.IndexByte(base, '_')
	if separator <= 0 {
		return 0, fmt.Errorf("迁移文件名无效: %s", base)
	}
	version, err := strconv.Atoi(base[:separator])
	if err != nil || version <= 0 {
		return 0, fmt.Errorf("迁移版本无效: %s", base)
	}
	return version, nil
}
