package httpapi

import (
	"net/http"

	"iread/server/internal/store"
)

const pdfManifestSchemaVersion = 1

// pdfManifest 是 PDF 的最小阅读清单。PDF 不生成派生页资源，客户端通过
// contentHref 直接按 Range 读取原件；pageCount 只使用已提取的元数据。
type pdfManifest struct {
	SchemaVersion       int                    `json:"schemaVersion"`
	BookID              string                 `json:"bookId"`
	FileVersion         string                 `json:"fileVersion"`
	Format              string                 `json:"format"`
	IndexVersion        int64                  `json:"indexVersion"`
	ReadingCapabilities pdfReadingCapabilities `json:"readingCapabilities"`
	TOC                 []pdfTOCItem           `json:"toc"`
	FormatData          pdfManifestFormatData  `json:"formatData"`
}

type pdfReadingCapabilities struct {
	CanRead           bool     `json:"canRead"`
	UnavailableReason string   `json:"unavailableReason"`
	Features          []string `json:"features"`
}

// pdfTOCItem 与共享 TOC 形状保持一致；当前 PDF 元数据不提取目录，始终为空。
type pdfTOCItem struct {
	Title      string       `json:"title"`
	Href       string       `json:"href"`
	ResourceID string       `json:"resourceId"`
	Fragment   string       `json:"fragment"`
	Level      int          `json:"level"`
	Children   []pdfTOCItem `json:"children"`
}

type pdfManifestFormatData struct {
	ContentHref string `json:"contentHref"`
	ByteSize    int64  `json:"byteSize"`
	ETag        string `json:"etag"`
	PageCount   int64  `json:"pageCount"`
}

// pdfReadState 是 PDF manifest 的状态判定结果。
//
// 状态契约：
//   - ready 且元数据提取状态非 unsupported：200，canRead=true；
//   - 尚未完成索引：200，canRead=false、reason=not_ready，客户端应等待任务完成
//     后重新获取，不应当作坏文件；
//   - 加密/unsupported：409 book_not_readable、reason=pdf_encrypted；
//   - 索引失败：409 book_not_readable、reason=index_failed。
//
// 索引中保留 manifest 是为了让阅读器能展示“正在整理”而不是把 409 误判为
// 文件损坏；永久不可读状态则用 409 明确失败，避免客户端继续挂载引擎。
type pdfReadState struct {
	canRead    bool
	reason     string
	unreadable bool
}

func pdfReadStateFor(detail store.BookDetail) pdfReadState {
	if detail.Status == "ready" && detail.Metadata.ExtractionStatus != "unsupported" {
		return pdfReadState{canRead: true}
	}
	// PDF 唯一可保存但不可读的格式原因是加密；不要暴露内部校验细节。
	if detail.Status == "unsupported" || detail.Metadata.ExtractionStatus == "unsupported" {
		return pdfReadState{reason: "pdf_encrypted", unreadable: true}
	}
	if detail.Status == "error" || detail.Metadata.ExtractionStatus == "failed" {
		return pdfReadState{reason: "index_failed", unreadable: true}
	}
	return pdfReadState{reason: "not_ready"}
}

func (d *ReaderDispatch) writePDFManifest(w http.ResponseWriter, r *http.Request, detail store.BookDetail) {
	state := pdfReadStateFor(detail)
	if state.unreadable {
		message := "该书索引失败，无法打开"
		if state.reason == "pdf_encrypted" {
			message = "该书受加密保护，不能打开"
		}
		writeReaderManifestError(w, r, http.StatusConflict, "book_not_readable",
			message, map[string]string{"reason": state.reason})
		return
	}

	manifest := pdfManifest{
		SchemaVersion: pdfManifestSchemaVersion,
		BookID:        detail.BookID,
		FileVersion:   detail.File.SHA256,
		Format:        detail.Format,
		IndexVersion:  detail.IndexVersion,
		ReadingCapabilities: pdfReadingCapabilities{
			CanRead:           state.canRead,
			UnavailableReason: state.reason,
			Features:          []string{"bookmarks", "settings", "text-selection"},
		},
		TOC: []pdfTOCItem{},
		FormatData: pdfManifestFormatData{
			ContentHref: "/api/v1/books/" + detail.BookID + "/versions/" +
				detail.File.SHA256 + "/content",
			ByteSize:  detail.File.ByteSize,
			ETag:      `"` + detail.File.SHA256 + `"`,
			PageCount: pdfPageCount(detail),
		},
	}
	writeReaderManifestJSON(w, http.StatusOK, struct {
		Data pdfManifest `json:"data"`
	}{Data: manifest})
}

func pdfPageCount(detail store.BookDetail) int64 {
	if detail.Metadata.PageCount == nil || *detail.Metadata.PageCount <= 0 {
		return 0
	}
	return *detail.Metadata.PageCount
}
