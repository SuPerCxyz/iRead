import { isRecord } from "@/lib/api"

import type {
  PdfBackgroundMode,
  PdfGapMode,
  PdfLayoutMode,
  PdfViewSettings,
  PdfZoomMode,
} from "../pdf"

/**
 * PDF 设置到引擎视图的映射。Shell 只传递用户/服务端明确给出的字段，
 * 测量与 fit 比例始终由 PDF 引擎完成，避免把显示比例写回设置。
 */

const PDF_LAYOUT_MODES: readonly PdfLayoutMode[] = [
  "single",
  "continuous",
  "horizontal",
]

const PDF_ZOOM_MODES: readonly PdfZoomMode[] = [
  "fit-width",
  "fit-page",
  "manual",
]

const PDF_GAP_MODES: readonly PdfGapMode[] = [
  "compact",
  "standard",
  "relaxed",
]

const PDF_BACKGROUND_MODES: readonly PdfBackgroundMode[] = [
  "inherit",
  "paper",
  "white",
  "gray",
  "midnight",
]

const PDF_MIN_SCALE = 0.25
const PDF_MAX_SCALE = 4

function includes<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

function readPdfValue(
  source: Record<string, unknown> | undefined,
  key: string,
): unknown {
  if (source === undefined) {
    return undefined
  }
  const group = source.pdf
  if (isRecord(group) && group[key] !== undefined) {
    return group[key]
  }
  const dotted = source[`pdf.${key}`]
  return dotted === undefined ? source[key] : dotted
}

function clampScale(value: number): number {
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, value))
}

/** 从有效设置与未保存草稿中提取 PDF 视图补丁；不填充缺省值。 */
export function pdfViewPatchFromSettings(
  effective: Record<string, unknown> | undefined,
  pending: Record<string, unknown> | undefined,
): Partial<PdfViewSettings> {
  const patch: Partial<PdfViewSettings> = {}
  const read = (key: string): unknown => {
    const draft = readPdfValue(pending, key)
    return draft === undefined ? readPdfValue(effective, key) : draft
  }

  const layoutMode = read("layoutMode")
  if (includes(PDF_LAYOUT_MODES, layoutMode)) {
    patch.layoutMode = layoutMode
  }
  const zoomMode = read("zoomMode")
  if (includes(PDF_ZOOM_MODES, zoomMode)) {
    patch.zoomMode = zoomMode
  }
  const manualScale = read("manualScale")
  if (
    typeof manualScale === "number" &&
    Number.isFinite(manualScale) &&
    manualScale > 0
  ) {
    patch.manualScale = clampScale(manualScale)
  }
  const gap = read("gap")
  if (includes(PDF_GAP_MODES, gap)) {
    patch.gap = gap
  }
  const background = read("background")
  if (includes(PDF_BACKGROUND_MODES, background)) {
    patch.background = background
  }
  const toolbarVisible = read("toolbarVisible")
  if (typeof toolbarVisible === "boolean") {
    patch.toolbarVisible = toolbarVisible
  }
  return patch
}

export function pdfSettingsPatchKey(patch: Partial<PdfViewSettings>): string {
  return JSON.stringify(patch)
}
