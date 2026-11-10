package epub

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

var (
	// ErrBookNotFound 表示书籍记录不存在。
	ErrBookNotFound = errors.New("epub: book not found")
	// ErrInvalidBook 表示 EPUB 容器或 OPF 结构无效。
	ErrInvalidBook = errors.New("epub: invalid book")
	// ErrStorageUnavailable 表示原件无法打开或读取。
	ErrStorageUnavailable = errors.New("epub: storage unavailable")
	// ErrUnsupportedFormat 表示当前 manifest 服务只支持 EPUB。
	ErrUnsupportedFormat = errors.New("epub: unsupported format")
	// ErrResourceNotFound 表示资源 ID 不存在或路径不安全。
	ErrResourceNotFound = errors.New("epub: resource not found")
	// ErrUnsupportedResource 表示资源类型不在 Content-Type 白名单内。
	ErrUnsupportedResource = errors.New("epub: unsupported resource type")
	// ErrContentEncrypted 表示书籍内容受 DRM/加密保护。
	ErrContentEncrypted = errors.New("epub: content encrypted")
	// ErrObfuscationUnavailable 表示字体混淆 key 无法推导。
	ErrObfuscationUnavailable = errors.New("epub: font obfuscation unavailable")
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

// Builder 读取 books 根目录下的 EPUB 原件。
type Builder struct {
	booksDir string
}

// NewBuilder 构造解析器；booksDir 必须是已存在的目录。
func NewBuilder(booksDir string) (*Builder, error) {
	if strings.TrimSpace(booksDir) == "" {
		return nil, errors.New("epub: books 目录不能为空")
	}
	absolute, err := filepath.Abs(booksDir)
	if err != nil {
		return nil, fmt.Errorf("epub: books 目录无法解析: %w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return nil, fmt.Errorf("epub: books 目录不可用: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("epub: books 路径不是目录")
	}
	return &Builder{booksDir: absolute}, nil
}

// Build 生成一本 EPUB 的 manifest。结果不包含宿主文件路径。
func (b *Builder) Build(ctx context.Context, source Source) (Manifest, error) {
	if source.Format != "" && source.Format != FormatEPUB {
		return Manifest{}, ErrUnsupportedFormat
	}
	if err := ctx.Err(); err != nil {
		return Manifest{}, err
	}
	archive, err := b.openArchive(source.StorageRelPath)
	if err != nil {
		return Manifest{}, err
	}
	defer archive.Close()

	pkg, err := readPackage(ctx, archive)
	if err != nil {
		return Manifest{}, normalizeBuildError(ctx, err)
	}
	encryption, err := readEncryption(ctx, archive, pkg)
	if err != nil {
		return Manifest{}, normalizeBuildError(ctx, err)
	}

	pathToResource := make(map[string]string, len(pkg.byPath))
	for archivePath, item := range pkg.byPath {
		if item.Servable {
			pathToResource[archivePath] = item.ResourceID
		}
	}
	toc, err := parseTOC(ctx, archive, pkg, pathToResource)
	if err != nil {
		return Manifest{}, normalizeBuildError(ctx, err)
	}

	spine := make([]SpineItem, 0, len(pkg.document.Spine.ItemRefs))
	for position, itemRef := range pkg.document.Spine.ItemRefs {
		item := pkg.byID[strings.TrimSpace(itemRef.IDRef)]
		if item == nil || item.ZipEntry == nil || !item.Servable {
			continue
		}
		linear := !strings.EqualFold(strings.TrimSpace(itemRef.Linear), "no")
		spine = append(spine, SpineItem{
			Index:      len(spine),
			ResourceID: item.ResourceID,
			Href:       item.ArchivePath,
			MediaType:  item.MediaType,
			Linear:     linear,
			CFIBase:    cfiBase(position, item.ID),
			Size:       item.Size,
		})
	}
	if len(spine) == 0 {
		return Manifest{}, ErrInvalidBook
	}

	resources := make(map[string]Resource, len(pkg.items))
	for _, item := range pkg.items {
		if !item.Servable {
			continue
		}
		resources[item.ResourceID] = Resource{
			Href:      item.ArchivePath,
			MediaType: item.MediaType,
			Size:      item.Size,
			Kind:      item.Kind,
		}
	}

	manifest := Manifest{
		SchemaVersion: ManifestSchemaVersion,
		BookID:        source.BookID,
		FileVersion:   source.FileVersion,
		Format:        FormatEPUB,
		IndexVersion:  source.IndexVersion,
		ReadingCapabilities: ReadingCapabilities{
			CanRead:           !encryption.ContentEncrypted,
			UnavailableReason: "",
			Features:          []string{"toc", "bookmarks", "settings", "text-selection"},
		},
		TOC: toc,
		FormatData: FormatData{
			Rendition:         pkg.rendition(),
			Spine:             spine,
			Resources:         resources,
			ContentProtection: encryption.contentProtection(),
		},
	}
	if encryption.ContentEncrypted {
		manifest.ReadingCapabilities.UnavailableReason = "drm_protected"
		manifest.ReadingCapabilities.Features = []string{}
	}
	return manifest, nil
}

func cfiBase(position int, idref string) string {
	// "!" 表示进入 spine 文档根；调用方可在其后直接追加 /4/2 等步骤。
	return "epubcfi(/6/" + strconv.Itoa((position+1)*2) + "[" + idref + "]!)"
}

func normalizeBuildError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, ErrInvalidBook) || errors.Is(err, ErrStorageUnavailable) {
		return err
	}
	return fmt.Errorf("%w: %v", ErrInvalidBook, err)
}

