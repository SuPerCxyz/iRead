package progress

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode"
)

// SchemaVersion 是进度 DTO 与写入 schema 的版本。
const SchemaVersion int64 = 1

// DTO 是 GET/PUT 进度返回的统一数据形状；revision 为十进制字符串。
type DTO struct {
	SchemaVersion   int64           `json:"schemaVersion"`
	BookID          string          `json:"bookId"`
	FileVersion     string          `json:"fileVersion"`
	Format          string          `json:"format"`
	LocatorType     string          `json:"locatorType"`
	LocatorPayload  json.RawMessage `json:"locatorPayload"`
	ProgressPercent float64         `json:"progressPercent"`
	UpdatedAt       string          `json:"updatedAt"`
	Revision        string          `json:"revision"`
}

// PutInput 是通过 DTO 校验后的条件写入输入。
type PutInput struct {
	FileVersion      string
	BaseRevision     int64
	ClientMutationID string
	Format           string
	LocatorType      string
	LocatorPayload   json.RawMessage
	ProgressPercent  float64
}

// FileVersionConflictError 表示请求的 fileVersion 与当前原件不一致。
type FileVersionConflictError struct{}

func (e *FileVersionConflictError) Error() string { return "原件版本已变化" }

type putWire struct {
	SchemaVersion    *int64          `json:"schemaVersion"`
	FileVersion      *string         `json:"fileVersion"`
	BaseRevision     *string         `json:"baseRevision"`
	ClientMutationID *string         `json:"clientMutationId"`
	Format           *string         `json:"format"`
	LocatorType      *string         `json:"locatorType"`
	LocatorPayload   json.RawMessage `json:"locatorPayload"`
	ProgressPercent  *float64        `json:"progressPercent"`
}

// ParsePut 严格解析 PUT 进度请求；未知字段、缺失字段与非十进制 revision 均拒绝。
func ParsePut(raw []byte) (PutInput, error) {
	var wire putWire
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return PutInput{}, invalid("request", "请求体不是合法的进度对象")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return PutInput{}, invalid("request", "请求体后存在多余内容")
	}
	if wire.SchemaVersion == nil {
		return PutInput{}, invalid("schemaVersion", "缺少 schemaVersion")
	}
	if *wire.SchemaVersion != SchemaVersion {
		return PutInput{}, invalid("schemaVersion", "schemaVersion 仅支持 1")
	}
	if wire.FileVersion == nil {
		return PutInput{}, invalid("fileVersion", "缺少 fileVersion")
	}
	if !validLowerSHA256(*wire.FileVersion) {
		return PutInput{}, invalid("fileVersion", "fileVersion 必须是 64 位小写 hex")
	}
	if wire.BaseRevision == nil {
		return PutInput{}, invalid("baseRevision", "缺少 baseRevision")
	}
	baseRevision, err := parseRevision(*wire.BaseRevision)
	if err != nil {
		return PutInput{}, err
	}
	if wire.ClientMutationID == nil {
		return PutInput{}, invalid("clientMutationId", "缺少 clientMutationId")
	}
	mutationID := strings.TrimSpace(*wire.ClientMutationID)
	if mutationID == "" || len(mutationID) > 200 || strings.ContainsFunc(mutationID, unicode.IsControl) {
		return PutInput{}, invalid("clientMutationId", "clientMutationId 长度必须在 1 到 200 之间")
	}
	if wire.Format == nil {
		return PutInput{}, invalid("format", "缺少 format")
	}
	format := *wire.Format
	if format != "epub" && format != "pdf" && format != "cbz" && format != "cbr" {
		return PutInput{}, invalid("format", "format 仅支持 epub/pdf/cbz/cbr")
	}
	if wire.LocatorType == nil || strings.TrimSpace(*wire.LocatorType) == "" {
		return PutInput{}, invalid("locatorType", "缺少 locatorType")
	}
	if len(bytes.TrimSpace(wire.LocatorPayload)) == 0 || bytes.Equal(bytes.TrimSpace(wire.LocatorPayload), []byte("null")) {
		return PutInput{}, unsupported("locatorPayload", "缺少 locatorPayload 对象")
	}
	if wire.ProgressPercent == nil {
		return PutInput{}, invalid("progressPercent", "缺少 progressPercent")
	}
	percent := *wire.ProgressPercent
	if math.IsNaN(percent) || math.IsInf(percent, 0) || percent < 0 || percent > 100 {
		return PutInput{}, invalid("progressPercent", "progressPercent 必须在 0 到 100 之间")
	}

	return PutInput{
		FileVersion:      *wire.FileVersion,
		BaseRevision:     baseRevision,
		ClientMutationID: mutationID,
		Format:           format,
		LocatorType:      *wire.LocatorType,
		LocatorPayload:   append(json.RawMessage(nil), wire.LocatorPayload...),
		ProgressPercent:  percent,
	}, nil
}

// ValidateForBook 校验原件身份、格式与 locator 语义。
func (input PutInput) ValidateForBook(bookFormat, bookFileVersion string) error {
	if input.FileVersion != bookFileVersion {
		return &FileVersionConflictError{}
	}
	if input.Format != bookFormat {
		return unsupported("format", "format 与当前书籍不一致")
	}
	_, err := ValidateLocation(input.Format, input.LocatorType, input.LocatorPayload)
	return err
}

// NormalizedLocation 返回与 ValidateForBook 相同的归一化 locator。
func (input PutInput) NormalizedLocation() (json.RawMessage, error) {
	return ValidateLocation(input.Format, input.LocatorType, input.LocatorPayload)
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

func parseRevision(text string) (int64, error) {
	if text == "" {
		return 0, invalid("baseRevision", "缺少 baseRevision")
	}
	if len(text) > 1 && text[0] == '0' {
		return 0, invalid("baseRevision", "baseRevision 格式无效")
	}
	for i := 0; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return 0, invalid("baseRevision", "baseRevision 格式无效")
		}
	}
	revision, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return 0, invalid("baseRevision", "baseRevision 超出范围")
	}
	return revision, nil
}
