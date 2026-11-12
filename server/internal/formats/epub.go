package formats

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/xml"
	"net/url"
	"os"
	"path"
	"strings"
)

const (
	epubMimetype          = "application/epub+zip"
	epubContainerPath     = "META-INF/container.xml"
	epubEncryptionPath    = "META-INF/encryption.xml"
	epubRightsPath        = "META-INF/rights.xml"
	maxEncryptionXMLBytes = 1 << 20

	// 仅允许这两种 OCF 字体混淆算法；其余算法一律按内容加密处理。
	idpfFontObfuscationAlgorithm  = "http://www.idpf.org/2008/embedding"
	adobeFontObfuscationAlgorithm = "http://ns.adobe.com/pdf/enc#RC"
)

type epubContainer struct {
	XMLName   xml.Name `xml:"container"`
	Rootfiles []struct {
		FullPath string `xml:"full-path,attr"`
	} `xml:"rootfiles>rootfile"`
}

type epubMeta struct {
	Name     string `xml:"name,attr"`
	Content  string `xml:"content,attr"`
	Property string `xml:"property,attr"`
}

type epubItem struct {
	ID         string `xml:"id,attr"`
	Href       string `xml:"href,attr"`
	MediaType  string `xml:"media-type,attr"`
	Properties string `xml:"properties,attr"`
}

type epubPackage struct {
	XMLName          xml.Name `xml:"package"`
	UniqueIdentifier string   `xml:"unique-identifier,attr"`
	Metadata         struct {
		Titles      []string `xml:"title"`
		Creators    []string `xml:"creator"`
		Identifiers []struct {
			ID    string `xml:"id,attr"`
			Value string `xml:",chardata"`
		} `xml:"identifier"`
		Metas []epubMeta `xml:"meta"`
	} `xml:"metadata"`
	Manifest struct {
		Items []epubItem `xml:"item"`
	} `xml:"manifest"`
	Spine struct {
		ItemRefs []struct {
			IDRef string `xml:"idref,attr"`
		} `xml:"itemref"`
	} `xml:"spine"`
}

type epubEncryption struct {
	XMLName       xml.Name            `xml:"encryption"`
	EncryptedData []epubEncryptedData `xml:"EncryptedData"`
}

type epubEncryptedData struct {
	EncryptionMethod struct {
		Algorithm string `xml:"Algorithm,attr"`
	} `xml:"EncryptionMethod"`
	CipherData struct {
		CipherReference struct {
			URI string `xml:"URI,attr"`
		} `xml:"CipherReference"`
	} `xml:"CipherData"`
}

