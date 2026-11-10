package jobs

import (
	"archive/zip"
	"context"
	"errors"
	"sort"
	"strings"

	"iread/server/internal/formats"
	"iread/server/internal/store"
)

func extractCBZ(ctx context.Context, filePath, displayTitle string, report phaseReporter) (extraction, error) {
	if err := statBookFile(filePath); err != nil {
		return extraction{}, err
	}
	archive, err := zip.OpenReader(filePath)
	if err != nil {
		return extraction{}, invalidBookFile(err)
	}
	defer archive.Close()
	if len(archive.File) > formats.MaxArchiveEntries {
		return extraction{}, invalidBookFile(errors.New("CBZ 条目过多"))
	}
	images := make([]*zip.File, 0, len(archive.File))
	for _, file := range archive.File {
		if file.FileInfo().IsDir() || !isComicImageName(file.Name) {
			continue
		}
		images = append(images, file)
	}
	if len(images) == 0 {
		return extraction{}, invalidBookFile(errors.New("CBZ 中没有可用图片"))
	}
	sort.SliceStable(images, func(first, second int) bool {
		return naturalLess(images[first].Name, images[second].Name)
	})

	result := extraction{
		Authors:       []string{},
		TOC:           []store.BookTOCEntry{},
		CoverExpected: true,
	}
	title := strings.TrimSpace(displayTitle)
	if title != "" {
		result.Title = &title
	}
	pageCount := int64(len(images))
	result.PageCount = &pageCount

	if err := report("toc", 1); err != nil {
		return extraction{}, err
	}
	if err := report("cover", 2); err != nil {
		return extraction{}, err
	}
	cover, err := readZipFile(ctx, images[0], maxCoverBytes)
	if err != nil {
		if contextDone(ctx, err) {
			return extraction{}, err
		}
		// 首图损坏时仍保留页数与原件，跳过封面并标记 partial。
		result.Partial = true
	} else {
		result.Cover = cover
	}
	return result, nil
}

func isComicImageName(name string) bool {
	normalized := strings.ReplaceAll(name, `\`, "/")
	base := pathBase(normalized)
	if strings.HasPrefix(base, "._") || strings.HasPrefix(normalized, "__MACOSX/") || strings.Contains(normalized, "/__MACOSX/") {
		return false
	}
	switch strings.ToLower(pathExt(base)) {
	case ".jpg", ".jpeg", ".png", ".gif":
		return true
	default:
		return false
	}
}

func pathBase(value string) string {
	if index := strings.LastIndexByte(value, '/'); index >= 0 {
		return value[index+1:]
	}
	return value
}

func pathExt(value string) string {
	if index := strings.LastIndexByte(value, '.'); index >= 0 {
		return value[index:]
	}
	return ""
}

// naturalLess 与 formats 的内部规则一致：连续数字按数值比较，其余忽略大小写；
// 数值相同时用原始字符串与前导零长度保证稳定顺序。
func naturalLess(first, second string) bool {
	indexFirst, indexSecond := 0, 0
	for indexFirst < len(first) && indexSecond < len(second) {
		charFirst, charSecond := first[indexFirst], second[indexSecond]
		if isDigit(charFirst) && isDigit(charSecond) {
			endFirst := indexFirst
			for endFirst < len(first) && isDigit(first[endFirst]) {
				endFirst++
			}
			endSecond := indexSecond
			for endSecond < len(second) && isDigit(second[endSecond]) {
				endSecond++
			}
			numberFirst := trimZeros(first[indexFirst:endFirst])
			numberSecond := trimZeros(second[indexSecond:endSecond])
			if len(numberFirst) != len(numberSecond) {
				return len(numberFirst) < len(numberSecond)
			}
			if numberFirst != numberSecond {
				return numberFirst < numberSecond
			}
			if (endFirst - indexFirst) != (endSecond - indexSecond) {
				return (endFirst - indexFirst) < (endSecond - indexSecond)
			}
			indexFirst, indexSecond = endFirst, endSecond
			continue
		}
		lowerFirst, lowerSecond := lowerASCII(charFirst), lowerASCII(charSecond)
		if lowerFirst != lowerSecond {
			return lowerFirst < lowerSecond
		}
		indexFirst++
		indexSecond++
	}
	if indexFirst != len(first) || indexSecond != len(second) {
		return len(first)-indexFirst < len(second)-indexSecond
	}
	return first < second
}

func isDigit(value byte) bool { return value >= '0' && value <= '9' }

func lowerASCII(value byte) byte {
	if value >= 'A' && value <= 'Z' {
		return value + ('a' - 'A')
	}
	return value
}

func trimZeros(value string) string {
	trimmed := strings.TrimLeft(value, "0")
	if trimmed == "" {
		return "0"
	}
	return trimmed
}
