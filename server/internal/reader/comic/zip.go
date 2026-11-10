package comic

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"math"
	"os"
)

const (
	eocdSignature         = "PK\x05\x06"
	zip64LocatorSignature = "PK\x06\x07"
	zip64EOCDSignature    = "PK\x06\x06"
	eocdMinSize           = 22
	zip64LocatorSize      = 20
	zip64EOCDMinSize      = 56
	maxZipTailBytes       = 65_557
	maxCentralDirBytes    = 128 << 20
	zipFlagEncrypted      = 0x1
	zip64EntriesField     = 0xFFFF
	zip64SizeField        = 0xFFFFFFFF
	zip64EOCDTotalEntries = 32
	zip64EOCDCentralSize  = 40
	zip64LocatorCDOffset  = 8
)

type zipHandle struct {
	file   *os.File
	reader *zip.Reader
}

func (h *zipHandle) Close() error {
	if h == nil || h.file == nil {
		return nil
	}
	return h.file.Close()
}

type zipEntry struct {
	file *zip.File
	path string
}

// openZIP 在打开中央目录前先检查声明条目数，避免恶意 ZIP 在分配阶段耗尽内存。
func (b *Builder) openZIP(ctx context.Context, source Source) (*zipHandle, error) {
	file, size, err := openStorageFile(b.booksDir, source.StorageRelPath)
	if err != nil {
		return nil, err
	}
	if err := checkZIPEntryCount(ctx, file, size); err != nil {
		_ = file.Close()
		return nil, err
	}
	reader, err := zip.NewReader(contextReaderAt{ctx: ctx, reader: file}, size)
	if err != nil {
		_ = file.Close()
		if ctx.Err() != nil {
			return nil, normalizeContextError(ctx, err)
		}
		return nil, ErrInvalidArchive
	}
	if len(reader.File) > MaxArchiveEntries {
		_ = file.Close()
		return nil, ErrArchiveLimit
	}
	return &zipHandle{file: file, reader: reader}, nil
}

// zipEntries 安全扫描所有非目录条目：拒绝路径穿越、符号链接、加密、重复
// 路径、超限解压量与异常压缩比。返回的路径已规范化。
func (b *Builder) zipEntries(ctx context.Context, source Source) (*zipHandle, []zipEntry, error) {
	handle, err := b.openZIP(ctx, source)
	if err != nil {
		return nil, nil, err
	}
	entries, err := validateZIPEntries(ctx, handle.reader)
	if err != nil {
		_ = handle.Close()
		return nil, nil, err
	}
	return handle, entries, nil
}

func validateZIPEntries(ctx context.Context, reader *zip.Reader) ([]zipEntry, error) {
	if len(reader.File) > MaxArchiveEntries {
		return nil, ErrArchiveLimit
	}
	seenRaw := make(map[string]struct{}, len(reader.File))
	seenPath := make(map[string]struct{}, len(reader.File))
	entries := make([]zipEntry, 0, len(reader.File))
	var total uint64

	for _, file := range reader.File {
		if err := ctx.Err(); err != nil {
			return nil, normalizeContextError(ctx, err)
		}
		if _, exists := seenRaw[file.Name]; exists {
			return nil, ErrInvalidArchive
		}
		seenRaw[file.Name] = struct{}{}
		normalized, err := normalizeArchivePath(file.Name)
		if err != nil {
			return nil, err
		}
		if file.Flags&zipFlagEncrypted != 0 {
			return nil, ErrEncryptedArchive
		}
		mode := file.Mode()
		if mode&os.ModeSymlink != 0 {
			return nil, ErrUnsafeArchive
		}
		if file.FileInfo().IsDir() {
			continue
		}
		if !mode.IsRegular() {
			return nil, ErrInvalidArchive
		}
		if _, exists := seenPath[normalized]; exists {
			return nil, ErrInvalidArchive
		}
		seenPath[normalized] = struct{}{}

		if file.UncompressedSize64 > uint64(MaxEntryUncompressed) {
			return nil, ErrArchiveLimit
		}
		if math.MaxUint64-total < file.UncompressedSize64 {
			return nil, ErrArchiveLimit
		}
		total += file.UncompressedSize64
		if total > uint64(MaxTotalUncompressed) {
			return nil, ErrArchiveLimit
		}
		if compressionRatioExceeded(file.UncompressedSize64, file.CompressedSize64) {
			return nil, ErrArchiveLimit
		}
		entries = append(entries, zipEntry{file: file, path: normalized})
	}
	return entries, nil
}