func validateEPUB(ctx context.Context, f *os.File, size int64) (Result, error) {
	archive, err := inspectZIP(ctx, f, size)
	if err != nil {
		return Result{}, err
	}

	// 规范要求 mimetype 以 stored 方式作为首个条目，但部分生产工具会压缩
	// 或把它放到末尾；只要内容严格匹配且读取受 64 字节上限约束，仍可安全
	// 兼容。ZIP 加密、路径穿越、压缩比与重复条目等检查已在 inspectZIP 完成。
	mimetype, ok := archive.files["mimetype"]
	if !ok {
		return rejection(ReasonCorruptContainer, nil)
	}
	mimetypeData, err := readArchiveEntry(ctx, mimetype, maxMimetypeBytes)
	if err != nil {
		return Result{}, err
	}
	if string(mimetypeData) != epubMimetype {
		return rejection(ReasonCorruptContainer, nil)
	}

	containerFile, ok := archive.files[epubContainerPath]
	if !ok {
		return rejection(ReasonCorruptContainer, nil)
	}
	containerData, err := readArchiveEntry(ctx, containerFile, maxContainerXMLBytes)
	if err != nil {
		return Result{}, err
	}
	var container epubContainer
	if err := decodeXML(containerData, &container); err != nil {
		return rejection(ReasonCorruptContainer, nil)
	}
	if container.XMLName.Local != "container" {
		return rejection(ReasonCorruptContainer, nil)
	}

	packagePath := ""
	for _, rootfile := range container.Rootfiles {
		path := strings.TrimSpace(rootfile.FullPath)
		if path == "" {
			continue
		}
		if reason := validateArchivePath(path); reason != "" {
			return rejection(reason, nil)
		}
		packagePath = path
		break
	}
	if packagePath == "" {
		return rejection(ReasonCorruptContainer, nil)
	}
	packageFile, ok := archive.files[packagePath]
	if !ok {
		return rejection(ReasonCorruptContainer, nil)
	}
	packageData, err := readArchiveEntry(ctx, packageFile, maxPackageXMLBytes)
	if err != nil {
		return Result{}, err
	}
	var pkg epubPackage
	if err := decodeXML(packageData, &pkg); err != nil {
		return rejection(ReasonCorruptContainer, nil)
	}
	if pkg.XMLName.Local != "package" {
		return rejection(ReasonCorruptContainer, nil)
	}
	if len(pkg.Spine.ItemRefs) == 0 {
		return rejection(ReasonCorruptContainer, nil)
	}

	result := Result{
		Format:    FormatEPUB,
		MediaType: MediaTypeEPUB,
		Title:     firstNonEmpty(pkg.Metadata.Titles),
		Authors:   uniqueNonEmpty(pkg.Metadata.Creators),
		HasCover:  hasEPUBCover(&pkg),
		Readable:  true,
	}

	// OCF 加密声明并不必然是 DRM：IDPF/Adobe 字体混淆只改字体文件头，
	// reader/epub 能在读取时还原。只有内容加密、未知算法、非字体目标或
	// rights.xml 才标记为不可读。
	protected, err := epubHasContentProtection(ctx, archive, &pkg, packagePath)
	if err != nil {
		return Result{}, err
	}
	if protected {
		result.Readable = false
		result.UnsupportedReason = UnsupportedDRMProtected
	}
	return result, nil
}

// epubHasContentProtection 判断加密声明是否超出“仅字体混淆”的范围。
// 无法读取或解析的 encryption.xml 按内容加密处理，保持原有保守语义。
func epubHasContentProtection(ctx context.Context, archive *archiveInfo, pkg *epubPackage, packagePath string) (bool, error) {
	if _, rights := archive.files[epubRightsPath]; rights {
		return true, nil
	}
	encryptionFile, encrypted := archive.files[epubEncryptionPath]
	if !encrypted {
		return false, nil
	}
	fontOnly, err := isEPUBFontOnlyObfuscation(ctx, archive, encryptionFile, pkg, packagePath)
	if err != nil {
		return false, err
	}
	return !fontOnly, nil
}

// isEPUBFontOnlyObfuscation 仅在每条 EncryptedData 都指向 OPF 声明的字体、
// 使用受支持的混淆算法且能用出版物标识符推导出 key 时返回 true。
func isEPUBFontOnlyObfuscation(ctx context.Context, archive *archiveInfo, encryptionFile *zip.File, pkg *epubPackage, packagePath string) (bool, error) {
	data, err := readArchiveEntry(ctx, encryptionFile, maxEncryptionXMLBytes)
	if err != nil {
		if ctx.Err() != nil {
			return false, err
		}
		return false, nil
	}
	var document epubEncryption
	if err := decodeXML(data, &document); err != nil {
		return false, nil
	}
	if document.XMLName.Local != "encryption" || len(document.EncryptedData) == 0 {
		return false, nil
	}

	manifest := epubManifestIndex(archive, pkg, packagePath)
	identifier := epubIdentifier(pkg)
	for _, encrypted := range document.EncryptedData {
		algorithm := strings.TrimSpace(encrypted.EncryptionMethod.Algorithm)
		if algorithm != idpfFontObfuscationAlgorithm && algorithm != adobeFontObfuscationAlgorithm {
			return false, nil
		}
		item, targetPath, found := resolveEPUBEncryptionTarget(pkg, packagePath, manifest, encrypted.CipherData.CipherReference.URI)
		if !found {
			return false, nil
		}
		if !isEPUBFontResource(item, targetPath) {
			return false, nil
		}
		if !isEPUBFontKeyDerivable(algorithm, identifier) {
			return false, nil
		}
	}
	return true, nil
}

