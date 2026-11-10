// Package settings 定义阅读器全局设置与单书稀疏覆盖的版本化 DTO 和校验。
// 三级继承为 built-in → 全局 reader → 本书覆盖；本包不访问数据库或 HTTP。
package settings

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"time"
)

// SchemaVersion 是阅读器设置 schema 版本。
const SchemaVersion int64 = 1

// Group 是 app_settings 中阅读器全局设置的分组键。
const Group = "reader"

// BuiltInVersion 是内置默认值版本；随默认字段变化递增。
const BuiltInVersion int64 = 1

// Record 是 store 层与 DTO 层共用的持久化投影。
type Record struct {
	SchemaVersion int64
	Revision      int64
	UpdatedAt     *time.Time
	Value         json.RawMessage
}

// GlobalDTO 是 GET/PUT /settings/reader 的统一数据形状。
type GlobalDTO struct {
	SchemaVersion int64          `json:"schemaVersion"`
	Revision      string         `json:"revision"`
	UpdatedAt     *string        `json:"updatedAt"`
	Value         map[string]any `json:"value"`
}

// BookDTO 是单书阅读设置的统一数据形状。
type BookDTO struct {
	SchemaVersion   int64                        `json:"schemaVersion"`
	BookID          string                       `json:"bookId"`
	FileVersion     string                       `json:"fileVersion"`
	Revision        string                       `json:"revision"`
	UpdatedAt       *string                      `json:"updatedAt"`
	Overrides       map[string]any               `json:"overrides"`
	EffectiveValues map[string]any               `json:"effectiveValues"`
	FieldSources    map[string]map[string]string `json:"fieldSources"`
	GlobalRevision  string                       `json:"globalRevision"`
	BuiltInVersion  int64                        `json:"builtInVersion"`
}

// ValidationError 是可安全返回给调用方的设置值错误；HTTP 层映射为 422。
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "阅读设置值无效"
}

func invalid(field, message string) *ValidationError {
	return &ValidationError{Field: field, Message: message}
}

var lowercaseHexColor = regexp.MustCompile(`^#[0-9a-f]{6}$`)

// DefaultValue 返回完整的内置默认阅读设置（按 reflow/pdf/comic 分组）。
func DefaultValue() map[string]any {
	return map[string]any{
		"reflow": map[string]any{
			"theme":            "inherit-app",
			"fontFamily":       "publisher",
			"publisherFont":    true,
			"fontSize":         int64(16),
			"fontWeight":       int64(400),
			"lineHeight":       1.6,
			"paragraphSpacing": 0.0,
			"textIndent":       0.0,
			"align":            "start",
			"horizontalMargin": int64(6),
			"verticalMargin":   int64(4),
			"maxWidth":         "auto",
			"pagination":       "pagination",
			"columns":          "1",
			"animation":        "none",
			"background":       "inherit",
			"text":             "inherit",
			"link":             "inherit",
			"selection":        "inherit",
			"publisherCSSMode": "publisher",
		},
		"pdf": map[string]any{
			"layoutMode":     "single",
			"zoomMode":       "fit-width",
			"manualScale":    1.0,
			"gap":            "standard",
			"background":     "inherit",
			"toolbarVisible": true,
		},
		"comic": map[string]any{
			"direction":  "ltr",
			"mode":       "single",
			"fit":        "screen",
			"gap":        "standard",
			"background": "inherit",
		},
	}
}

type fieldSpec struct {
	group string
	name  string
}

