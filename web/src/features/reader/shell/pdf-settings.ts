import { isRecord } from "@/lib/api"

import type { BookReaderOverrides, PdfViewState } from "../types"
import {
  DEFAULT_PDF_VIEW,
  normalizeView,
  viewFromEffectiveSettings,
  type PdfBackgroundMode,
  type PdfGapMode,
  type PdfLayoutMode,
  type PdfViewSettings,
  type PdfZoomMode,
} from "../pdf/model"

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
  // 服务端的 toolbarVisible 仅保留旧 JSON 兼容；前端已无 PDF 中间工具栏。
  return patch
}

export function pdfSettingsPatchKey(patch: Partial<PdfViewSettings>): string {
  return JSON.stringify(patch)
}

const PDF_VIEW_KEYS = [
  "layoutMode",
  "zoomMode",
  "manualScale",
  "gap",
  "background",
] as const satisfies readonly (keyof PdfViewSettings)[]

function patchFromPdfSource(
  source: Record<string, unknown> | undefined,
): Partial<PdfViewSettings> {
  if (source === undefined) {
    return {}
  }
  const patch: Partial<PdfViewSettings> = {}
  const layoutMode = readPdfValue(source, "layoutMode")
  if (includes(PDF_LAYOUT_MODES, layoutMode)) {
    patch.layoutMode = layoutMode
  }
  const zoomMode = readPdfValue(source, "zoomMode")
  if (includes(PDF_ZOOM_MODES, zoomMode)) {
    patch.zoomMode = zoomMode
  }
  const manualScale = readPdfValue(source, "manualScale")
  if (
    typeof manualScale === "number" &&
    Number.isFinite(manualScale) &&
    manualScale > 0
  ) {
    patch.manualScale = clampScale(manualScale)
  }
  const gap = readPdfValue(source, "gap")
  if (includes(PDF_GAP_MODES, gap)) {
    patch.gap = gap
  }
  const background = readPdfValue(source, "background")
  if (includes(PDF_BACKGROUND_MODES, background)) {
    patch.background = background
  }
  return patch
}

function readPdfSource(
  sources: Record<string, unknown> | undefined,
  key: string,
): unknown {
  if (sources === undefined) {
    return undefined
  }
  const group = sources.pdf
  if (isRecord(group) && group[key] !== undefined) {
    return group[key]
  }
  return sources[`pdf.${key}`]
}

function explicitSource(value: unknown): boolean {
  return value === "book" || value === "global"
}

/**
 * 只返回 profile 中显式的 PDF 字段：本书覆盖或全局默认。
 * built-in（例如旧版 fit-width 1.0）不能覆盖已恢复的进度视图。
 */
export function pdfExplicitPatchFromRecord(
  record: BookReaderOverrides | undefined,
): Partial<PdfViewSettings> {
  if (record === undefined) {
    return {}
  }
  const patch = patchFromPdfSource(record.overrides)
  const effective = patchFromPdfSource(record.effectiveValues)
  for (const key of PDF_VIEW_KEYS) {
    if (patch[key] !== undefined) {
      continue
    }
    if (!explicitSource(readPdfSource(record.fieldSources, key))) {
      continue
    }
    const fromEffective = effective[key]
    if (fromEffective !== undefined) {
      Object.assign(patch, { [key]: fromEffective })
    }
  }
  return patch
}

/** 仅把本次草稿里用户明确修改的 PDF 字段转成引擎补丁。 */
export function pdfPendingPatch(
  pending: Record<string, unknown> | undefined,
): Partial<PdfViewSettings> {
  return patchFromPdfSource(pending)
}

/** 用户显式修改（设置面板或工具栏）最终应用的 PDF 字段。 */
export function pdfSettingsPatchForApply(
  record: BookReaderOverrides | undefined,
  pending: Record<string, unknown> | undefined,
): Partial<PdfViewSettings> {
  return {
    ...pdfExplicitPatchFromRecord(record),
    ...pdfPendingPatch(pending),
  }
}

/**
 * 旧进度 locator 的 view：manual / fit-page 视为用户显式选择并保留；
 * 旧版滚动自动写下的 fit-width 忽略，回到默认 100%。
 */
export function legacyPdfViewPatch(
  view: PdfViewState | null | undefined,
): Partial<PdfViewSettings> {
  if (view === null || view === undefined) {
    return {}
  }
  const patch: Partial<PdfViewSettings> = {}
  if (includes(PDF_LAYOUT_MODES, view.layoutMode)) {
    patch.layoutMode = view.layoutMode
  }
  if (view.zoomMode === "manual") {
    patch.zoomMode = "manual"
    if (typeof view.manualScale === "number") {
      patch.manualScale = clampScale(view.manualScale)
    }
  } else if (view.zoomMode === "fit-page") {
    patch.zoomMode = "fit-page"
  }
  return patch
}

export interface InitialPdfViewInput {
  record?: BookReaderOverrides | undefined
  legacyView?: PdfViewState | null | undefined
}

/**
 * 首次打开视图优先级：profile 显式 → 全局显式 → 旧进度（manual/fit-page）
 * → 内置默认 100%。返回完整视图，引擎首帧直接使用。
 */
export function resolveInitialPdfView(
  input: InitialPdfViewInput,
): PdfViewSettings {
  const explicit = pdfExplicitPatchFromRecord(input.record)
  const legacy = legacyPdfViewPatch(input.legacyView)
  return normalizeView({
    ...DEFAULT_PDF_VIEW,
    ...legacy,
    ...explicit,
  })
}

/** profile 切换时只应用该 profile 的显式值，不沿用另一 profile 的视图。 */
export function resolveProfilePdfView(
  record: BookReaderOverrides | undefined,
): PdfViewSettings {
  return normalizeView({
    ...DEFAULT_PDF_VIEW,
    ...pdfExplicitPatchFromRecord(record),
  })
}

/** 恢复本书默认后回到 全局显式 + 内置默认，而不是保留旧本书视图。 */
export function resolveResetPdfView(
  globalValue: Record<string, unknown> | undefined,
): PdfViewSettings {
  return normalizeView({
    ...DEFAULT_PDF_VIEW,
    ...(viewFromEffectiveSettings(globalValue) ?? {}),
  })
}

/** 工具栏/捏合产生的引擎补丁转成设置草稿的 `pdf.*` 稀疏字段。 */
export function pdfDraftFields(
  patch: Partial<PdfViewSettings>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const key of PDF_VIEW_KEYS) {
    const value = patch[key]
    if (value !== undefined) {
      fields[`pdf.${key}`] = value
    }
  }
  return fields
}
