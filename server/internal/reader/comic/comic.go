// Package comic 为 CBZ/CBR 漫画提供安全的服务器端页索引与按页读取。
//
// 本包只读取原件：不解压整本到内存、不改写压缩包，也不把宿主路径或归档
// 条目名暴露给客户端。页身份统一使用 sha256(规范化归档路径)[:32]。
package comic

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 支持的漫画格式，必须与 book_manifests.format 的 CHECK 约束一致。
const (
	FormatCBZ = "cbz"
	FormatCBR = "cbr"

	// ManifestSchemaVersion 是漫画 manifest DTO 的 schema 版本。
	ManifestSchemaVersion = 1
)

// 归档与图片安全预算，与阶段2上传校验及阶段6决策保持一致。
const (
	MaxArchiveEntries           = 20_000
	MaxTotalUncompressed  int64 = 4 << 30
	MaxEntryUncompressed  int64 = 1 << 30
	CompressionRatioBytes int64 = 16 << 20
	MaxCompressionRatio   int64 = 100
	MaxImagePixels        int64 = 100_000_000
	MaxImageSide                = 32_767

	// MaxOriginalBytes 是 original 变体允许的单页解压字节上限（64 MiB）。
	MaxOriginalBytes int64 = 64 << 20
	// MaxOriginalPixels 是 original 变体允许的单页像素上限（32M）。
	MaxOriginalPixels int64 = 32_000_000

	// ScreenMaxLongEdge / ScreenMaxPixels 是 screen 派生图的固定档位。
	ScreenMaxLongEdge       = 1600
	ScreenMaxPixels   int64 = 4_000_000
	ScreenJPEGQuality       = 82

	// DefaultOperationTimeout 是单次索引/提取的预算，调用方更短的 deadline 优先。
	DefaultOperationTimeout = 60 * time.Second
	// MaxFileSize 与上传原件上限一致。
	MaxFileSize int64 = 1 << 30

	maxArchivePathBytes = 1024
	maxImageHeaderBytes = 4 << 20
	// maxCachedPageBytes 控制单页是否进入 solid 解码缓存；过大页直接流式读取。
	maxCachedPageBytes int64 = 16 << 20
	// maxSessionCacheBytes 控制单个 RAR 会话的已解码页缓存总量。
	maxSessionCacheBytes int64 = 64 << 20
)

// 页变体。
const (
	VariantScreen   = "screen"
	VariantOriginal = "original"
)

// 可对外输出的图片 media type。
const (
	MediaTypeJPEG = "image/jpeg"
	MediaTypePNG  = "image/png"
	MediaTypeGIF  = "image/gif"
)

var (
	// ErrBookNotFound 表示书籍登记不存在。
	ErrBookNotFound = errors.New("comic: book not found")
	// ErrInvalidArchive 表示归档损坏、目录结构无效或图片头无法解析。
	ErrInvalidArchive = errors.New("comic: invalid archive")
	// ErrUnsupportedFormat 表示当前格式不是 CBZ/CBR。
	ErrUnsupportedFormat = errors.New("comic: unsupported format")
	// ErrUnsupportedArchive 表示归档结构本身暂不支持（如多卷 RAR）。
	ErrUnsupportedArchive = errors.New("comic: unsupported archive")
	// ErrEncryptedArchive 表示归档或条目被加密。
	ErrEncryptedArchive = errors.New("comic: encrypted archive")
	// ErrUnsafeArchive 表示路径穿越、绝对路径、符号链接等不安全结构。
	ErrUnsafeArchive = errors.New("comic: unsafe archive")
	// ErrArchiveLimit 表示条目数、解压量、压缩比或图片像素超过预算。
	ErrArchiveLimit = errors.New("comic: archive limit exceeded")
	// ErrPageNotFound 表示 resourceId 不属于当前 manifest。
	ErrPageNotFound = errors.New("comic: page not found")
	// ErrVariantUnavailable 表示请求的页变体不可用。
	ErrVariantUnavailable = errors.New("comic: variant unavailable")
	// ErrStorageUnavailable 表示原件或缓存目录不可读取。
	ErrStorageUnavailable = errors.New("comic: storage unavailable")
	// ErrParserTimeout 表示解析超出预算或被调用方取消。
	ErrParserTimeout = errors.New("comic: parser timeout")
)