// openedArchive 持有 ZIP 文件与解析后的条目索引。
type openedArchive struct {
	file  *os.File
	files map[string]*zip.File
}

func (a *openedArchive) Close() error {
	if a == nil {
		return nil
	}
	if a.file != nil {
		return a.file.Close()
	}
	return nil
}

// openArchive 在 books 根目录内安全打开原件，建立规范化条目索引。
func (b *Builder) openArchive(storageRelPath string) (*openedArchive, error) {
	rel, err := safeStorageRelPath(storageRelPath)
	if err != nil {
		return nil, ErrStorageUnavailable
	}
	root, err := os.OpenRoot(b.booksDir)
	if err != nil {
		return nil, ErrStorageUnavailable
	}
	file, err := root.Open(filepath.FromSlash(rel))
	_ = root.Close()
	if err != nil {
		return nil, ErrStorageUnavailable
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, ErrStorageUnavailable
	}
	reader, err := zip.NewReader(file, info.Size())
	if err != nil {
		_ = file.Close()
		return nil, ErrInvalidBook
	}
	if len(reader.File) > 20000 {
		_ = file.Close()
		return nil, ErrInvalidBook
	}
	files := make(map[string]*zip.File, len(reader.File))
	for _, entry := range reader.File {
		normalized, ok := normalizeZipEntryName(entry.Name)
		if !ok {
			continue
		}
		if _, exists := files[normalized]; exists {
			continue
		}
		files[normalized] = entry
	}
	return &openedArchive{file: file, files: files}, nil
}

// safeStorageRelPath 只接受 books 根内的相对路径；服务端登记路径由 bookId、
// 哈希与扩展名组成，不应出现反斜杠、百分号编码或 ".."。
func safeStorageRelPath(rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) || strings.ContainsRune(rel, 0) ||
		strings.Contains(rel, `\`) || strings.Contains(rel, "%") {
		return "", errUnsafePath
	}
	for _, segment := range strings.Split(rel, "/") {
		if segment == ".." || segment == "" {
			return "", errUnsafePath
		}
	}
	cleaned := filepath.Clean(rel)
	if cleaned == "." || cleaned == ".." || filepath.IsAbs(cleaned) ||
		strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", errUnsafePath
	}
	return cleaned, nil
}

func readZipEntry(ctx context.Context, file *zip.File, limit int64) ([]byte, error) {
	if file == nil || file.UncompressedSize64 > uint64(limit) {
		return nil, ErrInvalidBook
	}
	reader, err := file.Open()
	if err != nil {
		return nil, ErrInvalidBook
	}
	defer reader.Close()
	limited := &io.LimitedReader{R: contextReader{ctx: ctx, reader: reader}, N: limit + 1}
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, ErrInvalidBook
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
