package formats

// validateCBR 只确认原件在大小预算内；RAR4/RAR5 签名匹配由 Validate 的
// sniffFormat 完成，这里不再读文件。返回 Readable=true、PageCount=0 表示
// “封装头有效、允许保存并交给后续索引”，不代表已完成深度校验：
// 页数、加密、多卷与损坏内容由 C6 漫画 manifest/索引层真实解析后再给出
// 结果，本层不调用任何 RAR 解压器，也不宣称内容可解码。
func validateCBR(size int64) (Result, error) {
	if size <= 0 {
		return rejection(ReasonEmptyFile, nil)
	}
	if size > MaxFileSize {
		return Result{}, ErrFileTooLarge
	}
	return Result{
		Format:            FormatCBR,
		MediaType:         MediaTypeCBR,
		PageCount:         0,
		Authors:           []string{},
		Readable:          true,
		UnsupportedReason: "",
	}, nil
}
