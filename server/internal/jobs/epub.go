package jobs

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"

	"iread/server/internal/formats"
	"iread/server/internal/store"
)

const (
	epubContainerPath  = "META-INF/container.xml"
	epubEncryptionPath = "META-INF/encryption.xml"
	maxContainerBytes  = 1 << 20
	maxPackageBytes    = 8 << 20
	maxEncryptionBytes = 1 << 20
	maxTOCBytes        = 8 << 20
	maxCoverBytes      = 64 << 20
	maxTOCEntries      = 5000
)

// OCF encryption.xml 中仅字体混淆属于已知的“不阻止阅读”算法；其他算法按
// 内容加密处理，无法确认时宁可保持 unsupported，不冒充可读。
const (
	epubFontObfuscationIDPF  = "http://www.idpf.org/2008/embedding"
	epubFontObfuscationAdobe = "http://ns.adobe.com/pdf/enc#RC"
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
	Refines  string `xml:"refines,attr"`
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
		Languages   []string `xml:"language"`
		Publishers  []string `xml:"publisher"`
		Dates       []string `xml:"date"`
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
		Toc      string `xml:"toc,attr"`
		ItemRefs []struct {
			IDRef string `xml:"idref,attr"`
		} `xml:"itemref"`
	} `xml:"spine"`
}

type epubEncryption struct {
	XMLName       xml.Name `xml:"encryption"`
	EncryptedData []struct {
		EncryptionMethod struct {
			Algorithm string `xml:"Algorithm,attr"`
		} `xml:"EncryptionMethod"`
	} `xml:"EncryptedData"`
}

// fontObfuscated 判断 encryption.xml 是否只声明了字体混淆。字体混淆不改变
// 正文与图片字节，元数据、目录和封面仍可正常提取；内容加密或未知算法则
// 无法安全读取。解析失败按未知处理，不宣称可读。
func fontObfuscated(ctx context.Context, file *zip.File) (bool, error) {
	data, err := readZipFile(ctx, file, maxEncryptionBytes)
	if err != nil {
		if contextDone(ctx, err) {
			return false, err
		}
		return false, nil
	}
	var document epubEncryption
	if err := decodeStrictXML(data, &document); err != nil || document.XMLName.Local != "encryption" {
		return false, nil
	}
	for _, encrypted := range document.EncryptedData {
		algorithm := strings.TrimSpace(encrypted.EncryptionMethod.Algorithm)
		if !strings.EqualFold(algorithm, epubFontObfuscationIDPF) &&
			!strings.EqualFold(algorithm, epubFontObfuscationAdobe) {
			return false, nil
		}
	}
	return true, nil
}

