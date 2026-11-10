package library

import (
	"context"
	"encoding/json"
	"errors"

	librarysettings "iread/server/internal/library/settings"
	"iread/server/internal/store"
)

// SettingsError 是书库视图设置领域错误；HTTP 层可带当前记录返回 409。
type SettingsError struct {
	Status  int
	Code    string
	Message string
	Field   string
	Current *librarysettings.Record
}

func (e *SettingsError) Error() string {
	return e.Code
}

// GetLibrarySettings 返回无记录时的默认值，不伪造 updatedAt。
func (s *Service) GetLibrarySettings(ctx context.Context) (librarysettings.Record, *SettingsError) {
	record, err := s.store.GetLibrarySettings(ctx)
	if err != nil {
		s.logger.Error("读取书库设置失败", "error", err)
		return librarysettings.Record{}, &SettingsError{Status: 500, Code: "internal_error", Message: "服务器内部错误"}
	}
	return record, nil
}

// PutLibrarySettings 以 baseRevision 做 CAS；分组独立于 appearance/reader。
func (s *Service) PutLibrarySettings(ctx context.Context, baseRevision int64, value json.RawMessage) (librarysettings.Record, *SettingsError) {
	record, err := s.store.PutLibrarySettings(ctx, baseRevision, value)
	if err == nil {
		return record, nil
	}
	var validation *librarysettings.ValidationError
	if errors.As(err, &validation) {
		return librarysettings.Record{}, &SettingsError{
			Status: 422, Code: "invalid_request", Message: validation.Message, Field: validation.Field,
		}
	}
	var conflict *store.LibrarySettingsRevisionConflictError
	if errors.As(err, &conflict) {
		current := conflict.Current
		return librarysettings.Record{}, &SettingsError{
			Status: 409, Code: "revision_conflict", Message: "书库设置已在另一处更新", Current: &current,
		}
	}
	var limit *store.LibrarySettingsRevisionLimitError
	if errors.As(err, &limit) {
		current := limit.Current
		return librarysettings.Record{}, &SettingsError{
			Status: 409, Code: "revision_conflict", Message: "书库设置 revision 已达上限", Current: &current,
		}
	}
	s.logger.Error("保存书库设置失败", "error", err)
	return librarysettings.Record{}, &SettingsError{Status: 500, Code: "internal_error", Message: "服务器内部错误"}
}
