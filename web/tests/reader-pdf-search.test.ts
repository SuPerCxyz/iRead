import { describe, expect, it } from "vitest"
import { findPdfPageMatches } from "../src/features/reader/pdf/search-model"
describe("PDF 逐命中搜索与文字层映射", () => {
  it("跨多个text item且同页多命中，每项身份及片段不同", () => {
    const hits = findPdfPageMatches([{ str: "al" }, { str: "pha beta alpha" }, { str: " beta" }], "alpha beta", 2)
    expect(hits).toHaveLength(2)
    expect(hits[0].segments).toEqual([{ itemIndex: 0, start: 0, end: 2 }, { itemIndex: 1, start: 0, end: 8 }])
    expect(hits[1].segments).toEqual([{ itemIndex: 1, start: 9, end: 14 }, { itemIndex: 2, start: 0, end: 5 }])
    expect(hits[0].page).toBe(2)
  })
  it("兼容大小写/全宽/连字/重音/空白，并映射回原始偏移", () => {
    const hits = findPdfPageMatches([{ str: "ＡＢＣ ﬁ café  word", hasEOL: true }, { str: "wrap" }], "abc fi cafe word wrap", 1)
    expect(hits).toHaveLength(1); expect(hits[0].segments).toEqual([{ itemIndex: 0, start: 0, end: 16 }, { itemIndex: 1, start: 0, end: 4 }])
  })
  it("行末断词与中文换行按整页归一化；空查询和上限有效", () => {
    expect(findPdfPageMatches([{ str: "read-", hasEOL: true }, { str: "er" }], "reader", 1)).toHaveLength(1)
    expect(findPdfPageMatches([{ str: "中文", hasEOL: true }, { str: "正文" }], "中文正文", 1)).toHaveLength(1)
    expect(findPdfPageMatches([{ str: "a a a" }], "a", 1, 2)).toHaveLength(2)
    expect(findPdfPageMatches([{ str: "a" }], "  ", 1)).toEqual([])
  })
})
