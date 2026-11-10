import {
  EPUB_ALIGNS,
  EPUB_ANIMATIONS,
  EPUB_COLUMNS,
  EPUB_FONT_FAMILIES,
  EPUB_PAGINATIONS,
  EPUB_PUBLISHER_CSS_MODES,
  type EpubReaderSettings,
} from "../epub/types"
import { contrastRatio, type RgbColor } from "@/features/appearance/color"
import type { ReaderLocation } from "../types"
import { readSettingValue } from "./settings-model"

/**
 * Shell 设置面板与 EPUB 引擎之间的映射。
 * 面板保存的是 `reflow.*` 稀疏路径；这里只把确认过的值交给引擎，
 * 由引擎自己再做范围和枚举兜底。
 */

export interface ReaderColors {
  background: string | null
  textColor: string | null
  linkColor: string | null
  selectionColor: string | null
}

export interface ReaderSurfaceColors extends ReaderColors {
  presets?: Record<string, ReaderColors>
}

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function pickMaxWidth(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  return value === "auto" || /^(?:40|50|60|70|80|90|100)$/.test(value)
    ? value
    : undefined
}

function settingValue(
  effectiveValues: Record<string, unknown> | undefined,
  pending: Record<string, unknown>,
  key: string,
): unknown {
  const pendingValue = pending[`reflow.${key}`]
  if (pendingValue !== undefined) {
    return pendingValue
  }
  return readSettingValue(effectiveValues, "reflow", key)
}

export function epubSettingsPatch(
  effectiveValues: Record<string, unknown> | undefined,
  pending: Record<string, unknown>,
  colors: ReaderSurfaceColors,
): Partial<EpubReaderSettings> {
  const read = (key: string) =>
    settingValue(effectiveValues, pending, key)

  const patch: Partial<EpubReaderSettings> = {}
  const fontFamily = pickEnum(read("fontFamily"), EPUB_FONT_FAMILIES)
  if (fontFamily !== undefined) {
    patch.fontFamily = fontFamily === "publisher" && read("publisherFont") === false ? "system-sans" : fontFamily
  }
  const fontSize = pickNumber(read("fontSize"))
  if (fontSize !== undefined) {
    patch.fontSize = fontSize
  }
  const fontWeight = pickNumber(read("fontWeight"))
  if (fontWeight !== undefined) patch.fontWeight = fontWeight
  const lineHeight = pickNumber(read("lineHeight"))
  if (lineHeight !== undefined) {
    patch.lineHeight = lineHeight
  }
  const paragraphSpacing = pickNumber(read("paragraphSpacing"))
  if (paragraphSpacing !== undefined) {
    patch.paragraphSpacing = paragraphSpacing
  }
  const textIndent = pickNumber(read("textIndent"))
  if (textIndent !== undefined) {
    patch.textIndent = textIndent
  }
  const align = pickEnum(read("align"), EPUB_ALIGNS)
  if (align !== undefined) {
    patch.align = align
  }
  const horizontalMargin = pickNumber(read("horizontalMargin"))
  if (horizontalMargin !== undefined) {
    patch.horizontalMargin = horizontalMargin
  }
  const verticalMargin = pickNumber(read("verticalMargin"))
  if (verticalMargin !== undefined) {
    patch.verticalMargin = verticalMargin
  }
  const maxWidth = pickMaxWidth(read("maxWidth"))
  if (maxWidth !== undefined) {
    patch.maxWidth = maxWidth
  }
  const pagination = pickEnum(read("pagination"), EPUB_PAGINATIONS)
  if (pagination !== undefined) {
    patch.pagination = pagination
  }
  const columns = pickEnum(read("columns"), EPUB_COLUMNS)
  if (columns !== undefined) {
    patch.columns = columns
  }
  const animation = pickEnum(read("animation"), EPUB_ANIMATIONS)
  if (animation !== undefined) {
    patch.animation = animation
  }
  const publisherCSSMode = pickEnum(
    read("publisherCSSMode"),
    EPUB_PUBLISHER_CSS_MODES,
  )
  if (publisherCSSMode !== undefined) {
    patch.publisherCSSMode = publisherCSSMode
  }

  const theme = read("theme")
  const base = typeof theme === "string" ? colors.presets?.[theme] ?? colors : colors
  for (const [key, property] of [["background", "background"], ["text", "textColor"], ["link", "linkColor"], ["selection", "selectionColor"]] as const) {
    const value = read(key)
    patch[property] = typeof value === "string" && /^#[0-9a-f]{6}$/.test(value)
      ? value
      : typeof value === "string" && colors.presets?.[value]
        ? colors.presets[value][property]
        : value === "template" ? colors[property] : base[property]
  }
  return patch
}

function cssVariable(name: string): string | null {
  if (typeof document === "undefined") {
    return null
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return value.length > 0 ? value : null
}

/**
 * 阅读正文跟随应用主题：背景/正文来自主题 token，链接与选区使用强调色。
 * 颜色只作为受控 CSS 值传入引擎，不进入 Shell 自己的样式表。
 */
export function readerSurfaceColors(): ReaderSurfaceColors {
  return {
    background: cssVariable("--background"),
    textColor: cssVariable("--foreground"),
    linkColor: cssVariable("--primary"),
    selectionColor: cssVariable("--muted"),
    presets: Object.fromEntries(["paper", "white", "gray", "midnight"].map(preset => [preset, {
      background: cssVariable(`--reader-${preset}-background`), textColor: cssVariable(`--reader-${preset}-text`),
      linkColor: cssVariable(`--reader-${preset}-link`), selectionColor: cssVariable(`--reader-${preset}-selection`),
    }])),
  }
}

/** 仅解析受控正文颜色，不把出版内容或任意 CSS 注入应用。 */
function colorRgb(value: string | null): RgbColor | null {
  if (!value || typeof document === "undefined" || !CSS.supports("color", value)) return null
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return { r, g, b }
}
export function validateEpubColors(patch: Partial<EpubReaderSettings>): string | null {
  const background = colorRgb(patch.background ?? null), text = colorRgb(patch.textColor ?? null)
  const link = colorRgb(patch.linkColor ?? null), selection = colorRgb(patch.selectionColor ?? null)
  if (!background || !text || !link || !selection) return "无法验证正文颜色，请沿用阅读主题。"
  if (contrastRatio(text, background) < 4.5) return "文字与背景对比度不足 4.5:1；未应用此更改。"
  if (contrastRatio(link, background) < 4.5) return "链接与背景对比度不足 4.5:1；未应用此更改。"
  if (contrastRatio(text, selection) < 4.5) return "选区中的文字对比度不足 4.5:1；未应用此更改。"
  return null
}

export function epubLocationSection(
  location: ReaderLocation | null,
): number | null {
  if (
    location === null ||
    (location.locatorType !== "epub-cfi" &&
      location.locatorType !== "epub-anchor")
  ) {
    return null
  }
  return location.locatorPayload.spineIndex
}