var fieldSpecs = []fieldSpec{
	{"reflow", "theme"},
	{"reflow", "fontFamily"},
	{"reflow", "publisherFont"},
	{"reflow", "fontSize"},
	{"reflow", "fontWeight"},
	{"reflow", "lineHeight"},
	{"reflow", "paragraphSpacing"},
	{"reflow", "textIndent"},
	{"reflow", "align"},
	{"reflow", "horizontalMargin"},
	{"reflow", "verticalMargin"},
	{"reflow", "maxWidth"},
	{"reflow", "pagination"},
	{"reflow", "columns"},
	{"reflow", "animation"},
	{"reflow", "background"},
	{"reflow", "text"},
	{"reflow", "link"},
	{"reflow", "selection"},
	{"reflow", "publisherCSSMode"},
	{"pdf", "layoutMode"},
	{"pdf", "zoomMode"},
	{"pdf", "manualScale"},
	{"pdf", "gap"},
	{"pdf", "background"},
	{"pdf", "toolbarVisible"},
	{"comic", "direction"},
	{"comic", "mode"},
	{"comic", "fit"},
	{"comic", "gap"},
	{"comic", "background"},
}

// ParseGlobalValue 校验全局设置值。允许空对象；只存显式字段，缺字段继承内置默认。
func ParseGlobalValue(raw []byte) (map[string]any, error) {
	return parseGroups(raw, "value")
}

// ParseOverrides 校验单书稀疏覆盖。未知字段、数组/标量与任意层级 null 均拒绝。
func ParseOverrides(raw []byte) (map[string]any, error) {
	return parseGroups(raw, "overrides")
}

func parseGroups(raw []byte, field string) (map[string]any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, invalid(field, "缺少 "+field)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, invalid(field, field+" 不是合法 JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, invalid(field, field+" 后存在多余内容")
	}
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil, invalid(field, field+" 必须是 JSON 对象")
	}
	for group, groupValue := range object {
		if group != "reflow" && group != "pdf" && group != "comic" {
			return nil, invalid(group, "未知的阅读设置分组 "+group)
		}
		groupObject, ok := groupValue.(map[string]any)
		if !ok || groupObject == nil {
			return nil, invalid(group, group+" 必须是 JSON 对象，不能为 null")
		}
		for name, fieldValue := range groupObject {
			if err := validateField(group, name, fieldValue); err != nil {
				return nil, err
			}
		}
	}
	return object, nil
}

func validateField(group, name string, value any) error {
	path := group + "." + name
	if value == nil {
		return invalid(path, path+" 不能为 null")
	}
	switch group {
	case "reflow":
		return validateReflowField(name, value, path)
	case "pdf":
		return validatePDFField(name, value, path)
	case "comic":
		return validateComicField(name, value, path)
	default:
		return invalid(path, "未知的阅读设置字段 "+path)
	}
}

func validateReflowField(name string, value any, path string) error {
	switch name {
	case "theme":
		return enumString(value, path, "inherit-app", "paper", "white", "gray", "midnight")
	case "fontFamily":
		return enumString(value, path, "publisher", "system-sans", "serif", "chinese-system")
	case "publisherFont":
		return boolValue(value, path)
	case "fontSize":
		return numberRange(value, path, 12, 48)
	case "fontWeight":
		weight, err := intValue(value, path)
		if err != nil {
			return err
		}
		if weight < 100 || weight > 900 || weight%100 != 0 {
			return invalid(path, "fontWeight 必须是 100–900 的整百数值")
		}
		return nil
	case "lineHeight":
		return numberRange(value, path, 1.2, 2.4)
	case "paragraphSpacing":
		return numberRange(value, path, 0, 3)
	case "textIndent":
		return numberRange(value, path, 0, 2)
	case "align":
		return enumString(value, path, "start", "justify")
	case "horizontalMargin", "verticalMargin":
		return numberRange(value, path, 0, 12)
	case "maxWidth":
		return maxWidthValue(value, path)
	case "pagination":
		return enumString(value, path, "pagination", "scroll")
	case "columns":
		return columnsValue(value, path)
	case "animation":
		return enumString(value, path, "none", "light")
	case "background", "text", "link", "selection":
		return colorValue(value, path)
	case "publisherCSSMode":
		return enumString(value, path, "publisher", "off")
	default:
		return invalid(path, "未知的阅读设置字段 "+path)
	}
}

