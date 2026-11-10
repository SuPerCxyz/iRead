package comic

import (
	"sort"
	"strings"
)

// sortPages 按自然顺序排列归档路径：连续数字按数值比较，其余忽略大小写；
// 数值相同（如前导零）时用原始字符串保证稳定顺序。规则与 formats/jobs 的
// 漫画排序保持一致。
func sortPages(pages []indexedPage) {
	sort.SliceStable(pages, func(first, second int) bool {
		return naturalLess(pages[first].path, pages[second].path)
	})
}

// naturalLess 与 internal/formats/natural.go 的规则一致。
func naturalLess(a, b string) bool {
	ia, ib := 0, 0
	for ia < len(a) && ib < len(b) {
		ca, cb := a[ia], b[ib]
		if isASCIIDigit(ca) && isASCIIDigit(cb) {
			ea := ia
			for ea < len(a) && isASCIIDigit(a[ea]) {
				ea++
			}
			eb := ib
			for eb < len(b) && isASCIIDigit(b[eb]) {
				eb++
			}
			na := trimLeadingZeros(a[ia:ea])
			nb := trimLeadingZeros(b[ib:eb])
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			if (ea - ia) != (eb - ib) {
				return (ea - ia) < (eb - ib)
			}
			ia, ib = ea, eb
			continue
		}
		la, lb := asciiLower(ca), asciiLower(cb)
		if la != lb {
			return la < lb
		}
		ia++
		ib++
	}
	if ia != len(a) || ib != len(b) {
		return len(a)-ia < len(b)-ib
	}
	return a < b
}

func isASCIIDigit(b byte) bool { return b >= '0' && b <= '9' }

func asciiLower(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}

func trimLeadingZeros(s string) string {
	trimmed := strings.TrimLeft(s, "0")
	if trimmed == "" {
		return "0"
	}
	return trimmed
}
