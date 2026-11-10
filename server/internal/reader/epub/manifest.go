// Package epub 解析 EPUB 2/3 容器并为阅读器生成按需资源清单。
//
// 本包只读取原件：不修改 ZIP、不把整本解压到内存，也不把宿主文件路径
// 暴露给客户端。资源身份统一使用 sha256(规范化归档路径)[:32]。
package epub

import (
	"crypto/sha256"
	"encoding/hex"
)

// ManifestSchemaVersion 是当前 manifest DTO 的 schema 版本。
const ManifestSchemaVersion = 1

// FormatEPUB 是 manifest 中 EPUB 的格式枚举。
const FormatEPUB = "epub"

// Manifest 是 GET /books/{bookId}/manifest 的 EPUB DTO，也是 book_manifests
// 持久化的完整 JSON。
type Manifest struct {
	SchemaVersion       int                 `json:"schemaVersion"`
	BookID              string              `json:"bookId"`
	FileVersion         string              `json:"fileVersion"`
	Format              string              `json:"format"`
	IndexVersion        int64               `json:"indexVersion"`
	ReadingCapabilities ReadingCapabilities `json:"readingCapabilities"`
	TOC                 []TOCItem           `json:"toc"`
	FormatData          FormatData          `json:"formatData"`
}

// ReadingCapabilities 描述当前服务端实际可提供的阅读能力。features 只列
// 已接入的能力；本阶段不提供 search。
type ReadingCapabilities struct {
	CanRead           bool     `json:"canRead"`
	UnavailableReason string   `json:"unavailableReason"`
	Features          []string `json:"features"`
}

// TOCItem 是目录节点。href 是规范化归档路径（不含 fragment），resourceId
// 指向可请求资源；没有可映射资源时 resourceId 为空字符串。
type TOCItem struct {
	Title      string    `json:"title"`
	Href       string    `json:"href"`
	ResourceID string    `json:"resourceId"`
	Fragment   string    `json:"fragment"`
	Level      int       `json:"level"`
	Children   []TOCItem `json:"children"`
}

// FormatData 是 EPUB 的格式扩展数据。
type FormatData struct {
	Rendition         Rendition           `json:"rendition"`
	Spine             []SpineItem         `json:"spine"`
	Resources         map[string]Resource `json:"resources"`
	ContentProtection ContentProtection   `json:"contentProtection"`
}

// Rendition 是 OPF 声明的默认排版行为。
type Rendition struct {
	Layout    string `json:"layout"`
	Flow      string `json:"flow"`
	Spread    string `json:"spread"`
	Direction string `json:"direction"`
}

// SpineItem 是有序阅读章节。index 从 0 开始，与 locator.spineIndex 一致。
type SpineItem struct {
	Index      int    `json:"index"`
	ResourceID string `json:"resourceId"`
	Href       string `json:"href"`
	MediaType  string `json:"mediaType"`
	Linear     bool   `json:"linear"`
	CFIBase    string `json:"cfiBase"`
	Size       int64  `json:"size"`
}

// Resource 是可请求的归档资源。href 是规范化归档路径，不包含宿主路径。
type Resource struct {
	Href      string `json:"href"`
	MediaType string `json:"mediaType"`
	Size      int64  `json:"size"`
	Kind      string `json:"kind"`
}

// ContentProtection 区分“仅字体混淆”和“内容 DRM”。contentEncrypted=true
// 时资源端点必须返回 book_not_readable，不能把加密正文当普通资源输出。
type ContentProtection struct {
	Detected                  bool     `json:"detected"`
	ContentEncrypted          bool     `json:"contentEncrypted"`
	FontObfuscated            bool     `json:"fontObfuscated"`
	FontObfuscationAlgorithms []string `json:"fontObfuscationAlgorithms"`
}

// ResourceID 返回规范化归档路径的资源 ID：sha256(path) 的前 32 个十六进制字符。
// 调用方必须传入已经规范化、无前导斜杠、无 fragment、无 query 的归档路径。
func ResourceID(archivePath string) string {
	sum := sha256.Sum256([]byte(archivePath))
	return hex.EncodeToString(sum[:])[:32]
}
