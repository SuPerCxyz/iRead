import { describe, expect, it } from "vitest"

import {
  chapterProgressFromFractions,
  relocateProgressFraction,
  type RelocateFractionState,
} from "../src/features/reader/epub/location"

const fractions = [0, 0.4, 0.9729, 1]

function relocate(
  overrides: Partial<RelocateFractionState> = {},
): number | null {
  return relocateProgressFraction({
    index: 1,
    fraction: 0.9729,
    sectionFractions: fractions,
    scrolled: false,
    page: 2,
    pages: 4,
    atEnd: false,
    ...overrides,
  })
}

describe("EPUB 重排后的可见位置 fraction", () => {
  it("同一段落首屏在字号重排前后保持相同章节进度", () => {
    // 重排前 2 个内容页，第 2 页起点 = 0.5；重排后 6 个内容页，第 4 页起点仍 = 0.5。
    const before = relocate({ page: 2, pages: 4, fraction: 0.9729 })
    const after = relocate({ page: 4, pages: 8, fraction: 0.7851 })
    expect(before).toBeCloseTo(0.68645)
    expect(after).toBeCloseTo(before as number)
    expect(chapterProgressFromFractions(1, before as number, fractions)).toBeCloseTo(0.5)
    expect(chapterProgressFromFractions(1, after as number, fractions)).toBeCloseTo(0.5)
  })

  it("末页按页起点计算，全书末页仍显示 100%", () => {
    // foliate 的 detail.fraction 是页尾（约 1.0）；不能把章节末页当成章节 100%。
    const lastPage = relocate({ page: 2, pages: 4, fraction: 0.9729 })
    expect(lastPage).not.toBeCloseTo(1)
    expect(chapterProgressFromFractions(1, lastPage as number, fractions)).toBeCloseTo(0.5)
    // 全书最后一页（atEnd）保持既有语义：读到结尾就是 100%。
    expect(relocate({ page: 2, pages: 4, atEnd: true })).toBe(1)
  })

  it("滚动模式使用起点 fraction，异常分页信息回退", () => {
    expect(relocate({ scrolled: true, fraction: 0.25 })).toBe(0.25)
    expect(relocate({ page: 1, pages: 2 })).toBeNull()
    expect(relocate({ sectionFractions: [0], page: 1, pages: 4 })).toBeNull()
    expect(relocate({ page: Number.NaN, pages: 4 })).toBeNull()
  })
})