func (b *Builder) buildZIP(ctx context.Context, source Source) ([]indexedPage, error) {
	handle, entries, err := b.zipEntries(ctx, source)
	if err != nil {
		return nil, err
	}
	defer handle.Close()

	pages := make([]indexedPage, 0, len(entries))
	for _, entry := range entries {
		if !isComicImagePath(entry.path) {
			continue
		}
		width, height, mediaType, err := inspectZIPImage(ctx, entry.file)
		if err != nil {
			return nil, err
		}
		if entry.file.UncompressedSize64 == 0 {
			return nil, ErrInvalidArchive
		}
		pages = append(pages, indexedPage{
			path:      entry.path,
			zipName:   entry.file.Name,
			width:     width,
			height:    height,
			mediaType: mediaType,
			size:      int64(entry.file.UncompressedSize64),
		})
	}
	if len(pages) == 0 {
		return nil, ErrInvalidArchive
	}
	return pages, nil
}

func (b *Builder) zipEntryIndex(ctx context.Context, source Source) (*entryIndex, error) {
	handle, entries, err := b.zipEntries(ctx, source)
	if err != nil {
		return nil, err
	}
	defer handle.Close()

	index := &entryIndex{byResource: make(map[string]entryRef)}
	for position, entry := range entries {
		if !isComicImagePath(entry.path) {
			continue
		}
		resourceID := ResourceID(entry.path)
		if _, exists := index.byResource[resourceID]; exists {
			return nil, ErrInvalidArchive
		}
		index.byResource[resourceID] = entryRef{
			path: entry.path, zipName: entry.file.Name, ordinal: position,
		}
	}
	if len(index.byResource) == 0 {
		return nil, ErrInvalidArchive
	}
	return index, nil
}

func inspectZIPImage(ctx context.Context, file *zip.File) (int, int, string, error) {
	reader, err := file.Open()
	if err != nil {
		return 0, 0, "", ErrInvalidArchive
	}
	defer reader.Close()
	return inspectImageConfig(ctx, reader)
}

func (b *Builder) readZIPPage(ctx context.Context, source Source, reference entryRef, fn func(io.Reader, int64) error) error {
	handle, err := b.openZIP(ctx, source)
	if err != nil {
		return err
	}
	defer handle.Close()

	var target *zip.File
	for _, file := range handle.reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		if file.Name == reference.zipName {
			target = file
			break
		}
	}
	if target == nil {
		// manifest 中保存的 zipName 缺失时按规范化路径回退匹配，避免仅因
		// 反斜杠/清理差异拒绝合法页。
		for _, file := range handle.reader.File {
			if file.FileInfo().IsDir() {
				continue
			}
			normalized, normalizeErr := normalizeArchivePath(file.Name)
			if normalizeErr == nil && normalized == reference.path {
				target = file
				break
			}
		}
	}
	if target == nil || target.FileInfo().IsDir() {
		return ErrPageNotFound
	}
	if target.UncompressedSize64 == 0 || target.UncompressedSize64 > uint64(MaxEntryUncompressed) {
		return ErrArchiveLimit
	}
	reader, err := target.Open()
	if err != nil {
		return ErrInvalidArchive
	}
	defer reader.Close()

	limited := &io.LimitedReader{
		R: contextReader{ctx: ctx, reader: reader},
		N: int64(target.UncompressedSize64) + 1,
	}
	if err := fn(limited, int64(target.UncompressedSize64)); err != nil {
		return normalizeContextError(ctx, err)
	}
	if limited.N <= 0 {
		return ErrInvalidArchive
	}
	return nil
}

