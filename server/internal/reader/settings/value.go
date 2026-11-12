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
// 版本 2：PDF 默认缩放从 fit-width 改为 manual 100%。
const BuiltInVersion int64 = 2

// Profile 区分同一本书在桌面/平板（web）与手机（mobile）视口下的稀疏覆盖。
// 全局设置仍只有一份，不按 profile 拆分。
type Profile string

const (
	// ProfileWeb 对应视口宽度 >= 768px。
	ProfileWeb Profile = "web"
	// ProfileMobile 对应视口宽度 < 768px。
	ProfileMobile Profile = "mobile"
	// DefaultProfile 是省略 profile 查询参数时的默认值，兼容旧客户端。
	DefaultProfile = ProfileWeb
)

// ParseProfile 解析 API 与存储使用的 profile 名称。
func ParseProfile(value string) (Profile, bool) {
	switch Profile(value) {
	case ProfileWeb, ProfileMobile:
		return Profile(value), true
	default:
		return "", false
	}
}

// Valid 报告 profile 是否受支持。
func (p Profile) Valid() bool {
	_, ok := ParseProfile(string(p))
	return ok
}

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
	Profile         string                       `json:"profile"`
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
	// Details 是附加的结构化信息，只包含字段名、颜色值与对比度，不含存储细节。
	Details map[string]any
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
			"layoutMode":  "single",
			"zoomMode":    "manual",
			"manualScale": 1.0,
			"gap":         "standard",
			"background":  "inherit",
			// toolbarVisible 已废弃：前端 PDF 引擎中间工具栏已移除。仅保留字段以兼容旧版客户端 JSON，不再作为新默认展示。
			"toolbarVisible": false,
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
	// 已废弃字段：保留校验与兼容解析，避免旧客户端 JSON 被拒绝。
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
	object, err := decodeJSONObject(raw, field)
	if err != nil {
		return nil, err
	}
	return parseGroupsObject(object)
}

// decodeJSONObject 解析严格 JSON 对象；UseNumber 保留客户端数字字面量。
func decodeJSONObject(raw []byte, field string) (map[string]any, error) {
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
	return object, nil
}