func validatePDFField(name string, value any, path string) error {
	switch name {
	case "layoutMode":
		return enumString(value, path, "single", "continuous", "horizontal")
	case "zoomMode":
		return enumString(value, path, "fit-width", "fit-page", "manual")
	case "manualScale":
		return numberRange(value, path, 0.25, 4)
	case "gap":
		return enumString(value, path, "compact", "standard", "relaxed")
	case "background":
		return colorValue(value, path)
	case "toolbarVisible":
		return boolValue(value, path)
	default:
		return invalid(path, "未知的阅读设置字段 "+path)
	}
}

func validateComicField(name string, value any, path string) error {
	switch name {
	case "direction":
		return enumString(value, path, "ltr", "rtl")
	case "mode":
		return enumString(value, path, "single", "double", "continuous")
	case "fit":
		return enumString(value, path, "screen", "width", "original")
	case "gap":
		return enumString(value, path, "compact", "standard", "relaxed")
	case "background":
		return colorValue(value, path)
	default:
		return invalid(path, "未知的阅读设置字段 "+path)
	}
}

func enumString(value any, path string, allowed ...string) error {
	text, ok := value.(string)
	if !ok {
		return invalid(path, path+" 必须是字符串")
	}
	for _, candidate := range allowed {
		if text == candidate {
			return nil
		}
	}
	return invalid(path, path+" 不受支持")
}

func boolValue(value any, path string) error {
	if _, ok := value.(bool); !ok {
		return invalid(path, path+" 必须是布尔值")
	}
	return nil
}

func maxWidthValue(value any, path string) error {
	if text, ok := value.(string); ok {
		if text == "auto" {
			return nil
		}
		width, err := strconv.Atoi(text)
		if err != nil || strconv.Itoa(width) != text || width < 40 || width > 100 {
			return invalid(path, "maxWidth 必须是 \"auto\" 或 40–100 的整数字符串")
		}
		return nil
	}
	width, err := intValue(value, path)
	if err != nil {
		return invalid(path, "maxWidth 必须是 \"auto\" 或 40–100 的整数字符串")
	}
	if width < 40 || width > 100 {
		return invalid(path, "maxWidth 必须是 \"auto\" 或 40–100 的整数字符串")
	}
	return nil
}

func columnsValue(value any, path string) error {
	if text, ok := value.(string); ok {
		if text != "1" && text != "2" {
			return invalid(path, "columns 仅支持 \"1\" 或 \"2\"")
		}
		return nil
	}
	columns, err := intValue(value, path)
	if err != nil {
		return invalid(path, "columns 仅支持 \"1\" 或 \"2\"")
	}
	if columns != 1 && columns != 2 {
		return invalid(path, "columns 仅支持 \"1\" 或 \"2\"")
	}
	return nil
}

func numberValue(value any, path string) (float64, error) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, invalid(path, path+" 必须是数字")
	}
	parsed, err := number.Float64()
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, invalid(path, path+" 必须是有限数字")
	}
	return parsed, nil
}

func numberRange(value any, path string, min, max float64) error {
	parsed, err := numberValue(value, path)
	if err != nil {
		return err
	}
	if parsed < min || parsed > max {
		return invalid(path, fmt.Sprintf("%s 必须在 %g 到 %g 之间", path, min, max))
	}
	return nil
}

func intValue(value any, path string) (int64, error) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, invalid(path, path+" 必须是整数")
	}
	parsed, err := strconv.ParseInt(number.String(), 10, 64)
	if err != nil {
		return 0, invalid(path, path+" 必须是整数")
	}
	return parsed, nil
}

func colorValue(value any, path string) error {
	text, ok := value.(string)
	if !ok {
		return invalid(path, path+" 必须是颜色字符串")
	}
	switch text {
	case "inherit", "auto", "template", "paper", "white", "gray", "midnight":
		return nil
	}
	if lowercaseHexColor.MatchString(text) {
		return nil
	}
	return invalid(path, path+" 必须是预设名或小写 #rrggbb")
}

