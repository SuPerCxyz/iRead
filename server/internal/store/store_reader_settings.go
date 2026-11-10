package store

// 阅读器全局设置（app_settings."group"='reader'）的条件写入。
// 本文件只处理全局组；单书覆盖在 store_reader.go 中，二者独立 revision。

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	readersettings "iread/server/internal/reader/settings"
)

// ReaderSettingsRevisionConflictError 表示全局阅读设置 baseRevision 已过期。
type ReaderSettingsRevisionConflictError struct {
	Current readersettings.Record
}

func (e *ReaderSettingsRevisionConflictError) Error() string {
	return "阅读设置已在另一处更新"
}

// ReaderSettingsRevisionLimitError 表示全局阅读设置 revision 已达上限。
type ReaderSettingsRevisionLimitError struct {
	Current readersettings.Record
}

func (e *ReaderSettingsRevisionLimitError) Error() string {
	return "阅读设置 revision 已达上限"
}

// DefaultReaderSettingsRecord 返回无持久化行时的默认全局记录。
func DefaultReaderSettingsRecord() readersettings.Record {
	return readersettings.Record{
		SchemaVersion: readersettings.SchemaVersion,
		Revision:      0,
		UpdatedAt:     nil,
		Value:         json.RawMessage(`{}`),
	}
}

func scanReaderSettings(row *sql.Row) (readersettings.Record, bool, error) {
	var schemaVersion, revision int64
	var rawValue, updatedAt string
	if err := row.Scan(&schemaVersion, &rawValue, &revision, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return DefaultReaderSettingsRecord(), false, nil
		}
		return readersettings.Record{}, false, fmt.Errorf("store: 读取阅读设置失败: %w", err)
	}
	value, err := readersettings.NormalizeStoredValue([]byte(rawValue))
	if err != nil {
		return readersettings.Record{}, false, fmt.Errorf("store: 阅读设置值无效: %w", err)
	}
	parsedTime, err := parseDBTime(updatedAt)
	if err != nil {
		return readersettings.Record{}, false, fmt.Errorf("store: 阅读设置更新时间无效: %w", err)
	}
	return readersettings.Record{
		SchemaVersion: schemaVersion,
		Revision:      revision,
		UpdatedAt:     &parsedTime,
		Value:         value,
	}, true, nil
}

// GetReaderSettings 返回全局阅读设置；无行时返回 revision 0、updatedAt null、value {}。
func (s *Store) GetReaderSettings(ctx context.Context) (readersettings.Record, error) {
	record, found, err := scanReaderSettings(s.db.QueryRowContext(ctx, `
		SELECT schema_version, value, revision, updated_at
		FROM app_settings WHERE "group" = ?`, readersettings.Group))
	if err != nil {
		return readersettings.Record{}, err
	}
	if !found {
		return DefaultReaderSettingsRecord(), nil
	}
	return record, nil
}

// PutReaderSettings 在互斥锁与事务内按 baseRevision 条件写入全局阅读设置。
func (s *Store) PutReaderSettings(ctx context.Context, baseRevision int64, value json.RawMessage) (readersettings.Record, error) {
	if baseRevision < 0 {
		return readersettings.Record{}, ErrReaderInvalidInput
	}
	normalized, err := readersettings.NormalizeStoredValue(value)
	if err != nil {
		return readersettings.Record{}, ErrReaderInvalidInput
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return readersettings.Record{}, fmt.Errorf("store: 开始阅读设置事务失败: %w", err)
	}
	defer func() { _ = s.rollback(tx) }()

	current, found, err := scanReaderSettings(tx.QueryRowContext(ctx, `
		SELECT schema_version, value, revision, updated_at
		FROM app_settings WHERE "group" = ?`, readersettings.Group))
	if err != nil {
		return readersettings.Record{}, err
	}
	if !found {
		current = DefaultReaderSettingsRecord()
	}
	if current.Revision != baseRevision {
		return readersettings.Record{}, &ReaderSettingsRevisionConflictError{Current: current}
	}
	if current.Revision == math.MaxInt64 {
		return readersettings.Record{}, &ReaderSettingsRevisionLimitError{Current: current}
	}

	now := s.nowUTC()
	updatedAt := formatStoreTime(now)
	nextRevision := current.Revision + 1
	if found {
		result, err := tx.ExecContext(ctx, `
			UPDATE app_settings
			SET schema_version = ?, value = ?, revision = ?, updated_at = ?
			WHERE "group" = ? AND revision = ?`,
			readersettings.SchemaVersion, string(normalized), nextRevision, updatedAt,
			readersettings.Group, current.Revision)
		if err != nil {
			return readersettings.Record{}, fmt.Errorf("store: 更新阅读设置失败: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return readersettings.Record{}, fmt.Errorf("store: 读取阅读设置写入结果失败: %w", err)
		}
		if affected != 1 {
			if err := s.rollback(tx); err != nil {
				return readersettings.Record{}, fmt.Errorf("store: 回滚阅读设置事务失败: %w", err)
			}
			latest, getErr := s.GetReaderSettings(ctx)
			if getErr != nil {
				return readersettings.Record{}, getErr
			}
			return readersettings.Record{}, &ReaderSettingsRevisionConflictError{Current: latest}
		}
	} else {
		result, err := tx.ExecContext(ctx, `
			INSERT INTO app_settings ("group", schema_version, value, revision, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT("group") DO NOTHING`,
			readersettings.Group, readersettings.SchemaVersion, string(normalized), nextRevision, updatedAt)
		if err != nil {
			return readersettings.Record{}, fmt.Errorf("store: 创建阅读设置失败: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return readersettings.Record{}, fmt.Errorf("store: 读取阅读设置创建结果失败: %w", err)
		}
		if affected == 0 {
			if err := s.rollback(tx); err != nil {
				return readersettings.Record{}, fmt.Errorf("store: 回滚阅读设置事务失败: %w", err)
			}
			latest, getErr := s.GetReaderSettings(ctx)
			if getErr != nil {
				return readersettings.Record{}, getErr
			}
			return readersettings.Record{}, &ReaderSettingsRevisionConflictError{Current: latest}
		}
	}

	written, writtenFound, err := scanReaderSettings(tx.QueryRowContext(ctx, `
		SELECT schema_version, value, revision, updated_at
		FROM app_settings WHERE "group" = ?`, readersettings.Group))
	if err != nil {
		return readersettings.Record{}, err
	}
	if !writtenFound {
		return readersettings.Record{}, fmt.Errorf("store: 阅读设置写入后不存在")
	}
	if err := tx.Commit(); err != nil {
		return readersettings.Record{}, fmt.Errorf("store: 提交阅读设置事务失败: %w", err)
	}
	return written, nil
}
