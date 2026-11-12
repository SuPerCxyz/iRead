import { describe, expect, it } from "vitest"

import {
  CanvasPixelBudget,
  DESKTOP_CANVAS_PIXEL_BUDGET,
  MOBILE_CANVAS_PIXEL_BUDGET,
} from "../src/features/reader/pdf/canvas-budget"
import {
  PDF_DESKTOP_PREFETCH,
  PDF_MOBILE_PREFETCH,
  computePdfRenderWindow,
} from "../src/features/reader/pdf/render-window"

describe("PDF 渲染窗口", () => {
  it("桌面窗口为可见页 + 前向 6 + 后向 2", () => {
    const window = computePdfRenderWindow({
      visible: [10, 11],
      pageCount: 100,
      coarse: false,
    })
    expect(window.visible).toEqual([10, 11])
    expect(window.prefetch).toEqual([12, 9, 13, 8, 14, 15, 16, 17])
    expect(window.retain).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(PDF_DESKTOP_PREFETCH).toEqual({ before: 2, after: 6 })
  })

  it("移动窗口为可见页 + 前向 4 + 后向 1", () => {
    const window = computePdfRenderWindow({
      visible: [10, 11],
      pageCount: 100,
      coarse: true,
    })
    expect(window.prefetch).toEqual([12, 9, 13, 14, 15])
    expect(window.retain).toEqual([9, 10, 11, 12, 13, 14, 15])
    expect(PDF_MOBILE_PREFETCH).toEqual({ before: 1, after: 4 })
  })

  it("窗口在首尾页截断，并去重、排序、丢弃越界页", () => {
    const first = computePdfRenderWindow({
      visible: [0, 1, 2],
      pageCount: 5,
      coarse: false,
    })
    expect(first.visible).toEqual([1, 2])
    expect(first.prefetch).toEqual([3, 4, 5])
    expect(first.retain).toEqual([1, 2, 3, 4, 5])

    const last = computePdfRenderWindow({
      visible: [5, 4, 5],
      pageCount: 5,
      coarse: true,
    })
    expect(last.visible).toEqual([4, 5])
    expect(last.prefetch).toEqual([3])
    expect(last.retain).toEqual([3, 4, 5])
  })

  it("反向/乱序可见页仍按页序输出，反向预取距离优先", () => {
    const window = computePdfRenderWindow({
      visible: [12, 10],
      pageCount: 20,
      coarse: false,
    })
    expect(window.visible).toEqual([10, 12])
    expect(window.prefetch).toEqual([11, 13, 9, 14, 8, 15, 16, 17, 18])
    expect(window.retain).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ])
  })

  it("空可见页或空文档返回空窗口", () => {
    expect(
      computePdfRenderWindow({ visible: [], pageCount: 10, coarse: false }),
    ).toEqual({ visible: [], prefetch: [], retain: [] })
    expect(
      computePdfRenderWindow({ visible: [1], pageCount: 0, coarse: false }),
    ).toEqual({ visible: [], prefetch: [], retain: [] })
    expect(
      computePdfRenderWindow({
        visible: [Number.NaN, Number.POSITIVE_INFINITY],
        pageCount: 10,
        coarse: false,
      }),
    ).toEqual({ visible: [], prefetch: [], retain: [] })
  })

  it("支持自定义预取窗口且不产生重复页", () => {
    const window = computePdfRenderWindow(
      { visible: [1, 2], pageCount: 6, coarse: false },
      { before: 0, after: 7 },
    )
    expect(window.prefetch).toEqual([3, 4, 5, 6])
    expect(new Set(window.retain).size).toBe(window.retain.length)
  })
})

describe("PDF canvas 像素预算", () => {
  it("按 lastUsed 淘汰最旧页，直到回到预算内", () => {
    const budget = new CanvasPixelBudget(20)
    budget.touch(1, 10)
    budget.touch(2, 10)
    expect(budget.totalPixels).toBe(20)
    expect(budget.evict()).toEqual([])

    budget.touch(3, 10)
    expect(budget.totalPixels).toBe(30)
    expect(budget.evict()).toEqual([1])
    expect(budget.totalPixels).toBe(20)
    expect(budget.snapshot().map((entry) => entry.pageNumber)).toEqual([2, 3])
  })

  it("绝不淘汰 protectedPages 中的 visible 页", () => {
    const budget = new CanvasPixelBudget(10)
    budget.touch(1, 10)
    budget.touch(2, 10)
    budget.touch(3, 10)
    // page 1 最旧但可见，只能淘汰 2、3；仍超预算时停止继续淘汰。
    expect(budget.evict(new Set([1]))).toEqual([2, 3])
    expect(budget.totalPixels).toBe(10)
    expect(budget.has(1)).toBe(true)
    expect(budget.evict([1])).toEqual([])
    expect(budget.snapshot().map((entry) => entry.pageNumber)).toEqual([1])
  })

  it("重复 touch 更新像素而不是重复计数", () => {
    const budget = new CanvasPixelBudget(100)
    budget.touch(1, 30)
    budget.touch(1, 40)
    expect(budget.totalPixels).toBe(40)
    expect(budget.size).toBe(1)
  })

  it("setMaxPixels 调低后可按需淘汰，remove/clear 正确记账", () => {
    const budget = new CanvasPixelBudget(100)
    budget.touch(1, 25)
    budget.touch(2, 25)
    budget.setMaxPixels(MOBILE_CANVAS_PIXEL_BUDGET)
    expect(budget.evict()).toEqual([])
    budget.setMaxPixels(24)
    budget.touch(3, 25)
    expect(budget.evict()).toEqual([1, 2, 3])
    budget.remove(3)
    expect(budget.totalPixels).toBe(0)
    budget.touch(4, 25)
    budget.clear()
    expect(budget.totalPixels).toBe(0)
    expect(budget.size).toBe(0)
  })

  it("导出的设备预算符合约定值", () => {
    expect(DESKTOP_CANVAS_PIXEL_BUDGET).toBe(40_000_000)
    expect(MOBILE_CANVAS_PIXEL_BUDGET).toBe(12_000_000)
  })
})