// epubManifestIndex 只索引实际存在且路径可解析的 OPF manifest 条目，
// 语义与 reader/epub 的 byPath 一致。
func epubManifestIndex(archive *archiveInfo, pkg *epubPackage, packagePath string) map[string]epubItem {
	index := make(map[string]epubItem, len(pkg.Manifest.Items))
	opfDir := path.Dir(packagePath)
	if opfDir == "." {
		opfDir = ""
	}
	for _, item := range pkg.Manifest.Items {
		if strings.TrimSpace(item.ID) == "" {
			continue
		}
		targetPath, ok := normalizeEPUBRelativeReference(opfDir, item.Href)
		if !ok {
			continue
		}
		if archive.files[targetPath] == nil {
			continue
		}
		if _, exists := index[targetPath]; !exists {
			index[targetPath] = item
		}
	}
	return index
}

// resolveEPUBEncryptionTarget 同时兼容 OCF 根相对 URI 与部分工具写出的
// OPF 相对 URI，顺序与 reader/epub 一致：先根相对，再 OPF 相对。
func resolveEPUBEncryptionTarget(pkg *epubPackage, packagePath string, manifest map[string]epubItem, uri string) (epubItem, string, bool) {
	if targetPath, ok := normalizeEPUBEncryptionPath(uri); ok {
		if item, found := manifest[targetPath]; found {
			return item, targetPath, true
		}
	}
	if opfDir := path.Dir(packagePath); opfDir != "." {
		if targetPath, ok := normalizeEPUBRelativeReference(opfDir, uri); ok {
			if item, found := manifest[targetPath]; found {
				return item, targetPath, true
			}
		}
	}
	return epubItem{}, "", false
}

