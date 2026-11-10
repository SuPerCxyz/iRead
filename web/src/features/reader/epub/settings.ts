import {
  EPUB_ALIGNS,
  EPUB_ANIMATIONS,
  EPUB_COLUMNS,
  EPUB_DEFAULT_SETTINGS,
  EPUB_FONT_FAMILIES,
  EPUB_PAGINATIONS,
  EPUB_PUBLISHER_CSS_MODES,
  type EpubReaderSettings,
} from "./types"

export interface EpubLayout {
  maxInlineSize: number
  maxBlockSize: number | null
  margin: number
  columns: number
  gapPercent: number
}

const MIN_TEXT_WIDTH = 240
const TWO_COLUMN_MIN_WIDTH = 900
const MAX_INLINE_WIDTH = 1600

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null
}

/** 只接受不会闭合 CSS 声明/规则的颜色字符串。 */
export function safeCssColor(value: string | null): string | null {
  if (value === null) {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 64) {
    return null
  }
  if (!/^[#(),.%\sa-zA-Z0-9-]+$/.test(trimmed)) {
    return null
  }
  if (/[;{}]/.test(trimmed)) {
    return null
  }
  return trimmed
}

export function mergeSettings(
  current: EpubReaderSettings,
  patch: Partial<EpubReaderSettings>,
): EpubReaderSettings {
  const next: EpubReaderSettings = { ...current }
  if (patch.fontFamily !== undefined) {
    next.fontFamily = enumValue(
      patch.fontFamily,
      EPUB_FONT_FAMILIES,
      current.fontFamily,
    )
  }
  if (patch.fontSize !== undefined) {
    next.fontSize = clamp(finiteNumber(patch.fontSize, current.fontSize), 12, 48)
  }
  if (patch.fontWeight !== undefined) {
    next.fontWeight = clamp(Math.round(finiteNumber(patch.fontWeight, current.fontWeight) / 100) * 100, 100, 900)
  }
  if (patch.lineHeight !== undefined) {
    next.lineHeight = clamp(
      finiteNumber(patch.lineHeight, current.lineHeight),
      1.2,
      2.4,
    )
  }
  if (patch.paragraphSpacing !== undefined) {
    next.paragraphSpacing = clamp(
      finiteNumber(patch.paragraphSpacing, current.paragraphSpacing),
      0,
      3,
    )
  }
  if (patch.textIndent !== undefined) {
    next.textIndent = clamp(
      finiteNumber(patch.textIndent, current.textIndent),
      0,
      2,
    )
  }
  if (patch.align !== undefined) {
    next.align = enumValue(patch.align, EPUB_ALIGNS, current.align)
  }
  if (patch.horizontalMargin !== undefined) {
    next.horizontalMargin = clamp(
      finiteNumber(patch.horizontalMargin, current.horizontalMargin),
      0,
      12,
    )
  }
  if (patch.verticalMargin !== undefined) {
    next.verticalMargin = clamp(
      finiteNumber(patch.verticalMargin, current.verticalMargin),
      0,
      12,
    )
  }
  if (patch.maxWidth !== undefined) {
    const width = textValue(patch.maxWidth)
    next.maxWidth =
      width === null || width === "auto" || /^(?:40|50|60|70|80|90|100)$/.test(width)
        ? width ?? "auto"
        : current.maxWidth
  }
  if (patch.pagination !== undefined) {
    next.pagination = enumValue(
      patch.pagination,
      EPUB_PAGINATIONS,
      current.pagination,
    )
  }
  if (patch.columns !== undefined) {
    next.columns = enumValue(patch.columns, EPUB_COLUMNS, current.columns)
  }
  if (patch.animation !== undefined) {
    next.animation = enumValue(
      patch.animation,
      EPUB_ANIMATIONS,
      current.animation,
    )
  }
  if (patch.publisherCSSMode !== undefined) {
    next.publisherCSSMode = enumValue(
      patch.publisherCSSMode,
      EPUB_PUBLISHER_CSS_MODES,
      current.publisherCSSMode,
    )
  }
  if (patch.background !== undefined) {
    next.background = safeCssColor(textValue(patch.background))
  }
  if (patch.textColor !== undefined) {
    next.textColor = safeCssColor(textValue(patch.textColor))
  }
  if (patch.linkColor !== undefined) {
    next.linkColor = safeCssColor(textValue(patch.linkColor))
  }
  if (patch.selectionColor !== undefined) {
    next.selectionColor = safeCssColor(textValue(patch.selectionColor))
  }
  return next
}

export function defaultSettings(
  patch?: Partial<EpubReaderSettings>,
): EpubReaderSettings {
  return mergeSettings(EPUB_DEFAULT_SETTINGS, patch ?? {})
}

export function computeLayout(
  settings: EpubReaderSettings,
  width: number,
  height: number,
): EpubLayout {
  const safeWidth = Math.max(MIN_TEXT_WIDTH, Math.round(width))
  const safeHeight = Math.max(MIN_TEXT_WIDTH, Math.round(height))
  const horizontal = (safeWidth * settings.horizontalMargin) / 100
  const vertical = (safeHeight * settings.verticalMargin) / 100
  const available = Math.max(
    MIN_TEXT_WIDTH,
    safeWidth - horizontal * 2,
  )
  let inline = available
  if (settings.maxWidth !== "auto") {
    const chars = Number(settings.maxWidth)
    if (Number.isFinite(chars) && chars > 0) {
      inline = Math.min(available, chars * settings.fontSize)
    }
  }
  inline = clamp(Math.round(inline), MIN_TEXT_WIDTH, MAX_INLINE_WIDTH)
  const canUseTwoColumns =
    settings.columns === "2" &&
    settings.pagination === "pagination" &&
    safeWidth >= TWO_COLUMN_MIN_WIDTH
  if (canUseTwoColumns) {
    inline = Math.max(MIN_TEXT_WIDTH, Math.floor(inline / 2))
  }
  return {
    maxInlineSize: inline,
    maxBlockSize:
      settings.pagination === "pagination"
        ? Math.max(MIN_TEXT_WIDTH, Math.round(safeHeight - vertical * 2))
        : null,
    margin: Math.max(0, Math.round(vertical)),
    columns: canUseTwoColumns ? 2 : 1,
    gapPercent: 7,
  }
}

function fontFamilyValue(settings: EpubReaderSettings): string | null {
  if (settings.fontFamily === "system-sans") {
    return 'system-ui, -apple-system, "Segoe UI", sans-serif'
  }
  if (settings.fontFamily === "serif") {
    return 'Georgia, "Times New Roman", "Noto Serif CJK SC", serif'
  }
  if (settings.fontFamily === "chinese-system") {
    return '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
  }
  if (settings.publisherCSSMode === "off") {
    return 'system-ui, -apple-system, "Segoe UI", sans-serif'
  }
  return null
}

/**
 * 正文块级元素直接声明用户字号/颜色，避免出版方 `p { font-size }`
 * 等直接规则覆盖 body 继承值。`:root:root` 提高优先级，用于压过
 * 出版方常见的 class 选择器；`!important` 仍与出版方 important 规则
 * 按 specificity 比较。
 */
const TEXT_BLOCK_SELECTOR =
  ":root:root body p, :root:root body div, :root:root body li, :root:root body dt, :root:root body dd, :root:root body blockquote"

const HEADING_SELECTOR =
  ":root:root body h1, :root:root body h2, :root:root body h3, :root:root body h4, :root:root body h5, :root:root body h6"

/** 标题随用户字号缩放，避免出版方绝对字号把标题固定在旧的正文基准上。 */
const HEADING_FONT_SIZES: [string, string][] = [
  ["h1", "2em"],
  ["h2", "1.6em"],
  ["h3", "1.35em"],
  ["h4", "1.15em"],
  ["h5", "1em"],
  ["h6", "0.9em"],
]

function declarationBlock(declarations: string[]): string {
  return `{ ${declarations.join("; ")}; }`
}

/**
 * 生成注入 EPUB 内容文档的阅读样式。使用 !important 覆盖出版方排版，
 * 但不触碰 Shell；颜色只在通过 safeCssColor 后写入。
 */
export function buildReaderCss(settings: EpubReaderSettings): string {
  const rules: string[] = [
    "html { -webkit-text-size-adjust: 100%; }",
    "body { margin: 0; }",
    "img, image, svg { max-width: 100%; height: auto; }",
    "table { max-width: 100%; }",
  ]
  const family = fontFamilyValue(settings)
  if (family !== null) {
    rules.push(`body { font-family: ${family} !important; }`)
  }
  rules.push(
    `body { font-size: ${settings.fontSize}px !important; font-weight: ${settings.fontWeight} !important; line-height: ${settings.lineHeight} !important; }`,
  )
  // 出版方字体仅在用户选择“出版方字体”且未关闭出版方样式时保留；
  // family 为 null 表示让出版方 p/div 等直接规则继续生效。
  const blockDeclarations = [`font-size: ${settings.fontSize}px !important`]
  if (family !== null) {
    blockDeclarations.push(`font-family: ${family} !important`)
  }
  if (settings.textColor !== null) {
    blockDeclarations.push(`color: ${settings.textColor} !important`)
  }
  rules.push(`${TEXT_BLOCK_SELECTOR} ${declarationBlock(blockDeclarations)}`)

  const headingDeclarations: string[] = []
  if (family !== null) {
    headingDeclarations.push(`font-family: ${family} !important`)
  }
  if (settings.textColor !== null) {
    headingDeclarations.push(`color: ${settings.textColor} !important`)
  }
  if (headingDeclarations.length > 0) {
    rules.push(
      `${HEADING_SELECTOR} ${declarationBlock(headingDeclarations)}`,
    )
  }
  for (const [tag, size] of HEADING_FONT_SIZES) {
    rules.push(
      `:root:root body ${tag} { font-size: ${size} !important; }`,
    )
  }

  rules.push(
    `body p, body div, body li, body dt, body dd, body blockquote { font-weight: inherit !important; line-height: ${settings.lineHeight} !important; }`,
  )
  // 段距和缩进的 em 以 p 自身最终字号为基准；上面的块级规则已把 p
  // 的字号固定为用户值，因此不会跟随出版方的 40px 等字号放大。
  rules.push(
    `:root:root body p { margin-block: ${settings.paragraphSpacing}em !important; }`,
  )
  rules.push(
    `:root:root body p { text-indent: ${settings.textIndent}em !important; }`,
  )
  rules.push(
    `:root:root body p { text-align: ${settings.align} !important; }`,
  )
  if (settings.pagination === "scroll") {
    rules.push(
      `body { padding-block: ${settings.verticalMargin}vh !important; }`,
    )
  }
  if (settings.background !== null) {
    rules.push(
      `html, body { background-color: ${settings.background} !important; }`,
    )
  }
  if (settings.textColor !== null) {
    rules.push(`html, body { color: ${settings.textColor} !important; }`)
  }
  if (settings.linkColor !== null) {
    rules.push(`a { color: ${settings.linkColor} !important; }`)
  }
  if (settings.selectionColor !== null) {
    rules.push(
      `::selection { background-color: ${settings.selectionColor} !important; }`,
    )
  }
  return rules.join("\n")
}

/** 生成章节自包含文档的最小结构样式，避免首帧无样式。 */
export function buildBaselineCss(): string {
  return [
    "html { -webkit-text-size-adjust: 100%; }",
    "body { margin: 0; }",
    "img, image, svg { max-width: 100%; height: auto; }",
  ].join("\n")
}