// Source 是书籍原件的最小定位信息，由服务端登记读取，不来自客户端。
type Source struct {
	BookID         string
	FileVersion    string
	Format         string
	StorageRelPath string
	IndexVersion   int64
	ByteSize       int64
}

// Manifest 是 GET /books/{bookId}/manifest 的漫画 DTO，也是 book_manifests
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

// ReadingCapabilities 描述当前服务端实际可提供的漫画阅读能力。
type ReadingCapabilities struct {
	CanRead           bool     `json:"canRead"`
	UnavailableReason string   `json:"unavailableReason"`
	Features          []string `json:"features"`
}

// TOCItem 与共享 manifest 形状保持一致；漫画不提供目录，TOC 为空数组。
type TOCItem struct {
	Title      string    `json:"title"`
	Href       string    `json:"href"`
	ResourceID string    `json:"resourceId"`
	Fragment   string    `json:"fragment"`
	Level      int       `json:"level"`
	Children   []TOCItem `json:"children"`
}

// FormatData 是漫画的格式扩展数据。
type FormatData struct {
	PageCount int    `json:"pageCount"`
	Pages     []Page `json:"pages"`
}

// Page 是自然排序后的单页描述。width/height 可空，但索引成功的页会填入。
type Page struct {
	Page              int      `json:"page"`
	ResourceID        string   `json:"resourceId"`
	Width             *int     `json:"width"`
	Height            *int     `json:"height"`
	MediaType         string   `json:"mediaType"`
	Size              int64    `json:"size"`
	AvailableVariants []string `json:"availableVariants"`
}

// Builder 读取 books 根目录下的漫画原件，并把 screen 派生图写入 cache 根目录。
type Builder struct {
	booksDir string
	cacheDir string
	rar      *rarManager

	entriesMu sync.Mutex
	entries   map[string]*entryIndex
}

