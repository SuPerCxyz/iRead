import { describe, expect, it } from "vitest"

import type { ComicPage } from "../types"

import {
  adjacentPage,
  comicLocation,
  computeComicBox,
  originalAvailable,
  preloadCandidates,
  progressPercent,
  spreadForPage,
  visualSpread,
} from "./pagination"
import {
  DEFAULT_COMIC_SETTINGS,
  normalizeComicSettings,
  type ComicReaderSettings,
} from "./types"

const SETTINGS: ComicReaderSettings = { ...DEFAULT_COMIC_SETTINGS }

function page(
  number: number,
  width = 800,
  height = 1200,
  options: Partial<ComicPage> = {},
): ComicPage {
  return {
    page: number,
    resourceId: "a".repeat(32),
    width,
    height,
    mediaType: "image/jpeg",
    size: 1000,
    availableVariants: ["screen", "original"],
    ...options,
  }
}

describe("漫画分页", () => {
  it("封面单页、LTR 双页与末页落单", () => {
    expect(spreadForPage(1, 12)).toEqual([1])
    expect(spreadForPage(2, 12)).toEqual([2, 3])
    expect(spreadForPage(3, 12)).toEqual([2, 3])
    expect(spreadForPage(10, 12)).toEqual([10, 11])
    expect(spreadForPage(12, 12)).toEqual([12])
  })

  it("RTL 只反转视觉顺序", () => {
    expect(visualSpread(2, 12, "rtl")).toEqual([3, 2])
    expect(visualSpread(1, 12, "rtl")).toEqual([1])
  })

  it("双页前后翻页按跨页步进", () => {
    expect(adjacentPage(2, 12, "double", 1)).toBe(4)
    expect(adjacentPage(1, 12, "double", 1)).toBe(2)
    expect(adjacentPage(3, 12, "double", -1)).toBe(1)
    expect(adjacentPage(3, 12, "single", 1)).toBe(4)
  })

  it("预取窗口移动 2、桌面 4，不整本", () => {
    expect(preloadCandidates(1, 100, SETTINGS, false)).toEqual([1, 2])
    expect(preloadCandidates(1, 100, SETTINGS, true)).toEqual([1, 2, 3, 4])
    expect(preloadCandidates(50, 100, SETTINGS, true)).toEqual([50, 51, 52, 53])
  })

  it("进度按页计算且最后一页 100", () => {
    expect(progressPercent(1, 12)).toBe(0)
    expect(progressPercent(12, 12)).toBe(100)
    expect(progressPercent(10, 12)).toBeCloseTo((9 / 11) * 100)
    expect(progressPercent(1, 1)).toBe(100)
  })

  it("fit screen/width/original 计算显示尺寸", () => {
    const wide = page(10, 3200, 1800)
    expect(computeComicBox(wide, SETTINGS, 1200, 820, 12)).toMatchObject({
      width: 1200,
      height: 675,
    })
    expect(
      computeComicBox(
        wide,
        { ...SETTINGS, fit: "width" },
        1200,
        820,
        12,
      ),
    ).toMatchObject({ width: 1200, height: 675 })
    expect(
      computeComicBox(
        wide,
        { ...SETTINGS, fit: "original" },
        1200,
        820,
        12,
      ),
    ).toMatchObject({ width: 3200, height: 1800 })
    expect(
      computeComicBox(
        wide,
        { ...SETTINGS, mode: "double" },
        1200,
        820,
        12,
      ).width,
    ).toBe(594)
  })

  it("original 受 64MiB 与 32M 像素限制", () => {
    expect(originalAvailable(page(10, 3200, 1800))).toBe(true)
    expect(originalAvailable(page(11, 8000, 5000))).toBe(false)
    expect(
      originalAvailable(page(10, 3200, 1800, { size: 65 << 20 })),
    ).toBe(false)
    expect(
      originalAvailable(
        page(10, 3200, 1800, { availableVariants: ["screen"] }),
      ),
    ).toBe(false)
  })

  it("locator 携带方向/模式/fit 与进度", () => {
    const location = comicLocation(10, 12, {
      ...SETTINGS,
      direction: "rtl",
      mode: "double",
      fit: "width",
    })
    expect(location.locatorType).toBe("comic-page")
    expect(location.locatorPayload).toEqual({
      locatorVersion: 1,
      page: 10,
      pageOffset: 0,
      direction: "rtl",
      mode: "double",
      fit: "width",
    })
    expect(location.progressPercent).toBeCloseTo((9 / 11) * 100)
  })

  it("无效设置不覆盖已有用户选择", () => {
    expect(
      normalizeComicSettings({
        direction: "rtl",
        mode: "double",
        fit: "width",
        gap: "relaxed",
        background: "white",
      }),
    ).toEqual({
      direction: "rtl",
      mode: "double",
      fit: "width",
      gap: "relaxed",
      background: "white",
    })
    expect(
      normalizeComicSettings({ direction: "up", mode: "triple" } as never),
    ).toEqual(DEFAULT_COMIC_SETTINGS)
  })
})
