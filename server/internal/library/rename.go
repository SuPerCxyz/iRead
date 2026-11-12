package library

// 本文件提供原件下载句柄与书名编辑：改名时先原子移动磁盘文件，再在一个
// 事务内更新 books.display_title 与 book_files 的展示名/存储路径；数据库
// 失败则把文件移回原路径。所有读取端都使用数据库登记的 storage_rel_path，
// 不再从 fileVersion 重新拼哈希文件名。

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"iread/server/internal/store"
)

const (
	// maxStorageBaseNameBytes 限制磁盘文件名主体约 200 字节，给扩展名和
	// 冲突后缀留出空间，避免接近常见文件系统的 255 字节上限。
	maxStorageBaseNameBytes = 200
	// maxRenameSuffix 是目标名称已存在时尝试的最大后缀序号。
	maxRenameSuffix = 999
)

var errUnsafeStoragePath = errors.New("library: unsafe storage path")

// OriginalFile 是下载端点持有的只读原件；调用方负责关闭 File。
type OriginalFile struct {
	File      *os.File
	Name      string
	MediaType string
	SHA256    string
	Size      int64
	ModTime   time.Time
}

// OpenOriginal 按书籍当前登记路径打开原件，并返回下载所需的只读元数据。
// 未知书籍或文件缺失返回 404；登记大小与实际文件不一致等存储异常返回 503。
func (s *Service) OpenOriginal(ctx context.Context, bookID string) (*OriginalFile, *Error) {
	if !validOpaqueID(bookID) {
		return nil, newError(404, "not_found", "书籍不存在")
	}

	// 与 RenameBook 的写锁配对：下载要么打开改名前的路径，要么打开改名后的
	// 路径；文件句柄在锁释放后仍然有效。
	s.renameMu.RLock()
	defer s.renameMu.RUnlock()

	detail, err := s.store.GetBookDetail(ctx, bookID)
	if errors.Is(err, store.ErrBookNotFound) {
		return nil, newError(404, "not_found", "书籍不存在")
	}
	if err != nil {
		s.logger.Error("读取下载书籍登记失败", "bookId", bookID, "error", err)
		return nil, newError(500, "internal_error", "服务器内部错误")
	}

	file, info, err := s.openStorageFile(detail.File.StorageRelPath)
	if err != nil {
		switch {
		case errors.Is(err, errUnsafeStoragePath):
			s.logger.Error("原件存储路径越界", "bookId", bookID)
			return nil, newError(404, "not_found", "书籍原件不存在")
		case errors.Is(err, os.ErrNotExist):
			return nil, newError(404, "not_found", "书籍原件不存在")
		default:
			s.logger.Error("打开下载原件失败", "bookId", bookID, "error", err)
			return nil, newError(503, "storage_unavailable", "存储暂不可用")
		}
	}

	if detail.File.ByteSize <= 0 || info.Size() != detail.File.ByteSize {
		_ = file.Close()
		s.logger.Error("下载原件大小与登记不一致", "bookId", bookID)
		return nil, newError(503, "storage_unavailable", "存储暂不可用")
	}

	mediaType := strings.TrimSpace(detail.File.MediaType)
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	return &OriginalFile{
		File:      file,
		Name:      downloadFileName(detail.DisplayTitle, detail.File.Extension, bookID),
		MediaType: mediaType,
		SHA256:    detail.File.SHA256,
		Size:      info.Size(),
		ModTime:   info.ModTime().UTC(),
	}, nil
}

