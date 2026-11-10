import {
  COMIC_DIRECTIONS,
  COMIC_FITS,
  COMIC_MODES,
  type ComicPage,
  type ComicPageLocatorPayload,
  type ReaderLocation,
} from "../types"

import {
  COMIC_MAX_ORIGINAL_BYTES,
  COMIC_MAX_ORIGINAL_PIXELS,
  type ComicReaderSettings,
} from "./types"

export function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) {
    return 1
  }
  const total = Math.max(1, Math.floor(pageCount))
  return Math.min(total, Math.max(1, Math.floor(page)))
}

export function progressPercent(page: number, pageCount: number): number {
  if (!Number.isFinite(page) || page < 1) {
    return 0
  }
  const total = Math.max(1, Math.floor(pageCount))
  const normalized = Math.min(total, Math.max(1, Math.floor(page)))
  if (pageCount <= 1 || normalized >= total) {
    return 100
  }
  return ((normalized - 1) / Math.max(1, total - 1)) * 100
}

/**
 * 双页配对：第 1 页是封面单页；LTR 的逻辑页序为 (2,3)(4,5)…；
 * 奇数页落在前一对的后半，末页（含最后一对不完整时）单独显示。
 */
export function spreadForPage(page: number, pageCount: number): number[] {
  const total = Math.max(1, Math.floor(pageCount))
  const normalized = clampPage(page, total)
  if (normalized <= 1) {
    return [1]
  }
  const start = normalized % 2 === 0 ? normalized : normalized - 1
  const end = Math.min(total, start + 1)
  return start === end ? [start] : [start, end]
}

/** 视觉顺序：RTL 时同一跨页内的左右顺序反转，逻辑页号不变。 */
export function visualSpread(
  page: number,
  pageCount: number,
  direction: ComicReaderSettings["direction"],
): number[] {
  const pages = spreadForPage(page, pageCount)
  return direction === "rtl" ? [...pages].reverse() : pages
}

export function visiblePages(
  page: number,
  pageCount: number,
  mode: ComicReaderSettings["mode"],
  direction: ComicReaderSettings["direction"],
): number[] {
  if (mode === "single") {
    return [clampPage(page, pageCount)]
  }
  if (mode === "double") {
    return visualSpread(page, pageCount, direction)
  }
  return [clampPage(page, pageCount)]
}

export function adjacentPage(
  page: number,
  pageCount: number,
  mode: ComicReaderSettings["mode"],
  step: 1 | -1,
): number {
  const total = Math.max(1, Math.floor(pageCount))
  if (mode !== "double") {
    return clampPage(page + step, total)
  }
  const pages = spreadForPage(page, total)
  const start = pages[0] ?? 1
  // 封面是单页，下一页应从第 2 页开始，而不是跳过 (2,3)。
  if (step > 0 && clampPage(page, total) === 1) {
    return clampPage(2, total)
  }
  return clampPage(start + step * 2, total)
}

/** 预取候选：移动端 2 页，桌面 3–4 页；始终包含当前跨页的可见页。 */
export function preloadCandidates(
  page: number,
  pageCount: number,
  settings: ComicReaderSettings,
  desktop: boolean,
): number[] {
  const total = Math.max(1, Math.floor(pageCount))
  const base = new Set(visiblePages(page, total, settings.mode, settings.direction))
  base.add(clampPage(page, total))
  const limit = desktop ? 4 : 2
  const result: number[] = [...base].sort((a, b) => a - b)
  let cursor = Math.max(...result) + 1
  while (result.length < limit && cursor <= total) {
    result.push(cursor)
    cursor += 1
  }
  cursor = Math.min(...result) - 1
  while (result.length < limit && cursor >= 1) {
    result.push(cursor)
    cursor -= 1
  }
  return [...new Set(result)].sort((a, b) => a - b)
}

export function originalAvailable(page: ComicPage | null): boolean {
  if (page === null) {
    return false
  }
  if (!page.availableVariants.includes("original")) {
    return false
  }
  if (page.size <= 0 || page.size > COMIC_MAX_ORIGINAL_BYTES) {
    return false
  }
  const pixels = page.width * page.height
  return (
    Number.isFinite(pixels) &&
    pixels > 0 &&
    pixels <= COMIC_MAX_ORIGINAL_PIXELS
  )
}

export interface ComicBox {
  width: number
  height: number
  scale: number
}

/**
 * 按当前模式与 fit 计算显示像素尺寸。
 *
 * screen：同时受视口宽高约束；double 时每页最多占半宽减页距。
 * width：只受宽度约束，页面可高于视口。
 * original：使用清单中的原始像素尺寸。
 */
export function computeComicBox(
  page: ComicPage,
  settings: ComicReaderSettings,
  viewportWidth: number,
  viewportHeight: number,
  gapPixels: number,
): ComicBox {
  const naturalWidth = Math.max(1, page.width)
  const naturalHeight = Math.max(1, page.height)
  const availableWidth =
    settings.mode === "double"
      ? Math.max(1, (Math.max(1, viewportWidth) - gapPixels) / 2)
      : Math.max(1, viewportWidth)
  const availableHeight = Math.max(1, viewportHeight)
  let scale = 1
  if (settings.fit === "screen") {
    scale = Math.min(
      availableWidth / naturalWidth,
      availableHeight / naturalHeight,
    )
  } else if (settings.fit === "width") {
    scale = availableWidth / naturalWidth
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    scale = 1
  }
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
    scale,
  }
}

export function comicLocation(
  page: number,
  pageCount: number,
  settings: ComicReaderSettings,
): ReaderLocation {
  const total = Math.max(1, Math.floor(pageCount))
  const normalized = clampPage(page, total)
  const payload: ComicPageLocatorPayload = {
    locatorVersion: 1,
    page: normalized,
    pageOffset: 0,
    direction: settings.direction,
    mode: settings.mode,
    fit: settings.fit,
  }
  return {
    locatorType: "comic-page",
    locatorPayload: payload,
    progressPercent: progressPercent(normalized, total),
  }
}

export function isComicDirection(
  value: unknown,
): value is ComicReaderSettings["direction"] {
  return (
    typeof value === "string" &&
    (COMIC_DIRECTIONS as readonly string[]).includes(value)
  )
}

export function isComicMode(
  value: unknown,
): value is ComicReaderSettings["mode"] {
  return (
    typeof value === "string" &&
    (COMIC_MODES as readonly string[]).includes(value)
  )
}

export function isComicFit(
  value: unknown,
): value is ComicReaderSettings["fit"] {
  return (
    typeof value === "string" &&
    (COMIC_FITS as readonly string[]).includes(value)
  )
}
