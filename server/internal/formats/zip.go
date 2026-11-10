package formats

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"math"
	"os"
	"strings"
)

const (
	eocdSignature         = "PK\x05\x06"
	zip64LocatorSignature = "PK\x06\x07"
	zip64EOCDSignature    = "PK\x06\x06"
	eocdMinSize           = 22
	zip64LocatorSize      = 20
	zip64EOCDMinSize      = 56
	maxZipTailBytes       = 65_557 // EOCD 最大长度（注释 65535 + 固定 22）
	maxCentralDirBytes    = 128 << 20
	zipFlagEncrypted      = 0x1
	zip64EntriesField     = 0xFFFF
	zip64SizeField        = 0xFFFFFFFF
	zip64EOCDTotalEntries = 32
	zip64EOCDCentralSize  = 40
	zip64LocatorCDOffset  = 8
)

// archiveInfo 是安全扫描后的 ZIP 只读视图。
type archiveInfo struct {
	files map[string]*zip.File
	list  []*zip.File
}

// inspectZIP 在打开中央目录前先检查条目总数，再逐条校验路径、符号链接、
// 加密标志与解压预算。返回的 zip.Reader 只读，不会改动原文件。
func inspectZIP(ctx context.Context, f *os.File, size int64) (*archiveInfo, error) {
	if err := checkZIPEntryCount(ctx, f, size); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, timeoutErr(ctx)
	}

	zr, err := zip.NewReader(ctxReaderAt{ctx: ctx, r: f}, size)
	if err != nil {
		return nil, &ValidationError{Reason: ReasonCorruptContainer}
	}
	if len(zr.File) > MaxArchiveEntries {
		return nil, &ValidationError{Reason: ReasonArchiveEntryLimit}
	}

	info := &archiveInfo{
		files: make(map[string]*zip.File, len(zr.File)),
		list:  make([]*zip.File, 0, len(zr.File)),
	}
	seen := make(map[string]struct{}, len(zr.File))
	var total uint64

	for _, zf := range zr.File {
		if err := ctx.Err(); err != nil {
			return nil, timeoutErr(ctx)
		}
		if reason := validateArchivePath(zf.Name); reason != "" {
			return nil, &ValidationError{Reason: reason}
		}
		if _, exists := seen[zf.Name]; exists {
			return nil, &ValidationError{Reason: ReasonCorruptContainer}
		}
		seen[zf.Name] = struct{}{}

		if zf.Flags&zipFlagEncrypted != 0 {
			return nil, &ValidationError{Reason: ReasonEncryptedArchive}
		}

		mode := zf.Mode()
		if mode&os.ModeSymlink != 0 {
			return nil, &ValidationError{Reason: ReasonArchiveSymlink}
		}
		if mode.IsDir() {
			info.files[zf.Name] = zf
			info.list = append(info.list, zf)
			continue
		}
		if !mode.IsRegular() {
			return nil, &ValidationError{Reason: ReasonCorruptContainer}
		}

		if zf.UncompressedSize64 > uint64(MaxEntryUncompressed) {
			return nil, &ValidationError{Reason: ReasonArchiveUncompressed}
		}
		if math.MaxUint64-total < zf.UncompressedSize64 {
			return nil, &ValidationError{Reason: ReasonArchiveUncompressed}
		}
		total += zf.UncompressedSize64
		if total > uint64(MaxTotalUncompressed) {
			return nil, &ValidationError{Reason: ReasonArchiveUncompressed}
		}
		if compressionRatioExceeded(zf.UncompressedSize64, zf.CompressedSize64) {
			return nil, &ValidationError{Reason: ReasonArchiveCompressionRatio}
		}

		info.files[zf.Name] = zf
		info.list = append(info.list, zf)
	}
	return info, nil
}