func parseGroupsObject(object map[string]any) (map[string]any, error) {
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
		if group == "reflow" {
			if err := validateReflowContrast(groupObject); err != nil {
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

// minimumReaderContrast 是正文、链接、选区背景相对文字的最低 WCAG 对比度。
const minimumReaderContrast = 4.5

// reflowContrastPairs 只覆盖同一请求中同时给出 hex 的颜色对；
// 预设名、inherit 以及缺失字段由继承层或客户端处理，不在服务端计算。
var reflowContrastPairs = []struct {
	field      string
	foreground string
	background string
}{
	{field: "text", foreground: "text", background: "background"},
	{field: "link", foreground: "link", background: "background"},
	{field: "selection", foreground: "text", background: "selection"},
}

func validateReflowContrast(group map[string]any) error {
	for _, pair := range reflowContrastPairs {
		foreground, ok := hexColor(group[pair.foreground])
		if !ok {
			continue
		}
		background, ok := hexColor(group[pair.background])
		if !ok {
			continue
		}
		ratio := contrastRatio(relativeLuminance(foreground), relativeLuminance(background))
		if ratio >= minimumReaderContrast {
			continue
		}
		displayRatio := math.Round(ratio*1000) / 1000
		fieldPath := "reflow." + pair.field
		foregroundPath := "reflow." + pair.foreground
		backgroundPath := "reflow." + pair.background
		return &ValidationError{
			Field: fieldPath,
			Message: fmt.Sprintf("%s 与 %s 的对比度 %.3f:1 低于 %g:1",
				fieldPath, backgroundPath, displayRatio, minimumReaderContrast),
			Details: map[string]any{
				"pair":       []string{foregroundPath, backgroundPath},
				"foreground": foreground,
				"background": background,
				"ratio":      displayRatio,
				"minimum":    minimumReaderContrast,
			},
		}
	}
	return nil
}

func hexColor(value any) (string, bool) {
	text, ok := value.(string)
	if !ok || !lowercaseHexColor.MatchString(text) {
		return "", false
	}
	return text, true
}

// relativeLuminance 按 WCAG 2.x 计算 sRGB 颜色的相对亮度。
func relativeLuminance(color string) float64 {
	channels := make([]float64, 3)
	for i := 0; i < 3; i++ {
		raw, _ := strconv.ParseInt(color[1+i*2:3+i*2], 16, 64)
		channels[i] = linearizeChannel(float64(raw) / 255)
	}
	return 0.2126*channels[0] + 0.7152*channels[1] + 0.0722*channels[2]
}

func linearizeChannel(channel float64) float64 {
	if channel <= 0.04045 {
		return channel / 12.92
	}
	return math.Pow((channel+0.055)/1.055, 2.4)
}

func contrastRatio(a, b float64) float64 {
	if a < b {
		a, b = b, a
	}
	return (a + 0.05) / (b + 0.05)
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

// ProfileOverrides 从持久化 JSON 中取出指定 profile 的稀疏覆盖。
// 兼容旧版顶层 {reflow,pdf,comic}：没有 profiles 时作为 web/mobile 两个 profile 的回退。
func ProfileOverrides(raw []byte, profile Profile) (map[string]any, error) {
	if !profile.Valid() {
		return nil, invalid("profile", "profile 仅支持 web 或 mobile")
	}
	object, err := decodeJSONObject(raw, "overrides")
	if err != nil {
		return nil, err
	}
	profilesValue, hasProfiles := object["profiles"]
	if !hasProfiles {
		return parseGroupsObject(object)
	}
	if schemaVersion, ok := object["schemaVersion"]; ok {
		if err := validateStoredSchemaVersion(schemaVersion); err != nil {
			return nil, err
		}
	}
	profiles, ok := profilesValue.(map[string]any)
	if !ok || profiles == nil {
		return nil, invalid("profiles", "profiles 必须是 JSON 对象")
	}
	profileValue, ok := profiles[string(profile)]
	if !ok {
		return map[string]any{}, nil
	}
	profileObject, ok := profileValue.(map[string]any)
	if !ok || profileObject == nil {
		return nil, invalid("profiles."+string(profile), "profile 覆盖必须是 JSON 对象，不能为 null")
	}
	return parseGroupsObject(profileObject)
}

func validateStoredSchemaVersion(value any) error {
	number, ok := value.(json.Number)
	if !ok {
		return invalid("schemaVersion", "schemaVersion 必须是整数")
	}
	parsed, err := strconv.ParseInt(number.String(), 10, 64)
	if err != nil || parsed != SchemaVersion {
		return invalid("schemaVersion", "schemaVersion 仅支持 1")
	}
	return nil
}

// MergeProfileOverrides 把客户端提交的单个 profile 稀疏覆盖并入持久化 JSON，返回新信封。
// 旧版顶层覆盖在首次按 profile 写入时复制到 web 与 mobile，确保另一 profile 不丢数据；
// 已存在的其他 profile 与未知 profile 键原样保留。本函数只校验 JSON 对象形状，
// reflow/pdf/comic 字段语义仍由 HTTP 层的 ParseOverrides 校验。
func MergeProfileOverrides(raw []byte, profile Profile, nextRaw []byte) (json.RawMessage, error) {
	if !profile.Valid() {
		return nil, invalid("profile", "profile 仅支持 web 或 mobile")
	}
	object, err := decodeJSONObject(raw, "overrides")
	if err != nil {
		return nil, err
	}
	next, err := decodeJSONObject(nextRaw, "overrides")
	if err != nil {
		return nil, err
	}
	if containsNull(next) {
		return nil, invalid("overrides", "overrides 任意层级都不能为 null")
	}

	profiles := make(map[string]any, 2)
	if profilesValue, ok := object["profiles"]; ok {
		if schemaVersion, ok := object["schemaVersion"]; ok {
			if err := validateStoredSchemaVersion(schemaVersion); err != nil {
				return nil, err
			}
		}
		existing, ok := profilesValue.(map[string]any)
		if !ok || existing == nil {
			return nil, invalid("profiles", "profiles 必须是 JSON 对象")
		}
		for name, value := range existing {
			profiles[name] = value
		}
	} else {
		legacy := deepCopyValue(object)
		profiles[string(ProfileWeb)] = deepCopyValue(legacy)
		profiles[string(ProfileMobile)] = deepCopyValue(legacy)
	}
	if _, ok := profiles[string(ProfileWeb)]; !ok {
		profiles[string(ProfileWeb)] = map[string]any{}
	}
	if _, ok := profiles[string(ProfileMobile)]; !ok {
		profiles[string(ProfileMobile)] = map[string]any{}
	}
	profiles[string(profile)] = deepCopyValue(next)

	envelope := struct {
		SchemaVersion int64          `json:"schemaVersion"`
		Profiles      map[string]any `json:"profiles"`
	}{
		SchemaVersion: SchemaVersion,
		Profiles:      profiles,
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return nil, invalid("overrides", "overrides 无法序列化")
	}
	return json.RawMessage(encoded), nil
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

// BookDTOFrom 解析单书覆盖与全局记录，返回指定 profile 三级继承后的完整 DTO。
func BookDTOFrom(bookID, fileVersion string, overrides, global Record, profile Profile) (BookDTO, error) {
	if profile == "" {
		profile = DefaultProfile
	}
	if !profile.Valid() {
		return BookDTO{}, invalid("profile", "profile 仅支持 web 或 mobile")
	}
	bookValue, err := ProfileOverrides(overrides.Value, profile)
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
		Profile:         string(profile),
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
