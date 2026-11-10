package formats

import "strings"

// naturalLess 按目录/漫画页常见自然顺序比较：连续数字按数值比较，其余按忽略
// 大小写的字典序；数值相同（如前导零）时再用原始字符串保证稳定排序。
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
