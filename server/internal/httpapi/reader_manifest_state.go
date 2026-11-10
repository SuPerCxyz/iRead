package httpapi

import (
	"context"
	"errors"
	"net/http"

	"iread/server/internal/reader/comic"
	"iread/server/internal/reader/epub"
)

// readerReadState 是 EPUB/CBZ/CBR 的 manifest 可读状态，语义与 PDF 对齐。
//
// 状态契约与 PDF 对齐：
//   - ready 且元数据未被标记 unsupported：200，canRead=true；
//   - 索引中/尚未就绪：200，canRead=false、reason=not_ready；
//   - status=error（CBR 除外）或未就绪时元数据失败：409 book_not_readable、reason=index_failed；
//   - unsupported/永久不可读：409 book_not_readable，原因由格式决定。
//
// CBR 的 unsupported/error 只表示上传期或索引期未得到结论，C6 漫画 manifest
// 会做真实 RAR4/RAR5 解析，因此不能仅凭登记状态拒绝；解析错误由漫画 handler
// 映射为真实 reason。CBR 的 error 仍需保留“索引失败”语义：若 C6 解析成功或
// 返回未知错误，最终回退 index_failed。
type readerReadState struct {
	canRead    bool
	reason     string
	unreadable bool
	// probeParser 表示 books.status=error，但不能在状态层下结论，需先调用 C6
	// 解析原件提取真实原因；解析成功或未知错误时仍以 index_failed 结束。
	probeParser bool
}

func readerReadStateFor(format, status, extractionStatus string) readerReadState {
	// 没有状态信息的直接 handler 调用（如独立测试/自定义 resolver）保持原有
	// 解析行为；生产 StoreResolver 始终提供 books.status。
	if status == "" {
		return readerReadState{canRead: true}
	}
	if status == "error" {
		if format == comic.FormatCBR {
			return readerReadState{probeParser: true}
		}
		return readerReadState{reason: "index_failed", unreadable: true}
	}
	if status == "unsupported" {
		return formatUnreadableState(format)
	}
	if status == "ready" && extractionStatus != "unsupported" {
		return readerReadState{canRead: true}
	}
	switch extractionStatus {
	case "failed":
		return readerReadState{reason: "index_failed", unreadable: true}
	case "unsupported":
		return formatUnreadableState(format)
	}
	return readerReadState{reason: "not_ready"}
}

// formatUnreadableState 给出格式级的永久不可读原因。CBR 的 unsupported 只表示
// 上传期格式校验暂不解析，仍需交给漫画解析器给出真实结果。
func formatUnreadableState(format string) readerReadState {
	switch format {
	case epub.FormatEPUB:
		return readerReadState{reason: "drm_protected", unreadable: true}
	case comic.FormatCBZ:
		return readerReadState{reason: "unsupported_archive", unreadable: true}
	case comic.FormatCBR:
		return readerReadState{canRead: true}
	default:
		return readerReadState{reason: "unsupported_format", unreadable: true}
	}
}

// comicManifestErrorMapped 报告 C6 错误是否已有稳定的对外映射。只有映射内的
// 错误可以覆盖 index_failed；未知错误仍按索引失败收敛，避免把内部错误或
// 解析成功的失败书籍误报为具体归档问题。新增漫画错误映射时需同步此函数。
func comicManifestErrorMapped(err error) bool {
	switch {
	case errors.Is(err, ErrComicBookNotFound), errors.Is(err, comic.ErrBookNotFound),
		errors.Is(err, comic.ErrParserTimeout), errors.Is(err, context.DeadlineExceeded),
		errors.Is(err, comic.ErrUnsupportedFormat),
		errors.Is(err, comic.ErrUnsupportedArchive), errors.Is(err, comic.ErrEncryptedArchive),
		errors.Is(err, comic.ErrUnsafeArchive), errors.Is(err, comic.ErrArchiveLimit),
		errors.Is(err, comic.ErrInvalidArchive),
		errors.Is(err, comic.ErrStorageUnavailable),
		errors.Is(err, ErrComicManifestPersist):
		return true
	default:
		return false
	}
}

func writeReaderUnreadable(w http.ResponseWriter, r *http.Request, state readerReadState) {
	message := "该书索引失败，无法打开"
	switch state.reason {
	case "drm_protected":
		message = "该书受加密保护，不能打开"
	case "unsupported_archive":
		message = "该书归档格式暂不受支持，无法打开"
	}
	writeReaderManifestError(w, r, http.StatusConflict, "book_not_readable",
		message, map[string]string{"reason": state.reason})
}
