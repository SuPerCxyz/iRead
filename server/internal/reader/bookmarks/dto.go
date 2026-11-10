package bookmarks

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"iread/server/internal/reader/progress"
)

// SchemaVersion 是书签 DTO 与写入 schema 的版本。
const SchemaVersion int64 = 1

// DefaultListLimit 与 MaxListLimit 与 store 层保留策略一致。
const (
	DefaultListLimit = 50
	MaxListLimit     = 200
)

// DTO 是书签列表与创建返回的统一数据形状。
type DTO struct {
	SchemaVersion  int64           `json:"schemaVersion"`
	BookmarkID     string          `json:"bookmarkId"`
	BookID         string          `json:"bookId"`
	FileVersion    string          `json:"fileVersion"`
	Format         string          `json:"format"`
	LocatorType    string          `json:"locatorType"`
	LocatorPayload json.RawMessage `json:"locatorPayload"`
	Label          string          `json:"label"`
	Revision       string          `json:"revision"`
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
}

// ListMeta 是书签列表的游标元数据。
type ListMeta struct {
	NextCursor *string `json:"nextCursor"`
}

// ListResponse 是 GET 书签的顶层响应；不使用 data 再包一层。
type ListResponse struct {
	Data []DTO    `json:"data"`
	Meta ListMeta `json:"meta"`
}

// CreateInput 是通过 DTO 校验后的创建输入。
type CreateInput struct {
	FileVersion      string
	Format           string
	LocatorType      string
	LocatorPayload   json.RawMessage
	ClientMutationID string
	Label            string
	LocatorKey       string
}

type createWire struct {
	SchemaVersion    *int64          `json:"schemaVersion"`
	FileVersion      *string         `json:"fileVersion"`
	Format           *string         `json:"format"`
	LocatorType      *string         `json:"locatorType"`
	LocatorPayload   json.RawMessage `json:"locatorPayload"`
	ClientMutationID *string         `json:"clientMutationId"`
	Label            *string         `json:"label"`
}

// ParseCreate 严格解析 POST 书签请求并生成缺省 label。
func ParseCreate(raw []byte) (CreateInput, error) {
	var wire createWire
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return CreateInput{}, invalid("request", "请求体不是合法的书签对象")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return CreateInput{}, invalid("request", "请求体后存在多余内容")
	}
	if wire.SchemaVersion == nil {
		return CreateInput{}, invalid("schemaVersion", "缺少 schemaVersion")
	}
	if *wire.SchemaVersion != SchemaVersion {
		return CreateInput{}, invalid("schemaVersion", "schemaVersion 仅支持 1")
	}
	if wire.FileVersion == nil {
		return CreateInput{}, invalid("fileVersion", "缺少 fileVersion")
	}
	if !validLowerSHA256(*wire.FileVersion) {
		return CreateInput{}, invalid("fileVersion", "fileVersion 必须是 64 位小写 hex")
	}
	if wire.Format == nil {
		return CreateInput{}, invalid("format", "缺少 format")
	}
	if *wire.Format != "epub" && *wire.Format != "pdf" && *wire.Format != "cbz" && *wire.Format != "cbr" {
		return CreateInput{}, invalid("format", "format 仅支持 epub/pdf/cbz/cbr")
	}
	if wire.LocatorType == nil || strings.TrimSpace(*wire.LocatorType) == "" {
		return CreateInput{}, invalid("locatorType", "缺少 locatorType")
	}
	if len(bytes.TrimSpace(wire.LocatorPayload)) == 0 || bytes.Equal(bytes.TrimSpace(wire.LocatorPayload), []byte("null")) {
		return CreateInput{}, unsupported("locatorPayload", "缺少 locatorPayload 对象")
	}
	if wire.ClientMutationID == nil {
		return CreateInput{}, invalid("clientMutationId", "缺少 clientMutationId")
	}
	mutationID := strings.TrimSpace(*wire.ClientMutationID)
	if mutationID == "" || len(mutationID) > 200 || strings.ContainsFunc(mutationID, unicode.IsControl) {
		return CreateInput{}, invalid("clientMutationId", "clientMutationId 长度必须在 1 到 200 之间")
	}

	var label string
	if wire.Label != nil && strings.TrimSpace(*wire.Label) != "" {
		label = strings.TrimSpace(*wire.Label)
		if utf8.RuneCountInString(label) > 200 {
			return CreateInput{}, invalid("label", "label 长度必须在 1 到 200 之间")
		}
		if strings.ContainsFunc(label, unicode.IsControl) {
			return CreateInput{}, invalid("label", "label 不能包含控制字符")
		}
	}

	return CreateInput{
		FileVersion:      *wire.FileVersion,
		Format:           *wire.Format,
		LocatorType:      *wire.LocatorType,
		LocatorPayload:   append(json.RawMessage(nil), wire.LocatorPayload...),
		ClientMutationID: mutationID,
		Label:            label,
	}, nil
}