// RenameBook 校验新书名并在磁盘/数据库中同步重命名；返回最新书籍详情。
func (s *Service) RenameBook(ctx context.Context, bookID, title string) (store.BookDetail, *Error) {
	if !validOpaqueID(bookID) {
		return store.BookDetail{}, newError(404, "not_found", "书籍不存在")
	}
	title = strings.TrimSpace(title)
	if apiErr := validateBookTitle(title); apiErr != nil {
		return store.BookDetail{}, apiErr
	}

	s.renameMu.Lock()
	defer s.renameMu.Unlock()

	detail, err := s.store.GetBookDetail(ctx, bookID)
	if errors.Is(err, store.ErrBookNotFound) {
		return store.BookDetail{}, newError(404, "not_found", "书籍不存在")
	}
	if err != nil {
		s.logger.Error("读取待重命名书籍失败", "bookId", bookID, "error", err)
		return store.BookDetail{}, newError(500, "internal_error", "服务器内部错误")
	}
	if detail.Status == "indexing" {
		return store.BookDetail{}, newReasonError(409, "state_conflict",
			"书籍正在索引，请稍后重试", "index_in_progress")
	}

	extension := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(detail.File.Extension), "."))
	if !allowedExtension(extension) {
		s.logger.Error("书籍原件扩展名无效", "bookId", bookID, "extension", extension)
		return store.BookDetail{}, newError(500, "internal_error", "服务器内部错误")
	}
	base := sanitizeBookFileName(title, bookID)
	targetRel, originalFileName, err := s.uniqueOriginalRelPath(bookID, base, extension, detail.File.StorageRelPath)
	if err != nil {
		s.logger.Error("计算重命名目标路径失败", "bookId", bookID, "error", err)
		return store.BookDetail{}, newError(503, "storage_unavailable", "存储暂不可用")
	}

	oldRel := detail.File.StorageRelPath
	oldPath, err := s.safeJoin(oldRel)
	if err != nil {
		s.logger.Error("原存储路径无效", "bookId", bookID)
		return store.BookDetail{}, newError(500, "internal_error", "服务器内部错误")
	}
	if _, err := os.Lstat(oldPath); errors.Is(err, os.ErrNotExist) {
		return store.BookDetail{}, newError(404, "not_found", "书籍原件不存在")
	} else if err != nil {
		s.logger.Error("读取待重命名原件失败", "bookId", bookID, "error", err)
		return store.BookDetail{}, newError(503, "storage_unavailable", "存储暂不可用")
	}

	moved := targetRel != oldRel
	if moved {
		targetPath, err := s.safeJoin(targetRel)
		if err != nil {
			s.logger.Error("目标存储路径无效", "bookId", bookID)
			return store.BookDetail{}, newError(500, "internal_error", "服务器内部错误")
		}
		if err := os.Rename(oldPath, targetPath); err != nil {
			s.logger.Error("重命名原件失败", "bookId", bookID, "error", err)
			return store.BookDetail{}, newError(503, "storage_unavailable", "存储暂不可用")
		}
		if err := fsyncDirectory(filepath.Dir(targetPath)); err != nil {
			s.logger.Error("刷新重命名目录失败", "bookId", bookID, "error", err)
			_ = os.Rename(targetPath, oldPath)
			return store.BookDetail{}, newError(503, "storage_unavailable", "存储暂不可用")
		}
	}

	if err := s.store.RenameBook(ctx, bookID, title, originalFileName, targetRel, s.clock()); err != nil {
		if moved {
			targetPath, joinErr := s.safeJoin(targetRel)
			if joinErr == nil {
				if rollbackErr := os.Rename(targetPath, oldPath); rollbackErr != nil {
					s.logger.Error("数据库失败后回滚原件重命名失败",
						"bookId", bookID, "oldPath", oldRel, "newPath", targetRel, "error", rollbackErr)
				}
			}
		}
		if errors.Is(err, store.ErrBookNotFound) {
			return store.BookDetail{}, newError(404, "not_found", "书籍不存在")
		}
		s.logger.Error("更新重命名登记失败", "bookId", bookID, "error", err)
		return store.BookDetail{}, newError(500, "internal_error", "服务器内部错误")
	}

	s.logger.Info("书籍已重命名",
		"bookId", bookID,
		"oldTitle", detail.DisplayTitle,
		"newTitle", title,
		"oldPath", oldRel,
		"newPath", targetRel,
	)

	updated, err := s.store.GetBookDetail(ctx, bookID)
	if err != nil {
		s.logger.Error("读取重命名结果失败", "bookId", bookID, "error", err)
		return store.BookDetail{}, newError(500, "internal_error", "服务器内部错误")
	}
	return updated, nil
}