func extractEPUB(ctx context.Context, filePath, displayTitle string, report phaseReporter) (extraction, error) {
	if err := statBookFile(filePath); err != nil {
		return extraction{}, err
	}
	archive, err := zip.OpenReader(filePath)
	if err != nil {
		return extraction{}, invalidBookFile(err)
	}
	defer archive.Close()
	if len(archive.File) > formats.MaxArchiveEntries {
		return extraction{}, invalidBookFile(errors.New("EPUB 条目过多"))
	}
	files := make(map[string]*zip.File, len(archive.File))
	for _, file := range archive.File {
		files[file.Name] = file
		if cleaned := path.Clean(file.Name); cleaned != file.Name {
			files[cleaned] = file
		}
	}

	mimetypeFile, ok := files["mimetype"]
	if !ok || mimetypeFile.Method != zip.Store {
		return extraction{}, invalidBookFile(errors.New("mimetype 不是 stored 条目"))
	}
	mimetypeData, err := readZipFile(ctx, mimetypeFile, 64)
	if err != nil {
		if contextDone(ctx, err) {
			return extraction{}, err
		}
		return extraction{}, invalidBookFile(err)
	}
	if string(mimetypeData) != "application/epub+zip" {
		return extraction{}, invalidBookFile(errors.New("mimetype 内容无效"))
	}
	if encryptionFile, encrypted := files[epubEncryptionPath]; encrypted {
		onlyFonts, err := fontObfuscated(ctx, encryptionFile)
		if err != nil {
			return extraction{}, err
		}
		if !onlyFonts {
			return extraction{}, newIndexError(ErrorCodeUnsupported, "该 EPUB 包含加密内容", false, nil)
		}
	}
	if _, rights := files["META-INF/rights.xml"]; rights {
		return extraction{}, newIndexError(ErrorCodeUnsupported, "该 EPUB 受 DRM 保护", false, nil)
	}

	containerFile, ok := files[epubContainerPath]
	if !ok {
		return extraction{}, invalidBookFile(errors.New("缺少 META-INF/container.xml"))
	}
	containerData, err := readZipFile(ctx, containerFile, maxContainerBytes)
	if err != nil {
		if contextDone(ctx, err) {
			return extraction{}, err
		}
		return extraction{}, invalidBookFile(err)
	}
	var container epubContainer
	if err := decodeStrictXML(containerData, &container); err != nil || container.XMLName.Local != "container" {
		return extraction{}, invalidBookFile(errors.New("container.xml 无法解析"))
	}
	packagePath := ""
	for _, rootfile := range container.Rootfiles {
		resolved, resolveErr := resolveArchiveRef("", rootfile.FullPath)
		if resolveErr == nil && resolved != "" {
			packagePath = stripFragment(resolved)
			break
		}
	}
	if packagePath == "" {
		return extraction{}, invalidBookFile(errors.New("container.xml 未声明 OPF"))
	}
	packageFile, ok := files[packagePath]
	if !ok {
		return extraction{}, invalidBookFile(errors.New("OPF 不存在"))
	}
	packageData, err := readZipFile(ctx, packageFile, maxPackageBytes)
	if err != nil {
		if contextDone(ctx, err) {
			return extraction{}, err
		}
		return extraction{}, invalidBookFile(err)
	}
	var pkg epubPackage
	if err := decodeStrictXML(packageData, &pkg); err != nil || pkg.XMLName.Local != "package" {
		return extraction{}, invalidBookFile(errors.New("OPF 无法解析"))
	}
	if len(pkg.Spine.ItemRefs) == 0 {
		return extraction{}, invalidBookFile(errors.New("OPF spine 为空"))
	}
	opfDir := archiveDir(packagePath)

	result := extraction{
		Authors: []string{},
		TOC:     []store.BookTOCEntry{},
	}
	result.Title = firstTrimmed(pkg.Metadata.Titles)
	if result.Title == nil {
		fallback := strings.TrimSpace(displayTitle)
		if fallback != "" {
			result.Title = &fallback
		}
	}
	result.Language = firstTrimmed(pkg.Metadata.Languages)
	result.Publisher = firstTrimmed(pkg.Metadata.Publishers)
	result.PublishedAt = firstTrimmed(pkg.Metadata.Dates)
	result.Identifier = epubIdentifier(&pkg)
	result.Authors = uniqueStrings(pkg.Metadata.Creators)

	navPath, ncxPath := tocSources(&pkg, files, opfDir)
	coverPath := coverSource(&pkg, opfDir)
	result.CoverExpected = coverPath != ""

	if err := report("toc", 1); err != nil {
		return extraction{}, err
	}
	if navPath != "" {
		if navFile, found := files[navPath]; found {
			if data, readErr := readZipFile(ctx, navFile, maxTOCBytes); readErr == nil {
				if entries, parseErr := parseEPUBNav(data, navPath); parseErr == nil {
					result.TOC = entries
				}
			} else if contextDone(ctx, readErr) {
				return extraction{}, readErr
			}
		}
	}
	if len(result.TOC) == 0 && ncxPath != "" {
		if ncxFile, found := files[ncxPath]; found {
			if data, readErr := readZipFile(ctx, ncxFile, maxTOCBytes); readErr == nil {
				if entries, parseErr := parseEPUBNCX(data, ncxPath); parseErr == nil {
					result.TOC = entries
				}
			} else if contextDone(ctx, readErr) {
				return extraction{}, readErr
			}
		}
	}
	if len(result.TOC) == 0 {
		result.Partial = true
	}

	if err := report("cover", 2); err != nil {
		return extraction{}, err
	}
	if coverPath != "" {
		if coverFile, found := files[coverPath]; found {
			if data, readErr := readZipFile(ctx, coverFile, maxCoverBytes); readErr == nil {
				result.Cover = data
			} else if contextDone(ctx, readErr) {
				return extraction{}, readErr
			}
		}
	}
	if len(result.Cover) == 0 {
		result.Partial = true
	}
	return result, nil
}