// checkZIPEntryCount 用 EOCD/ZIP64 的声明条目数在 zip.NewReader 分配前拦截
// 超大中央目录。实现与 internal/formats 的 ZIP 预检保持一致。
func checkZIPEntryCount(ctx context.Context, file *os.File, size int64) error {
	if size < eocdMinSize {
		return ErrInvalidArchive
	}
	tailLen := int64(maxZipTailBytes)
	if size < tailLen {
		tailLen = size
	}
	tail, err := readAtContext(ctx, file, size, size-tailLen, tailLen)
	if err != nil {
		if ctx.Err() != nil {
			return normalizeContextError(ctx, err)
		}
		return ErrInvalidArchive
	}

	eocd := findEOCD(tail)
	if eocd < 0 {
		return ErrInvalidArchive
	}
	total := uint64(binary.LittleEndian.Uint16(tail[eocd+10 : eocd+12]))
	centralSize := uint64(binary.LittleEndian.Uint32(tail[eocd+12 : eocd+16]))
	if total != zip64EntriesField && centralSize != zip64SizeField {
		if centralSize > maxCentralDirBytes {
			return ErrArchiveLimit
		}
		if total > MaxArchiveEntries {
			return ErrArchiveLimit
		}
		return nil
	}

	locator := eocd - zip64LocatorSize
	if locator < 0 || !bytes.HasPrefix(tail[locator:], []byte(zip64LocatorSignature)) {
		return ErrInvalidArchive
	}
	eocd64Offset := binary.LittleEndian.Uint64(tail[locator+zip64LocatorCDOffset : locator+zip64LocatorCDOffset+8])
	if eocd64Offset > uint64(size) || uint64(size)-eocd64Offset < zip64EOCDMinSize {
		return ErrInvalidArchive
	}
	eocd64, err := readAtContext(ctx, file, size, int64(eocd64Offset), zip64EOCDMinSize)
	if err != nil {
		if ctx.Err() != nil {
			return normalizeContextError(ctx, err)
		}
		return ErrInvalidArchive
	}
	if !bytes.HasPrefix(eocd64, []byte(zip64EOCDSignature)) || len(eocd64) < zip64EOCDCentralSize+8 {
		return ErrInvalidArchive
	}
	if binary.LittleEndian.Uint64(eocd64[zip64EOCDCentralSize:zip64EOCDCentralSize+8]) > maxCentralDirBytes {
		return ErrArchiveLimit
	}
	if binary.LittleEndian.Uint64(eocd64[zip64EOCDTotalEntries:zip64EOCDTotalEntries+8]) > MaxArchiveEntries {
		return ErrArchiveLimit
	}
	return nil
}

// findEOCD 从尾部反向寻找注释长度与文件结尾严格吻合的 EOCD，避免注释中
// 伪造的签名把条目数检查引向错误位置。
func findEOCD(tail []byte) int {
	searchEnd := len(tail)
	for searchEnd >= eocdMinSize {
		index := bytes.LastIndex(tail[:searchEnd], []byte(eocdSignature))
		if index < 0 {
			return -1
		}
		if index+eocdMinSize <= len(tail) {
			commentLength := int(binary.LittleEndian.Uint16(tail[index+20 : index+22]))
			if index+eocdMinSize+commentLength == len(tail) {
				return index
			}
		}
		searchEnd = index
	}
	return -1
}

func readAtContext(ctx context.Context, reader io.ReaderAt, size, offset, length int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if offset < 0 || length < 0 || offset > size || length > size-offset {
		return nil, ErrInvalidArchive
	}
	buffer := make([]byte, length)
	read, err := reader.ReadAt(buffer, offset)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if int64(read) != length {
		return nil, ErrInvalidArchive
	}
	return buffer, nil
}

type contextReaderAt struct {
	ctx    context.Context
	reader io.ReaderAt
}

func (r contextReaderAt) ReadAt(buffer []byte, offset int64) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.ReadAt(buffer, offset)
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
