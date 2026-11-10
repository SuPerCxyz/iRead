import {
  progressPercentForPage,
  type PdfPageLocatorPayload,
  type PdfRelativeViewport,
  type PdfViewState,
  type ReaderLocation,
  type ReaderManifest,
} from "../types"

export const PDF_LAYOUT_MODES = ["single", "continuous", "horizontal"] as const
export type PdfLayoutMode = (typeof PDF_LAYOUT_MODES)[number]

export const PDF_ZOOM_MODES = ["fit-width", "fit-page", "manual"] as const
export type PdfZoomMode = (typeof PDF_ZOOM_MODES)[number]

export const PDF_GAP_MODES = ["compact", "standard", "relaxed"] as const
export type PdfGapMode = (typeof PDF_GAP_MODES)[number]

export const PDF_BACKGROUND_MODES = [
  "inherit",
  "paper",
  "white",
  "gray",
  "midnight",
] as const
export type PdfBackgroundMode = (typeof PDF_BACKGROUND_MODES)[number]

export const PDF_MIN_SCALE = 0.25
export const PDF_MAX_SCALE = 4
export const PDF_DEFAULT_MANUAL_SCALE = 1

export interface PdfViewSettings {
  layoutMode: PdfLayoutMode
  zoomMode: PdfZoomMode
  manualScale: number
  gap: PdfGapMode
  background: PdfBackgroundMode
  toolbarVisible: boolean
}

export const DEFAULT_PDF_VIEW: PdfViewSettings = {
  layoutMode: "single",
  zoomMode: "fit-width",
  manualScale: PDF_DEFAULT_MANUAL_SCALE,
  gap: "standard",
  background: "inherit",
  toolbarVisible: true,
}

export interface PdfAnchor {
  page: number
  pageOffset: number
}

export const PDF_GAP_PIXELS: Record<PdfGapMode, number> = {
  compact: 4,
  standard: 12,
  relaxed: 24,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function includes<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function normalizeScale(value: number): number {
  if (!Number.isFinite(value)) {
    return PDF_DEFAULT_MANUAL_SCALE
  }
  return clamp(value, PDF_MIN_SCALE, PDF_MAX_SCALE)
}

export function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  const normalized = ((Math.round(value / 90) * 90) % 360 + 360) % 360
  return normalized
}

export function normalizeView(value: Partial<PdfViewSettings> | null): PdfViewSettings {
  return {
    layoutMode:
      value !== null && includes(PDF_LAYOUT_MODES, value.layoutMode)
        ? value.layoutMode
        : DEFAULT_PDF_VIEW.layoutMode,
    zoomMode:
      value !== null && includes(PDF_ZOOM_MODES, value.zoomMode)
        ? value.zoomMode
        : DEFAULT_PDF_VIEW.zoomMode,
    manualScale:
      value !== null && typeof value.manualScale === "number"
        ? normalizeScale(value.manualScale)
        : PDF_DEFAULT_MANUAL_SCALE,
    gap:
      value !== null && includes(PDF_GAP_MODES, value.gap)
        ? value.gap
        : DEFAULT_PDF_VIEW.gap,
    background:
      value !== null && includes(PDF_BACKGROUND_MODES, value.background)
        ? value.background
        : DEFAULT_PDF_VIEW.background,
    toolbarVisible:
      value !== null && typeof value.toolbarVisible === "boolean"
        ? value.toolbarVisible
        : DEFAULT_PDF_VIEW.toolbarVisible,
  }
}

export function viewFromEffectiveSettings(
  value: unknown,
): Partial<PdfViewSettings> | null {
  if (!isRecord(value)) {
    return null
  }
  const direct = isRecord(value.pdf) ? value.pdf : value
  const result: Partial<PdfViewSettings> = {}
  if (includes(PDF_LAYOUT_MODES, direct.layoutMode)) {
    result.layoutMode = direct.layoutMode
  }
  if (includes(PDF_ZOOM_MODES, direct.zoomMode)) {
    result.zoomMode = direct.zoomMode
  }
  if (typeof direct.manualScale === "number") {
    result.manualScale = normalizeScale(direct.manualScale)
  }
  if (includes(PDF_GAP_MODES, direct.gap)) {
    result.gap = direct.gap
  }
  if (includes(PDF_BACKGROUND_MODES, direct.background)) {
    result.background = direct.background
  }
  if (typeof direct.toolbarVisible === "boolean") {
    result.toolbarVisible = direct.toolbarVisible
  }
  return Object.keys(result).length === 0 ? null : result
}

export function pdfViewState(view: PdfViewSettings): PdfViewState {
  return {
    layoutMode: view.layoutMode,
    zoomMode: view.zoomMode,
    manualScale: view.manualScale,
  }
}

export function viewFromPdfViewState(
  value: PdfViewState | null,
): Partial<PdfViewSettings> | null {
  if (value === null) {
    return null
  }
  const result: Partial<PdfViewSettings> = {}
  if (includes(PDF_LAYOUT_MODES, value.layoutMode)) {
    result.layoutMode = value.layoutMode
  }
  if (includes(PDF_ZOOM_MODES, value.zoomMode)) {
    result.zoomMode = value.zoomMode
  }
  if (value.manualScale !== null) {
    result.manualScale = normalizeScale(value.manualScale)
  }
  return Object.keys(result).length === 0 ? null : result
}

export function relativeViewport(
  pageLeft: number,
  pageTop: number,
  pageWidth: number,
  pageHeight: number,
  scrollLeft: number,
  scrollTop: number,
  viewportWidth: number,
  viewportHeight: number,
): PdfRelativeViewport | null {
  if (pageWidth <= 0 || pageHeight <= 0) {
    return null
  }
  const visibleLeft = Math.max(pageLeft, scrollLeft)
  const visibleTop = Math.max(pageTop, scrollTop)
  const visibleRight = Math.min(
    pageLeft + pageWidth,
    scrollLeft + viewportWidth,
  )
  const visibleBottom = Math.min(
    pageTop + pageHeight,
    scrollTop + viewportHeight,
  )
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
    return null
  }
  return {
    x: clamp((visibleLeft - pageLeft) / pageWidth, 0, 1),
    y: clamp((visibleTop - pageTop) / pageHeight, 0, 1),
    width: clamp((visibleRight - visibleLeft) / pageWidth, 0, 1),
    height: clamp((visibleBottom - visibleTop) / pageHeight, 0, 1),
  }
}

export function pdfLocation(
  page: number,
  pageOffset: number,
  pageCount: number,
  relative: PdfRelativeViewport | null,
  view: PdfViewSettings,
): ReaderLocation {
  const total = Math.max(1, pageCount)
  const targetPage = clamp(Math.floor(page), 1, total)
  const payload: PdfPageLocatorPayload = {
    locatorVersion: 1,
    page: targetPage,
    pageOffset: clamp(pageOffset, 0, 1),
    relativeViewport: relative,
    view: pdfViewState(view),
  }
  return {
    locatorType: "pdf-page",
    locatorPayload: payload,
    progressPercent: progressPercentForPage(targetPage, total),
  }
}

export function isPdfManifest(
  manifest: ReaderManifest,
): manifest is Extract<ReaderManifest, { format: "pdf" }> {
  return manifest.format === "pdf"
}

export function pdfContentPath(manifest: ReaderManifest): string | null {
  if (!isPdfManifest(manifest)) {
    return null
  }
  const href = manifest.formatData.contentHref
  return href.length > 0 ? href : null
}