// NewBuilder 构造索引器；booksDir 必须已存在，cacheDir 会被创建。
func NewBuilder(booksDir, cacheDir string) (*Builder, error) {
	booksDir = strings.TrimSpace(booksDir)
	if booksDir == "" {
		return nil, errors.New("comic: books 目录不能为空")
	}
	absBooks, err := filepath.Abs(booksDir)
	if err != nil {
		return nil, fmt.Errorf("comic: books 目录无法解析: %w", err)
	}
	info, err := os.Stat(absBooks)
	if err != nil {
		return nil, fmt.Errorf("comic: books 目录不可用: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("comic: books 路径不是目录")
	}

	cacheDir = strings.TrimSpace(cacheDir)
	if cacheDir == "" {
		return nil, errors.New("comic: cache 目录不能为空")
	}
	absCache, err := filepath.Abs(cacheDir)
	if err != nil {
		return nil, fmt.Errorf("comic: cache 目录无法解析: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(absCache, "comic"), 0o700); err != nil {
		return nil, fmt.Errorf("comic: cache 目录不可用: %w", err)
	}
	info, err = os.Stat(filepath.Join(absCache, "comic"))
	if err != nil || !info.IsDir() {
		return nil, errors.New("comic: cache 目录不可用")
	}

	return &Builder{
		booksDir: absBooks,
		cacheDir: absCache,
		rar:      newRARManager(absBooks),
		entries:  make(map[string]*entryIndex),
	}, nil
}

// Close 释放缓存的 RAR 会话与文件句柄。
func (b *Builder) Close() error {
	if b == nil || b.rar == nil {
		return nil
	}
	return b.rar.close()
}

// Build 生成一本漫画的 manifest，不写入数据库。
func (b *Builder) Build(ctx context.Context, source Source) (Manifest, error) {
	if err := validateSource(source); err != nil {
		return Manifest{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, DefaultOperationTimeout)
	defer cancel()

	var (
		pages []indexedPage
		err   error
	)
	switch source.Format {
	case FormatCBZ:
		pages, err = b.buildZIP(ctx, source)
	case FormatCBR:
		pages, err = b.buildRAR(ctx, source)
	default:
		return Manifest{}, ErrUnsupportedFormat
	}
	if err != nil {
		return Manifest{}, normalizeContextError(ctx, err)
	}
	manifest, err := buildManifest(source, pages)
	if err != nil {
		return Manifest{}, err
	}
	b.storeEntryIndex(source, indexFromPages(pages))
	return manifest, nil
}

// ValidFor 报告持久化 manifest 是否仍与当前原件/索引版本匹配且结构有效。
func (m Manifest) ValidFor(source Source) bool {
	if m.SchemaVersion != ManifestSchemaVersion || m.BookID != source.BookID ||
		m.FileVersion != source.FileVersion || m.Format != source.Format ||
		m.IndexVersion != source.IndexVersion {
		return false
	}
	if m.FormatData.PageCount != len(m.FormatData.Pages) || len(m.FormatData.Pages) == 0 ||
		m.FormatData.Pages == nil || !m.ReadingCapabilities.CanRead || m.TOC == nil ||
		m.ReadingCapabilities.Features == nil {
		return false
	}
	seen := make(map[string]struct{}, len(m.FormatData.Pages))
	for index, page := range m.FormatData.Pages {
		if page.Page != index+1 || !validResourceID(page.ResourceID) ||
			page.Width == nil || page.Height == nil ||
			*page.Width <= 0 || *page.Height <= 0 || page.Size <= 0 {
			return false
		}
		if _, exists := seen[page.ResourceID]; exists {
			return false
		}
		seen[page.ResourceID] = struct{}{}
		if !validMediaType(page.MediaType) || !validVariants(page.AvailableVariants) {
			return false
		}
	}
	return true
}

// PageByResourceID 在当前 manifest 中查找页；resourceId 必须已由 HTTP 层
// 校验为 32 位十六进制。
func PageByResourceID(manifest Manifest, resourceID string) (Page, bool) {
	resourceID = strings.ToLower(strings.TrimSpace(resourceID))
	for _, page := range manifest.FormatData.Pages {
		if page.ResourceID == resourceID {
			return page, true
		}
	}
	return Page{}, false
}

// OriginalPageAvailable 报告单页是否满足 original 变体的字节与像素上限。
func OriginalPageAvailable(page Page) bool {
	if page.Size <= 0 || page.Size > MaxOriginalBytes ||
		page.Width == nil || page.Height == nil || *page.Width <= 0 || *page.Height <= 0 {
		return false
	}
	pixels := int64(*page.Width) * int64(*page.Height)
	return pixels > 0 && pixels <= MaxOriginalPixels
}

// ResourceID 返回规范化归档路径的资源 ID：sha256(path) 的前 32 个十六进制字符。
func ResourceID(archivePath string) string {
	sum := sha256.Sum256([]byte(archivePath))
	return hex.EncodeToString(sum[:])[:32]
}

// ScreenCachePath 返回 screen 派生图的固定缓存路径。
func ScreenCachePath(cacheDir, bookID, fileVersion, resourceID string) (string, error) {
	if strings.TrimSpace(cacheDir) == "" || !validHexID(bookID, 32) ||
		!validHexID(fileVersion, 64) || !validHexID(resourceID, 32) {
		return "", ErrPageNotFound
	}
	return filepath.Join(cacheDir, "comic", strings.ToLower(bookID),
		strings.ToLower(fileVersion), strings.ToLower(resourceID)+"-screen-v1.jpg"), nil
}

// ScreenETag 是 screen 变体的稳定强 ETag；算法变化时提升版本号。
func ScreenETag(fileVersion, resourceID string) string {
	return quoteETag("c1-" + shortHash(strings.ToLower(fileVersion)+":"+
		strings.ToLower(resourceID)+":screen-v1"))
}

// OriginalETag 是 original 变体的稳定强 ETag。
func OriginalETag(fileVersion, resourceID string) string {
	return quoteETag("o1-" + shortHash(strings.ToLower(fileVersion)+":"+
		strings.ToLower(resourceID)+":original-v1"))
}

// Reason 把内部错误映射为稳定的、可公开的错误原因，不包含路径或条目名。
func Reason(err error) string {
	switch {
	case errors.Is(err, ErrEncryptedArchive):
		return "encrypted_archive"
	case errors.Is(err, ErrUnsupportedArchive):
		return "unsupported_archive"
	case errors.Is(err, ErrUnsafeArchive):
		return "unsafe_archive"
	case errors.Is(err, ErrArchiveLimit):
		return "archive_limit"
	case errors.Is(err, ErrUnsupportedFormat):
		return "unsupported_format"
	case errors.Is(err, ErrStorageUnavailable):
		return "storage_unavailable"
	case errors.Is(err, ErrParserTimeout):
		return "parser_timeout"
	default:
		return "invalid_archive"
	}
}

type indexedPage struct {
	path      string
	zipName   string
	ordinal   int
	width     int
	height    int
	mediaType string
	size      int64
}

type entryRef struct {
	path    string
	zipName string
	ordinal int
}

type entryIndex struct {
	byResource map[string]entryRef
}

func indexFromPages(pages []indexedPage) *entryIndex {
	index := &entryIndex{byResource: make(map[string]entryRef, len(pages))}
	for _, page := range pages {
		index.byResource[ResourceID(page.path)] = entryRef{
			path: page.path, zipName: page.zipName, ordinal: page.ordinal,
		}
	}
	return index
}

func (b *Builder) entryCacheKey(source Source) string {
	return source.Format + "\x00" + source.BookID + "\x00" + source.FileVersion
}

func (b *Builder) storeEntryIndex(source Source, index *entryIndex) {
	if index == nil {
		return
	}
	b.entriesMu.Lock()
	defer b.entriesMu.Unlock()
	if len(b.entries) >= 8 {
		for key := range b.entries {
			delete(b.entries, key)
			break
		}
	}
	b.entries[b.entryCacheKey(source)] = index
}

func (b *Builder) cachedEntryIndex(source Source) (*entryIndex, bool) {
	b.entriesMu.Lock()
	defer b.entriesMu.Unlock()
	index, found := b.entries[b.entryCacheKey(source)]
	return index, found
}

// resolveEntry 把 manifest 中的 resourceId 映射为归档条目；缓存缺失时只
// 扫描条目名/头，不重新解码图片。
func (b *Builder) resolveEntry(ctx context.Context, source Source, resourceID string) (entryRef, error) {
	index, found := b.cachedEntryIndex(source)
	if !found {
		var err error
		switch source.Format {
		case FormatCBZ:
			index, err = b.zipEntryIndex(ctx, source)
		case FormatCBR:
			index, err = b.rarEntryIndex(ctx, source)
		default:
			return entryRef{}, ErrUnsupportedFormat
		}
		if err != nil {
			return entryRef{}, err
		}
		b.storeEntryIndex(source, index)
	}
	reference, found := index.byResource[strings.ToLower(resourceID)]
	if !found {
		return entryRef{}, ErrPageNotFound
	}
	return reference, nil
}

func buildManifest(source Source, pages []indexedPage) (Manifest, error) {
	if len(pages) == 0 {
		return Manifest{}, ErrInvalidArchive
	}
	sortPages(pages)
	seen := make(map[string]struct{}, len(pages))
	result := make([]Page, 0, len(pages))
	for position, page := range pages {
		resourceID := ResourceID(page.path)
		if _, exists := seen[resourceID]; exists {
			return Manifest{}, ErrInvalidArchive
		}
		seen[resourceID] = struct{}{}
		width, height := page.width, page.height
		variants := []string{VariantScreen}
		manifestPage := Page{
			Page:              position + 1,
			ResourceID:        resourceID,
			Width:             &width,
			Height:            &height,
			MediaType:         page.mediaType,
			Size:              page.size,
			AvailableVariants: variants,
		}
		if OriginalPageAvailable(manifestPage) {
			manifestPage.AvailableVariants = append(manifestPage.AvailableVariants, VariantOriginal)
		}
		result = append(result, manifestPage)
	}
	return Manifest{
		SchemaVersion: ManifestSchemaVersion,
		BookID:        source.BookID,
		FileVersion:   source.FileVersion,
		Format:        source.Format,
		IndexVersion:  source.IndexVersion,
		ReadingCapabilities: ReadingCapabilities{
			CanRead:  true,
			Features: []string{"bookmarks", "settings"},
		},
		TOC: []TOCItem{},
		FormatData: FormatData{
			PageCount: len(result),
			Pages:     result,
		},
	}, nil
}

func validateSource(source Source) error {
	if !validHexID(source.BookID, 32) || !validHexID(source.FileVersion, 64) {
		return ErrBookNotFound
	}
	if source.Format != FormatCBZ && source.Format != FormatCBR {
		return ErrUnsupportedFormat
	}
	if _, err := safeStorageRelPath(source.StorageRelPath); err != nil {
		return ErrStorageUnavailable
	}
	return nil
}

func validMediaType(value string) bool {
	switch value {
	case MediaTypeJPEG, MediaTypePNG, MediaTypeGIF:
		return true
	default:
		return false
	}
}

func validVariants(values []string) bool {
	if len(values) == 0 || values[0] != VariantScreen {
		return false
	}
	for index, value := range values {
		switch value {
		case VariantScreen:
			if index != 0 {
				return false
			}
		case VariantOriginal:
			if index != 1 {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func validHexID(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') &&
			(character < 'A' || character > 'F') {
			return false
		}
	}
	return true
}

func validResourceID(value string) bool { return validHexID(value, 32) }

func quoteETag(value string) string { return `"` + value + `"` }

func shortHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:32]
}

// safeStorageRelPath 只接受 books 根内的相对路径；登记路径由 bookId、哈希与
// 扩展名组成，不应出现反斜杠、百分号编码或 ".."。
func safeStorageRelPath(rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) || strings.ContainsRune(rel, 0) ||
		strings.Contains(rel, `\`) || strings.Contains(rel, "%") {
		return "", errors.New("comic: unsafe storage path")
	}
	for _, segment := range strings.Split(rel, "/") {
		if segment == ".." || segment == "" {
			return "", errors.New("comic: unsafe storage path")
		}
	}
	cleaned := filepath.Clean(rel)
	if cleaned == "." || cleaned == ".." || filepath.IsAbs(cleaned) ||
		strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", errors.New("comic: unsafe storage path")
	}
	return cleaned, nil
}

// openStorageFile 在 books 根内安全打开原件；错误信息不包含宿主路径。
func openStorageFile(booksDir, storageRelPath string) (*os.File, int64, error) {
	rel, err := safeStorageRelPath(storageRelPath)
	if err != nil {
		return nil, 0, ErrStorageUnavailable
	}
	root, err := os.OpenRoot(booksDir)
	if err != nil {
		return nil, 0, ErrStorageUnavailable
	}
	file, err := root.Open(filepath.FromSlash(rel))
	_ = root.Close()
	if err != nil {
		return nil, 0, ErrStorageUnavailable
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, 0, ErrStorageUnavailable
	}
	size := info.Size()
	if size <= 0 {
		_ = file.Close()
		return nil, 0, ErrInvalidArchive
	}
	if size > MaxFileSize {
		_ = file.Close()
		return nil, 0, ErrArchiveLimit
	}
	return file, size, nil
}

func normalizeContextError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return fmt.Errorf("%w: %w", ErrParserTimeout, ctx.Err())
	}
	return err
}

func withOperationTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, DefaultOperationTimeout)
}

func hasMacOSXSegment(archivePath string) bool {
	for _, segment := range strings.Split(archivePath, "/") {
		if segment == "__MACOSX" {
			return true
		}
	}
	return false
}

func isComicImagePath(archivePath string) bool {
	base := path.Base(archivePath)
	if strings.HasPrefix(base, "._") || hasMacOSXSegment(archivePath) {
		return false
	}
	switch strings.ToLower(path.Ext(base)) {
	case ".jpg", ".jpeg", ".png", ".gif":
		return true
	default:
		return false
	}
}

// normalizeArchivePath 拒绝绝对路径、盘符、NUL、超长与 ".." 段，返回清理后
// 的、以 "/" 分隔的归档路径。反斜杠按 ZIP/RAR 常见写法统一为 "/"。
func normalizeArchivePath(name string) (string, error) {
	if name == "" || strings.ContainsRune(name, 0) || len(name) > maxArchivePathBytes {
		return "", ErrUnsafeArchive
	}
	normalized := strings.ReplaceAll(name, `\`, "/")
	if strings.HasPrefix(normalized, "/") {
		return "", ErrUnsafeArchive
	}
	if len(normalized) >= 2 && isASCIILetter(normalized[0]) && normalized[1] == ':' {
		return "", ErrUnsafeArchive
	}
	for _, segment := range strings.Split(normalized, "/") {
		if segment == ".." {
			return "", ErrUnsafeArchive
		}
	}
	cleaned := path.Clean(normalized)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") ||
		strings.HasPrefix(cleaned, "/") {
		return "", ErrUnsafeArchive
	}
	return cleaned, nil
}

func isASCIILetter(value byte) bool {
	return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z')
}

func compressionRatioExceeded(uncompressed, compressed uint64) bool {
	if uncompressed <= uint64(CompressionRatioBytes) {
		return false
	}
	if compressed == 0 {
		return true
	}
	return uncompressed > compressed*uint64(MaxCompressionRatio)
}
