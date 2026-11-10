package store

// 书库视图设置（app_settings."group"='library'）的条件写入。
// 与 appearance/reader 分组独立 revision，互不影响。

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	librarysettings "iread/server/internal/library/settings"
)

// LibrarySettingsRevisionConflictError 表示书库设置 baseRevision 已过期。
type LibrarySettingsRevisionConflictError struct {
	Current librarysettings.Record
}

func (e *LibrarySettingsRevisionConflictError) Error() string {
	return "书库设置已在另一处更新"
}

// LibrarySettingsRevisionLimitError 表示书库设置 revision 已达上限。
type LibrarySettingsRevisionLimitError struct {
	Current librarysettings.Record
}

func (e *LibrarySettingsRevisionLimitError) Error() string {
	return "书库设置 revision 已达上限"
}

// DefaultLibrarySettingsRecord 返回无持久化行时的默认记录。
func DefaultLibrarySettingsRecord() librarysettings.Record {
	return librarysettings.Record{
		SchemaVersion: librarysettings.SchemaVersion,
		Revision:      0,
		UpdatedAt:     nil,
		Value:         librarysettings.DefaultJSON(),
	}
}

func scanLibrarySettings(row *sql.Row) (librarysettings.Record, bool, error) {
	var schemaVersion, revision int64
	var rawValue, updatedAt string
	if err := row.Scan(&schemaVersion, &rawValue, &revision, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return DefaultLibrarySettingsRecord(), false, nil
		}
		return librarysettings.Record{}, false, fmt.Errorf("store: 读取书库设置失败: %w", err)
	}
	if schemaVersion != librarysettings.SchemaVersion {
		return librarysettings.Record{}, false, fmt.Errorf("store: 书库设置 schemaVersion 不受支持: %d", schemaVersion)
	}
	value, err := librarysettings.NormalizeStoredValue([]byte(rawValue))
	if err != nil {
		return librarysettings.Record{}, false, fmt.Errorf("store: 书库设置值无效: %w", err)
	}
	parsedTime, err := parseDBTime(updatedAt)
	if err != nil {
		return librarysettings.Record{}, false, fmt.Errorf("store: 书库设置更新时间无效: %w", err)
	}
	return librarysettings.Record{
		SchemaVersion: schemaVersion,
		Revision:      revision,
		UpdatedAt:     &parsedTime,
		Value:         value,
	}, true, nil
}

// GetLibrarySettings 返回书库视图设置；无行时返回 revision 0、updatedAt null、默认值。
func (s *Store) GetLibrarySettings(ctx context.Context) (librarysettings.Record, error) {
	record, found, err := scanLibrarySettings(s.db.QueryRowContext(ctx, `
		SELECT schema_version, value, revision, updated_at
		FROM app_settings WHERE "group" = ?`, librarysettings.Group))
	if err != nil {
		return librarysettings.Record{}, err
	}
	if !found {
		return DefaultLibrarySettingsRecord(), nil
	}
	return record, nil
}

// PutLibrarySettings 在互斥锁与事务内按 baseRevision 条件写入书库视图设置。
func (s *Store) PutLibrarySettings(ctx context.Context, baseRevision int64, value json.RawMessage) (librarysettings.Record, error) {
	if baseRevision < 0 {
		return librarysettings.Record{}, &librarysettings.ValidationError{Field: "baseRevision", Message: "baseRevision 不能为负数"}
	}
	normalized, err := librarysettings.NormalizeStoredValue(value)
	if err != nil {
		return librarysettings.Record{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return librarysettings.Record{}, fmt.Errorf("store: 开始书库设置事务失败: %w", err)
	}
	defer func() { _ = s.rollback(tx) }()

	current, found, err := scanLibrarySettings(tx.QueryRowContext(ctx, `
		SELECT schema_version, value, revision, updated_at
		FROM app_settings WHERE "group" = ?`, librarysettings.Group))
	if err != nil {
		return librarysettings.Record{}, err
	}
	if !found {
		current = DefaultLibrarySettingsRecord()
	}
	if current.Revision != baseRevision {
		return librarysettings.Record{}, &LibrarySettingsRevisionConflictError{Current: current}
	}
	if current.Revision == math.MaxInt64 {
		return librarysettings.Record{}, &LibrarySettingsRevisionLimitError{Current: current}
	}

	now := s.nowUTC()
	updatedAt := formatStoreTime(now)
	nextRevision := current.Revision + 1
	if found {
		result, err := tx.ExecContext(ctx, `
			UPDATE app_settings
			SET schema_version = ?, value = ?, revision = ?, updated_at = ?
			WHERE "group" = ? AND revision = ?`,
			librarysettings.SchemaVersion, string(normalized), nextRevision, updatedAt,
			librarysettings.Group, current.Revision)
		if err != nil {
			return librarysettings.Record{}, fmt.Errorf("store: 更新书库设置失败: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return librarysettings.Record{}, fmt.Errorf("store: 读取书库设置写入结果失败: %w", err)
		}
		if affected != 1 {
			if err := s.rollback(tx); err != nil {
				return librarysettings.Record{}, fmt.Errorf("store: 回滚书库设置事务失败: %w", err)
			}
			latest, getErr := s.GetLibrarySettings(ctx)
			if getErr != nil {
				return librarysettings.Record{}, getErr
			}
			return librarysettings.Record{}, &LibrarySettingsRevisionConflictError{Current: latest}
		}
	} else {
		result, err := tx.ExecContext(ctx, `
			INSERT INTO app_settings ("group", schema_version, value, revision, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT("group") DO NOTHING`,
			librarysettings.Group, librarysettings.SchemaVersion, string(normalized), nextRevision, updatedAt)
		if err != nil {
			return librarysettings.Record{}, fmt.Errorf("store: 创建书库设置失败: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return librarysettings.Record{}, fmt.Errorf("store: 读取书库设置创建结果失败: %w", err)
		}
		if affected == 0 {
			if err := s.rollback(tx); err != nil {
				return librarysettings.Record{}, fmt.Errorf("store: 回滚书库设置事务失败: %w", err)
			}
			latest, getErr := s.GetLibrarySettings(ctx)
			if getErr != nil {
				return librarysettings.Record{}, getErr
			}
			return librarysettings.Record{}, &LibrarySettingsRevisionConflictError{Current: latest}
		}
	}

	written, writtenFound, err := scanLibrarySettings(tx.QueryRowContext(ctx, `
		SELECT schema_version, value, revision, updated_at
		FROM app_settings WHERE "group" = ?`, librarysettings.Group))
	if err != nil {
		return librarysettings.Record{}, err
	}
	if !writtenFound {
		return librarysettings.Record{}, fmt.Errorf("store: 书库设置写入后不存在")
	}
	if err := tx.Commit(); err != nil {
		return librarysettings.Record{}, fmt.Errorf("store: 提交书库设置事务失败: %w", err)
	}
	return written, nil
}