// checkZIPEntryCount 用 EOCD/ZIP64 的声明条目数在 zip.NewReader 分配前拦截超大目录。
func checkZIPEntryCount(ctx context.Context, f *os.File, size int64) error {
	if size < eocdMinSize {
		return &ValidationError{Reason: ReasonCorruptContainer}
	}
	tailLen := int64(maxZipTailBytes)
	if size < tailLen {
		tailLen = size
	}
	tail, err := readAt(ctx, f, size, size-tailLen, tailLen)
	if err != nil {
		if ctx.Err() != nil {
			return timeoutErr(ctx)
		}
		return &ValidationError{Reason: ReasonCorruptContainer}
	}

	eocd := findEOCD(tail)
	if eocd < 0 {
		return &ValidationError{Reason: ReasonCorruptContainer}
	}
	total := uint64(binary.LittleEndian.Uint16(tail[eocd+10 : eocd+12]))
	centralSize := uint64(binary.LittleEndian.Uint32(tail[eocd+12 : eocd+16]))
	if total != zip64EntriesField && centralSize != zip64SizeField {
		if centralSize > maxCentralDirBytes {
			return &ValidationError{Reason: ReasonArchiveEntryLimit}
		}
		return checkEntryLimit(total)
	}

	locator := eocd - zip64LocatorSize
	if locator < 0 || !bytes.HasPrefix(tail[locator:], []byte(zip64LocatorSignature)) {
		return &ValidationError{Reason: ReasonCorruptContainer}
	}
	eocd64Offset := binary.LittleEndian.Uint64(tail[locator+zip64LocatorCDOffset : locator+zip64LocatorCDOffset+8])
	if eocd64Offset > uint64(size) || uint64(size)-eocd64Offset < zip64EOCDMinSize {
		return &ValidationError{Reason: ReasonCorruptContainer}
	}
	eocd64, err := readAt(ctx, f, size, int64(eocd64Offset), zip64EOCDMinSize)
	if err != nil {
		if ctx.Err() != nil {
			return timeoutErr(ctx)
		}
		return &ValidationError{Reason: ReasonCorruptContainer}
	}
	if !bytes.HasPrefix(eocd64, []byte(zip64EOCDSignature)) || len(eocd64) < zip64EOCDCentralSize+8 {
		return &ValidationError{Reason: ReasonCorruptContainer}
	}
	if binary.LittleEndian.Uint64(eocd64[zip64EOCDCentralSize:zip64EOCDCentralSize+8]) > maxCentralDirBytes {
		return &ValidationError{Reason: ReasonArchiveEntryLimit}
	}
	return checkEntryLimit(binary.LittleEndian.Uint64(eocd64[zip64EOCDTotalEntries : zip64EOCDTotalEntries+8]))
}

// findEOCD 从尾部反向寻找注释长度与文件结尾严格吻合的 EOCD，避免注释中
// 伪造的 PK\x05\x06 把条目数检查引向错误位置。
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

func checkEntryLimit(total uint64) error {
	if total > MaxArchiveEntries {
		return &ValidationError{Reason: ReasonArchiveEntryLimit}
	}
	return nil
}

// validateArchivePath 拒绝绝对路径、盘符、NUL、.. 与超长条目名。
func validateArchivePath(name string) string {
	if name == "" || strings.ContainsRune(name, 0) {
		return ReasonArchivePathTraversal
	}
	if len(name) > maxArchivePathBytes {
		return ReasonArchiveEntryLimit
	}
	if strings.HasPrefix(name, "/") || strings.HasPrefix(name, `\`) {
		return ReasonArchivePathTraversal
	}
	if len(name) >= 2 && isASCIILetter(name[0]) && name[1] == ':' {
		return ReasonArchivePathTraversal
	}
	normalized := strings.ReplaceAll(name, `\`, "/")
	for _, part := range strings.Split(normalized, "/") {
		if part == ".." {
			return ReasonArchivePathTraversal
		}
	}
	return ""
}

func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
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

// readArchiveEntry 读取完整条目，超过 limit 视为损坏，不继续解压。
func readArchiveEntry(ctx context.Context, zf *zip.File, limit int64) ([]byte, error) {
	if zf.UncompressedSize64 > uint64(limit) {
		return nil, &ValidationError{Reason: ReasonCorruptContainer}
	}
	rc, err := zf.Open()
	if err != nil {
		return nil, &ValidationError{Reason: ReasonCorruptContainer}
	}
	defer rc.Close()

	reader := &io.LimitedReader{R: ctxReader{ctx: ctx, r: rc}, N: limit + 1}
	data, err := io.ReadAll(reader)
	if err != nil {
		if ctx.Err() != nil {
			return nil, timeoutErr(ctx)
		}
		return nil, &ValidationError{Reason: ReasonCorruptContainer}
	}
	if int64(len(data)) > limit {
		return nil, &ValidationError{Reason: ReasonCorruptContainer}
	}
	return data, nil
}

func timeoutErr(ctx context.Context) error {
	cause := ctx.Err()
	if cause == nil {
		cause = context.DeadlineExceeded
	}
	return &ValidationError{Reason: ReasonParserTimeout, cause: cause}
}