func decodeStrictXML(data []byte, target any) error {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = true
	decoder.CharsetReader = xmlCharsetReader
	return decoder.Decode(target)
}

func decodeXHTML(data []byte, target any) error {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = false
	decoder.AutoClose = xml.HTMLAutoClose
	decoder.Entity = xml.HTMLEntity
	decoder.CharsetReader = xmlCharsetReader
	return decoder.Decode(target)
}

// xmlCharsetReader 只支持 EPUB 常见编码；Go 标准库不会下载外部实体或 DTD。
func xmlCharsetReader(charset string, input io.Reader) (io.Reader, error) {
	data, err := io.ReadAll(io.LimitReader(input, maxPackageBytes))
	if err != nil {
		return nil, err
	}
	switch strings.ToLower(strings.TrimSpace(charset)) {
	case "utf-8", "utf8":
		return bytes.NewReader(data), nil
	case "utf-16", "utf16":
		bigEndian := true
		if len(data) >= 2 && data[0] == 0xFF && data[1] == 0xFE {
			bigEndian = false
			data = data[2:]
		} else if len(data) >= 2 && data[0] == 0xFE && data[1] == 0xFF {
			data = data[2:]
		}
		return strings.NewReader(decodeUTF16(data, bigEndian)), nil
	case "utf-16le":
		if len(data) >= 2 && data[0] == 0xFF && data[1] == 0xFE {
			data = data[2:]
		}
		return strings.NewReader(decodeUTF16(data, false)), nil
	case "utf-16be":
		if len(data) >= 2 && data[0] == 0xFE && data[1] == 0xFF {
			data = data[2:]
		}
		return strings.NewReader(decodeUTF16(data, true)), nil
	case "iso-8859-1", "latin1", "latin-1":
		runes := make([]rune, len(data))
		for index, value := range data {
			runes[index] = rune(value)
		}
		return strings.NewReader(string(runes)), nil
	default:
		return nil, fmt.Errorf("不支持的 XML 编码 %s", charset)
	}
}

func readZipFile(ctx context.Context, file *zip.File, limit int64) ([]byte, error) {
	if file.UncompressedSize64 > uint64(limit) {
		return nil, errors.New("ZIP 条目录超过读取上限")
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	limited := &io.LimitedReader{R: contextReader{ctx: ctx, reader: reader}, N: limit + 1}
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("ZIP 条目超过读取上限")
	}
	return data, nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}

func contextDone(ctx context.Context, err error) bool {
	// 调用方任务超时优先按任务级错误处理；解析器内部的子 deadline 由各
	// 格式函数自行映射，避免把超时误报成损坏文件。
	if ctx.Err() != nil {
		return true
	}
	return errors.Is(err, context.Canceled)
}

func archiveDir(archivePath string) string {
	dir := path.Dir(archivePath)
	if dir == "." || dir == "/" {
		return ""
	}
	return dir
}