func deepCopyValue(value map[string]any) map[string]any {
	copied := make(map[string]any, len(value))
	for key, child := range value {
		if nested, ok := child.(map[string]any); ok {
			copied[key] = deepCopyValue(nested)
			continue
		}
		copied[key] = child
	}
	return copied
}

// Effective 解析 built-in → 全局 → 本书覆盖，并返回逐字段来源（按 reflow/pdf/comic 分组）。
func Effective(overrides, global map[string]any) (map[string]any, map[string]map[string]string) {
	effective := deepCopyValue(DefaultValue())
	sources := make(map[string]map[string]string, 3)
	for _, spec := range fieldSpecs {
		groupSources, ok := sources[spec.group]
		if !ok {
			groupSources = make(map[string]string)
			sources[spec.group] = groupSources
		}
		groupSources[spec.name] = "built-in"
	}
	apply := func(value map[string]any, source string) {
		for group, groupValue := range value {
			groupObject, ok := groupValue.(map[string]any)
			if !ok {
				continue
			}
			groupSources, ok := sources[group]
			if !ok {
				groupSources = make(map[string]string)
				sources[group] = groupSources
			}
			for name, fieldValue := range groupObject {
				effectiveGroup, ok := effective[group].(map[string]any)
				if !ok {
					continue
				}
				effectiveGroup[name] = fieldValue
				groupSources[name] = source
			}
		}
	}
	apply(global, "global")
	apply(overrides, "book")
	return effective, sources
}

func formatRevision(revision int64) string {
	return strconv.FormatInt(revision, 10)
}

func formatTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339)
	return &formatted
}

// GlobalDTOFrom 把持久化记录转换为 API DTO。
func GlobalDTOFrom(record Record) (GlobalDTO, error) {
	value, err := ParseGlobalValue(record.Value)
	if err != nil {
		return GlobalDTO{}, err
	}
	if value == nil {
		value = map[string]any{}
	}
	return GlobalDTO{
		SchemaVersion: SchemaVersion,
		Revision:      formatRevision(record.Revision),
		UpdatedAt:     formatTime(record.UpdatedAt),
		Value:         value,
	}, nil
}

// BookDTOFrom 解析单书覆盖与全局记录，返回三级继承后的完整 DTO。
func BookDTOFrom(bookID, fileVersion string, overrides, global Record) (BookDTO, error) {
	bookValue, err := ParseOverrides(overrides.Value)
	if err != nil {
		return BookDTO{}, err
	}
	if bookValue == nil {
		bookValue = map[string]any{}
	}
	globalValue, err := ParseGlobalValue(global.Value)
	if err != nil {
		return BookDTO{}, err
	}
	effective, sources := Effective(bookValue, globalValue)
	return BookDTO{
		SchemaVersion:   SchemaVersion,
		BookID:          bookID,
		FileVersion:     fileVersion,
		Revision:        formatRevision(overrides.Revision),
		UpdatedAt:       formatTime(overrides.UpdatedAt),
		Overrides:       bookValue,
		EffectiveValues: effective,
		FieldSources:    sources,
		GlobalRevision:  formatRevision(global.Revision),
		BuiltInVersion:  BuiltInVersion,
	}, nil
}

func containsNull(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case map[string]any:
		for _, child := range typed {
			if containsNull(child) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if containsNull(child) {
				return true
			}
		}
	}
	return false
}

// NormalizeStoredValue 校验数据库中的 JSON 对象；供 store 层避免写入形状损坏的数据。
func NormalizeStoredValue(raw []byte) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, invalid("value", "缺少 settings value")
	}
	var object map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&object); err != nil || object == nil {
		return nil, invalid("value", "settings value 必须是 JSON 对象")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, invalid("value", "settings value 后存在多余内容")
	}
	if containsNull(object) {
		return nil, invalid("value", "settings value 任意层级都不能为 null")
	}
	normalized, err := json.Marshal(object)
	if err != nil {
		return nil, invalid("value", "settings value 无法序列化")
	}
	return json.RawMessage(normalized), nil
}