func validateBookTitle(title string) *Error {
	if title == "" {
		return newValidationError("title", "required", "书名不能为空")
	}
	if !utf8.ValidString(title) {
		return newValidationError("title", "invalid_utf8", "书名不是合法的 UTF-8 文本")
	}
	if utf8.RuneCountInString(title) > maxDisplayTitleRunes {
		return newValidationError("title", "too_long", "书名不能超过 500 个字符")
	}
	for _, character := range title {
		if character == 0 || unicode.IsControl(character) {
			return newValidationError("title", "control_character", "书名不能包含控制字符")
		}
	}
	return nil
}

// sanitizeBookFileName 生成可安全落盘的文件名主体：替换路径分隔符和常见
// 保留字符为空格、折叠空白、去掉首尾点和空格，并按 UTF-8 边界截断。
func sanitizeBookFileName(title, bookID string) string {
	var builder strings.Builder
	for _, character := range title {
		switch {
		case character == 0 || unicode.IsControl(character):
			builder.WriteByte(' ')
		case strings.ContainsRune(`/\:*?"<>|`, character):
			builder.WriteByte(' ')
		default:
			builder.WriteRune(character)
		}
	}
	cleaned := strings.Join(strings.Fields(builder.String()), " ")
	cleaned = strings.Trim(cleaned, ". ")
	cleaned = truncateUTF8Bytes(cleaned, maxStorageBaseNameBytes)
	cleaned = strings.Trim(cleaned, ". ")
	if cleaned == "" {
		cleaned = "book-" + bookID
	}
	return cleaned
}

// downloadFileName 复用磁盘文件名清洗规则，但保留用户书名中的可见字符，
// 并始终追加原始扩展名。
func downloadFileName(title, extension, bookID string) string {
	base := sanitizeBookFileName(title, bookID)
	ext := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(extension), "."))
	if ext == "" {
		return base
	}
	return base + "." + ext
}

// uniqueOriginalRelPath 返回 bookID/<安全书名>.ext；目标已存在时追加
// " (2)"、" (3)"…，绝不覆盖书目录中的其他文件。
func (s *Service) uniqueOriginalRelPath(bookID, base, extension, currentRel string) (string, string, error) {
	for index := 0; index <= maxRenameSuffix; index++ {
		name := base
		if index > 0 {
			name = strings.TrimRight(truncateUTF8Bytes(base, maxStorageBaseNameBytes-len(fmt.Sprintf(" (%d)", index+1))), ". ")
			name = fmt.Sprintf("%s (%d)", name, index+1)
		}
		fileName := name + "." + extension
		rel := bookID + "/" + fileName
		if rel == currentRel {
			return rel, fileName, nil
		}
		absolute, err := s.safeJoin(rel)
		if err != nil {
			return "", "", err
		}
		if _, err := os.Lstat(absolute); errors.Is(err, os.ErrNotExist) {
			return rel, fileName, nil
		} else if err != nil {
			return "", "", err
		}
	}
	return "", "", errors.New("library: 没有可用的重命名目标")
}

func truncateUTF8Bytes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(value) <= limit {
		return value
	}
	truncated := value[:limit]
	for len(truncated) > 0 && !utf8.ValidString(truncated) {
		truncated = truncated[:len(truncated)-1]
	}
	return truncated
}

func (s *Service) openStorageFile(rel string) (*os.File, os.FileInfo, error) {
	safeRel, err := safeStorageRelPath(rel)
	if err != nil {
		return nil, nil, err
	}
	root, err := os.OpenRoot(s.booksDir)
	if err != nil {
		return nil, nil, err
	}
	defer root.Close()
	file, err := root.Open(filepath.FromSlash(safeRel))
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, nil, fmt.Errorf("library: 原件不是普通文件")
	}
	return file, info, nil
}

// safeStorageRelPath 只接受 books 根内的相对路径；拒绝绝对路径、反斜杠、
// 空段、"." 与 ".."，避免数据库中的异常路径越界。
func safeStorageRelPath(rel string) (string, error) {
	if rel == "" || strings.ContainsRune(rel, 0) || strings.Contains(rel, `\`) || path.IsAbs(rel) {
		return "", errUnsafeStoragePath
	}
	for _, segment := range strings.Split(rel, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", errUnsafeStoragePath
		}
	}
	cleaned := path.Clean(rel)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", errUnsafeStoragePath
	}
	return cleaned, nil
}