// resolveArchiveRef 解析 EPUB/XHTML 相对引用，返回归档内相对路径（可含 #fragment）。
func resolveArchiveRef(baseDir, href string) (string, error) {
	href = strings.TrimSpace(href)
	if href == "" || strings.ContainsRune(href, 0) {
		return "", errors.New("空引用")
	}
	if strings.Contains(href, "://") || strings.HasPrefix(href, "//") {
		return "", errors.New("外部引用")
	}
	pathPart := href
	fragment := ""
	if index := strings.IndexByte(pathPart, '#'); index >= 0 {
		fragment = pathPart[index+1:]
		pathPart = pathPart[:index]
	}
	if index := strings.IndexByte(pathPart, '?'); index >= 0 {
		pathPart = pathPart[:index]
	}
	if pathPart == "" || strings.HasPrefix(pathPart, "/") || strings.HasPrefix(pathPart, `\`) {
		return "", errors.New("无效引用")
	}
	if decoded, err := url.PathUnescape(pathPart); err == nil {
		pathPart = decoded
	}
	joined := path.Clean(path.Join(baseDir, pathPart))
	if joined == ".." || strings.HasPrefix(joined, "../") || joined == "." {
		return "", errors.New("引用越界")
	}
	if fragment != "" {
		joined += "#" + fragment
	}
	return joined, nil
}

func stripFragment(value string) string {
	if index := strings.IndexByte(value, '#'); index >= 0 {
		return value[:index]
	}
	return value
}

func firstTrimmed(values []string) *string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			return &trimmed
		}
	}
	return nil
}

func uniqueStrings(values []string) []string {
	result := make([]string, 0, len(values))
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
		result = append(result, trimmed)
	}
	return result
}

func hasProperty(value, property string) bool {
	for _, field := range strings.Fields(value) {
		if field == property {
			return true
		}
	}
	return false
}

func epubIdentifier(pkg *epubPackage) *string {
	uniqueID := strings.TrimSpace(pkg.UniqueIdentifier)
	if uniqueID != "" {
		for _, identifier := range pkg.Metadata.Identifiers {
			if identifier.ID == uniqueID {
				if value := strings.TrimSpace(identifier.Value); value != "" {
					return &value
				}
			}
		}
	}
	for _, identifier := range pkg.Metadata.Identifiers {
		if value := strings.TrimSpace(identifier.Value); value != "" {
			return &value
		}
	}
	return nil
}

func tocSources(pkg *epubPackage, files map[string]*zip.File, opfDir string) (navPath, ncxPath string) {
	for _, item := range pkg.Manifest.Items {
		if hasProperty(item.Properties, "nav") && item.Href != "" {
			if resolved, err := resolveArchiveRef(opfDir, item.Href); err == nil {
				navPath = stripFragment(resolved)
			}
			break
		}
	}
	for _, item := range pkg.Manifest.Items {
		if strings.EqualFold(strings.TrimSpace(item.MediaType), "application/x-dtbncx+xml") && item.Href != "" {
			if resolved, err := resolveArchiveRef(opfDir, item.Href); err == nil {
				ncxPath = stripFragment(resolved)
			}
			break
		}
	}
	if ncxPath == "" && pkg.Spine.Toc != "" {
		for _, item := range pkg.Manifest.Items {
			if item.ID == pkg.Spine.Toc && item.Href != "" {
				if resolved, err := resolveArchiveRef(opfDir, item.Href); err == nil {
					ncxPath = stripFragment(resolved)
				}
				break
			}
		}
	}
	if ncxPath == "" {
		for _, item := range pkg.Manifest.Items {
			if strings.HasSuffix(strings.ToLower(item.Href), ".ncx") {
				if resolved, err := resolveArchiveRef(opfDir, item.Href); err == nil {
					ncxPath = stripFragment(resolved)
				}
				break
			}
		}
	}
	if navPath == "" {
		// 兼容未声明 properties="nav" 的少部分 EPUB3 文件。
		for _, item := range pkg.Manifest.Items {
			lower := strings.ToLower(item.Href)
			if strings.HasSuffix(lower, "nav.xhtml") || strings.HasSuffix(lower, "nav.html") {
				if resolved, err := resolveArchiveRef(opfDir, item.Href); err == nil {
					navPath = stripFragment(resolved)
				}
				break
			}
		}
	}
	if navPath != "" {
		if _, exists := files[navPath]; !exists {
			navPath = ""
		}
	}
	if ncxPath != "" {
		if _, exists := files[ncxPath]; !exists {
			ncxPath = ""
		}
	}
	return navPath, ncxPath
}

func coverSource(pkg *epubPackage, opfDir string) string {
	coverID := ""
	for _, meta := range pkg.Metadata.Metas {
		if strings.EqualFold(strings.TrimSpace(meta.Name), "cover") {
			coverID = strings.TrimSpace(meta.Content)
			if coverID != "" {
				break
			}
		}
	}
	var chosen *epubItem
	for index := range pkg.Manifest.Items {
		item := &pkg.Manifest.Items[index]
		if hasProperty(item.Properties, "cover-image") && strings.HasPrefix(strings.ToLower(item.MediaType), "image/") {
			chosen = item
			break
		}
	}
	if chosen == nil && coverID != "" {
		for index := range pkg.Manifest.Items {
			item := &pkg.Manifest.Items[index]
			if item.ID == coverID && strings.HasPrefix(strings.ToLower(item.MediaType), "image/") {
				chosen = item
				break
			}
		}
	}
	if chosen == nil || chosen.Href == "" {
		return ""
	}
	resolved, err := resolveArchiveRef(opfDir, chosen.Href)
	if err != nil {
		return ""
	}
	return stripFragment(resolved)
}

type xhtmlDocument struct {
	Body struct {
		Navs []xhtmlNav `xml:"nav"`
	} `xml:"body"`
}

type xhtmlNav struct {
	Type string    `xml:"type,attr"`
	List xhtmlList `xml:"ol"`
}

type xhtmlList struct {
	Items []xhtmlItem `xml:"li"`
}

type xhtmlItem struct {
	Anchor *xhtmlAnchor `xml:"a"`
	Spans  []string     `xml:"span"`
	List   *xhtmlList   `xml:"ol"`
}

type xhtmlAnchor struct {
	Href  string   `xml:"href,attr"`
	Text  string   `xml:",chardata"`
	Spans []string `xml:"span"`
}

func parseEPUBNav(data []byte, navPath string) ([]store.BookTOCEntry, error) {
	var document xhtmlDocument
	if err := decodeXHTML(data, &document); err != nil {
		return nil, err
	}
	var chosen *xhtmlNav
	for index := range document.Body.Navs {
		nav := &document.Body.Navs[index]
		if hasProperty(nav.Type, "toc") {
			chosen = nav
			break
		}
	}
	if chosen == nil {
		for index := range document.Body.Navs {
			if len(document.Body.Navs[index].List.Items) > 0 {
				chosen = &document.Body.Navs[index]
				break
			}
		}
	}
	if chosen == nil {
		return nil, errors.New("nav 中没有目录")
	}
	baseDir := archiveDir(navPath)
	counter := 0
	return navEntries(chosen.List, baseDir, 1, &counter), nil
}

func navEntries(list xhtmlList, baseDir string, level int, counter *int) []store.BookTOCEntry {
	entries := make([]store.BookTOCEntry, 0, len(list.Items))
	for _, item := range list.Items {
		if *counter >= maxTOCEntries {
			break
		}
		title := ""
		href := ""
		if item.Anchor != nil {
			title = strings.TrimSpace(item.Anchor.Text)
			if title == "" {
				for _, span := range item.Anchor.Spans {
					if trimmed := strings.TrimSpace(span); trimmed != "" {
						title = trimmed
						break
					}
				}
			}
			if title == "" {
				for _, span := range item.Spans {
					if trimmed := strings.TrimSpace(span); trimmed != "" {
						title = trimmed
						break
					}
				}
			}
			if resolved, err := resolveArchiveRef(baseDir, item.Anchor.Href); err == nil {
				href = resolved
			}
		}
		if title == "" {
			title = href
		}
		entry := store.BookTOCEntry{Title: title, Href: href, Level: level}
		(*counter)++
		if item.List != nil {
			entry.Children = navEntries(*item.List, baseDir, level+1, counter)
		}
		if entry.Title != "" || entry.Href != "" || len(entry.Children) > 0 {
			entries = append(entries, entry)
		}
	}
	return entries
}

type ncxDocument struct {
	NavMap struct {
		Points []ncxPoint `xml:"navPoint"`
	} `xml:"navMap"`
}

type ncxPoint struct {
	Label struct {
		Text string `xml:"text"`
	} `xml:"navLabel"`
	Content struct {
		Src string `xml:"src,attr"`
	} `xml:"content"`
	Points []ncxPoint `xml:"navPoint"`
}

func parseEPUBNCX(data []byte, ncxPath string) ([]store.BookTOCEntry, error) {
	var document ncxDocument
	if err := decodeStrictXML(data, &document); err != nil {
		return nil, err
	}
	baseDir := archiveDir(ncxPath)
	counter := 0
	return ncxEntries(document.NavMap.Points, baseDir, 1, &counter), nil
}

func ncxEntries(points []ncxPoint, baseDir string, level int, counter *int) []store.BookTOCEntry {
	entries := make([]store.BookTOCEntry, 0, len(points))
	for _, point := range points {
		if *counter >= maxTOCEntries {
			break
		}
		title := strings.TrimSpace(point.Label.Text)
		href := ""
		if resolved, err := resolveArchiveRef(baseDir, point.Content.Src); err == nil {
			href = resolved
		}
		if title == "" {
			title = href
		}
		entry := store.BookTOCEntry{Title: title, Href: href, Level: level}
		(*counter)++
		entry.Children = ncxEntries(point.Points, baseDir, level+1, counter)
		if entry.Title != "" || entry.Href != "" || len(entry.Children) > 0 {
			entries = append(entries, entry)
		}
	}
	return entries
}