// normalizeEPUBEncryptionPath 接受 OCF 根相对 URI；与 OPF 相对引用不同，
// 它不从某个目录开始，因此允许前导斜杠，只做根级清理与越界检查。
func normalizeEPUBEncryptionPath(uri string) (string, bool) {
	uri = strings.TrimSpace(uri)
	if uri == "" || strings.ContainsRune(uri, 0) {
		return "", false
	}
	if strings.Contains(uri, "://") || strings.HasPrefix(uri, "//") {
		return "", false
	}
	if index := strings.IndexAny(uri, "#?"); index >= 0 {
		uri = uri[:index]
	}
	uri = strings.TrimPrefix(uri, "/")
	if uri == "" || strings.HasPrefix(uri, `\`) {
		return "", false
	}
	if decoded, err := url.PathUnescape(uri); err == nil {
		uri = decoded
	}
	if strings.ContainsRune(uri, 0) {
		return "", false
	}
	cleaned := strings.TrimPrefix(strings.ReplaceAll(uri, `\`, "/"), "./")
	cleaned = strings.TrimLeft(cleaned, "/")
	cleaned = path.Clean(cleaned)
	if cleaned == "" || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", false
	}
	return cleaned, true
}

// normalizeEPUBRelativeReference 复现 reader/epub 对 manifest href 与
// OPF 相对加密目标的校验：拒绝绝对路径、盘符、回溯与空引用。
func normalizeEPUBRelativeReference(baseDir, reference string) (string, bool) {
	reference = strings.TrimSpace(reference)
	if reference == "" || strings.ContainsRune(reference, 0) {
		return "", false
	}
	if strings.Contains(reference, "://") || strings.HasPrefix(reference, "//") {
		return "", false
	}
	if strings.HasPrefix(reference, "/") || strings.HasPrefix(reference, `\`) {
		return "", false
	}
	if len(reference) >= 2 && isASCIILetter(reference[0]) && reference[1] == ':' {
		return "", false
	}
	if index := strings.IndexAny(reference, "#?"); index >= 0 {
		reference = reference[:index]
	}
	if reference == "" {
		return "", false
	}
	if decoded, err := url.PathUnescape(reference); err == nil {
		reference = decoded
	}
	if strings.ContainsRune(reference, 0) {
		return "", false
	}
	joined := path.Clean(path.Join(baseDir, reference))
	if joined == "" || joined == "." || joined == ".." ||
		strings.HasPrefix(joined, "../") || strings.HasPrefix(joined, "/") {
		return "", false
	}
	return joined, true
}

// isEPUBFontResource 与 reader/epub 的字体判定一致：媒体类型必须能被
// reader 作为字体资源提供，或交由扩展名推断；否则 reader 会把字体混淆
// 升级为内容加密。
func isEPUBFontResource(item epubItem, archivePath string) bool {
	switch normalizeEPUBMediaType(item.MediaType) {
	case "font/woff", "application/font-woff", "application/x-font-woff",
		"font/woff2", "application/font-woff2", "application/x-font-woff2",
		"font/ttf", "application/x-font-ttf", "application/x-font-truetype",
		"font/otf", "application/vnd.ms-opentype", "application/x-font-opentype",
		"application/x-font-otf":
		return true
	case "application/font-sfnt", "", "application/octet-stream", "binary/octet-stream":
		return isEPUBFontExtension(archivePath)
	default:
		return false
	}
}

func isEPUBFontExtension(archivePath string) bool {
	switch strings.ToLower(path.Ext(archivePath)) {
	case ".ttf", ".otf", ".woff", ".woff2", ".ttc":
		return true
	default:
		return false
	}
}

func normalizeEPUBMediaType(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if index := strings.IndexByte(value, ';'); index >= 0 {
		value = strings.TrimSpace(value[:index])
	}
	return value
}

// epubIdentifier 优先使用 OPF unique-identifier 指向的 dc:identifier，
// 缺失时退回第一个非空标识符，与 reader/epub 的 key 推导一致。
func epubIdentifier(pkg *epubPackage) string {
	uniqueID := strings.TrimSpace(pkg.UniqueIdentifier)
	if uniqueID != "" {
		for _, identifier := range pkg.Metadata.Identifiers {
			if identifier.ID == uniqueID {
				if value := strings.TrimSpace(identifier.Value); value != "" {
					return value
				}
			}
		}
	}
	for _, identifier := range pkg.Metadata.Identifiers {
		if value := strings.TrimSpace(identifier.Value); value != "" {
			return value
		}
	}
	return ""
}

// isEPUBFontKeyDerivable 复现 reader/epub 的 key 推导前置条件；不实际
// 异或字体内容，只确认算法所需标识符足够。
func isEPUBFontKeyDerivable(algorithm, identifier string) bool {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return false
	}
	switch algorithm {
	case idpfFontObfuscationAlgorithm:
		return strings.Join(strings.Fields(identifier), "") != ""
	case adobeFontObfuscationAlgorithm:
		value := identifier
		if len(value) >= len("urn:uuid:") && strings.EqualFold(value[:len("urn:uuid:")], "urn:uuid:") {
			value = value[len("urn:uuid:"):]
		}
		value = strings.ReplaceAll(value, "-", "")
		if len(value) != 32 {
			return false
		}
		_, err := hex.DecodeString(value)
		return err == nil
	default:
		return false
	}
}

// decodeXML 使用严格 XML 解码；Go 标准库不会解析外部实体或下载 DTD。
func decodeXML(data []byte, target any) error {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = true
	return decoder.Decode(target)
}

func hasEPUBCover(pkg *epubPackage) bool {
	for _, item := range pkg.Manifest.Items {
		if hasToken(item.Properties, "cover-image") {
			return true
		}
	}
	for _, meta := range pkg.Metadata.Metas {
		if !strings.EqualFold(strings.TrimSpace(meta.Name), "cover") {
			continue
		}
		coverID := strings.TrimSpace(meta.Content)
		if coverID == "" {
			continue
		}
		for _, item := range pkg.Manifest.Items {
			if item.ID == coverID && strings.HasPrefix(strings.ToLower(item.MediaType), "image/") {
				return true
			}
		}
	}
	return false
}

func hasToken(value, token string) bool {
	for _, field := range strings.Fields(value) {
		if field == token {
			return true
		}
	}
	return false
}

func firstNonEmpty(values []string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func uniqueNonEmpty(values []string) []string {
	authors := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		authors = append(authors, trimmed)
	}
	return authors
}