// ValidateForBook 校验原件身份、格式与 locator，并补齐 locator_key/缺省 label。
func (input CreateInput) ValidateForBook(bookFormat, bookFileVersion string) (CreateInput, error) {
	if input.FileVersion != bookFileVersion {
		return CreateInput{}, &progress.FileVersionConflictError{}
	}
	if input.Format != bookFormat {
		return CreateInput{}, unsupported("format", "format 与当前书籍不一致")
	}
	normalized, err := progress.ValidateLocation(input.Format, input.LocatorType, input.LocatorPayload)
	if err != nil {
		return CreateInput{}, err
	}
	key, err := progress.BuildBookmarkLocatorKey(input.LocatorType, normalized)
	if err != nil {
		return CreateInput{}, err
	}
	input.LocatorPayload = normalized
	input.LocatorKey = key
	if input.Label == "" {
		input.Label = progress.DefaultBookmarkLabel(input.LocatorType, normalized)
	}
	if input.Label == "" || utf8.RuneCountInString(input.Label) > 200 {
		return CreateInput{}, invalid("label", "label 长度必须在 1 到 200 之间")
	}
	return input, nil
}

// Cursor 是 createdAt DESC、bookmarkId DESC 的 keyset 游标。
type Cursor struct {
	BookID      string
	FileVersion string
	CreatedAt   time.Time
	ID          string
}

type cursorPayload struct {
	Version     int    `json:"v"`
	BookID      string `json:"bookId"`
	FileVersion string `json:"fileVersion"`
	CreatedAt   string `json:"createdAt"`
	ID          string `json:"id"`
}

// EncodeCursor 将最后一条记录编码为 base64url JSON 游标。
func EncodeCursor(bookID, fileVersion string, createdAt time.Time, bookmarkID string) string {
	payload := cursorPayload{
		Version:     1,
		BookID:      bookID,
		FileVersion: fileVersion,
		CreatedAt:   createdAt.UTC().Format(time.RFC3339Nano),
		ID:          bookmarkID,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

// ParseCursor 解析并校验游标；bookId/fileVersion 必须与当前查询一致。
func ParseCursor(value, bookID, fileVersion string) (Cursor, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return Cursor{}, false
	}
	var payload cursorPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return Cursor{}, false
	}
	if payload.Version != 1 || payload.BookID != bookID || payload.FileVersion != fileVersion ||
		!validHexID(payload.ID, 32) {
		return Cursor{}, false
	}
	createdAt, err := time.Parse(time.RFC3339Nano, payload.CreatedAt)
	if err != nil || createdAt.IsZero() {
		return Cursor{}, false
	}
	return Cursor{
		BookID:      payload.BookID,
		FileVersion: payload.FileVersion,
		CreatedAt:   createdAt.UTC(),
		ID:          payload.ID,
	}, true
}

func validHexID(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

func validLowerSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func invalid(field, message string) *progress.ValidationError {
	return &progress.ValidationError{Field: field, Message: message}
}

func unsupported(field, message string) *progress.ValidationError {
	return &progress.ValidationError{Field: field, Message: message, Unsupported: true}
}
