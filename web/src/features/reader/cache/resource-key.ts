/**
 * 阅读资源的稳定缓存键。
 *
 * 网络资源键只包含 bookId/fileVersion/资源种类/资源 ID/字节区间/派生版本，
 * 不包含 DOM 或 React 状态；渲染键在此之上再加入排版参数。
 * 键的序列化必须确定，禁止把 Query 缓存或 fetch URL 直接当键。
 */

export const RESOURCE_KINDS = [
  "manifest",
  "epub-chapter",
  "epub-resource",
  "pdf-range",
  "pdf-page",
  "comic-page",
] as const

export type ResourceKind = (typeof RESOURCE_KINDS)[number]

/** 闭区间字节范围，单位 byte。 */
export interface ResourceRange {
  start: number
  end: number
}

export interface ResourceKey {
  bookId: string
  fileVersion: string
  kind: ResourceKind
  resourceId: string
  /** 漫画 screen/original 等派生档位。 */
  variant?: string
  /** PDF Range 块；EPUB/漫画通常为空。 */
  range?: ResourceRange
  /** 引擎内部派生版本，例如图片尺寸或清洗规则版本。 */
  derivation?: string
}

export interface RenderKeyParts {
  resource: ResourceKey
  styleRevision: string
  viewport: {
    width: number
    height: number
    rotation?: number
  }
  zoom: number
  rotation?: number
}

export function isResourceKind(value: unknown): value is ResourceKind {
  return (
    typeof value === "string" &&
    (RESOURCE_KINDS as readonly string[]).includes(value)
  )
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  )
}

export function validateResourceKey(key: ResourceKey): void {
  if (typeof key.bookId !== "string" || key.bookId.length === 0) {
    throw new TypeError("资源键缺少 bookId。")
  }
  if (
    typeof key.fileVersion !== "string" ||
    key.fileVersion.length === 0
  ) {
    throw new TypeError("资源键缺少 fileVersion。")
  }
  if (!isResourceKind(key.kind)) {
    throw new TypeError(`未知资源种类：${String(key.kind)}`)
  }
  if (
    typeof key.resourceId !== "string" ||
    key.resourceId.length === 0
  ) {
    throw new TypeError("资源键缺少 resourceId。")
  }
  if (key.range !== undefined) {
    if (
      !isFiniteNonNegativeInteger(key.range.start) ||
      !isFiniteNonNegativeInteger(key.range.end) ||
      key.range.end < key.range.start
    ) {
      throw new TypeError("资源键的字节区间无效。")
    }
  }
  if (
    key.variant !== undefined &&
    typeof key.variant !== "string"
  ) {
    throw new TypeError("资源键的 variant 无效。")
  }
  if (
    key.derivation !== undefined &&
    typeof key.derivation !== "string"
  ) {
    throw new TypeError("资源键的 derivation 无效。")
  }
  if (key.kind === "pdf-range" && key.range === undefined) {
    throw new TypeError("PDF Range 资源必须带字节区间。")
  }
}

/**
 * 确定性的资源键字符串。使用 JSON 数组而不是分隔符拼接，
 * 避免 bookId/resourceId 中可能出现的分隔符造成键碰撞。
 */
export function resourceKeyId(key: ResourceKey): string {
  validateResourceKey(key)
  return JSON.stringify([
    key.bookId,
    key.fileVersion,
    key.kind,
    key.resourceId,
    key.range === undefined ? null : [key.range.start, key.range.end],
    key.variant ?? null,
    key.derivation ?? null,
  ])
}

export function parseResourceKeyId(
  keyId: string,
): ResourceKey | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(keyId)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length !== 7) {
    return null
  }
  const [bookId, fileVersion, kind, resourceId, range, variant, derivation] =
    parsed
  if (
    typeof bookId !== "string" ||
    typeof fileVersion !== "string" ||
    !isResourceKind(kind) ||
    typeof resourceId !== "string"
  ) {
    return null
  }
  const key: ResourceKey = {
    bookId,
    fileVersion,
    kind,
    resourceId,
  }
  if (Array.isArray(range)) {
    if (range.length !== 2) {
      return null
    }
    const [start, end] = range
    if (
      !isFiniteNonNegativeInteger(start) ||
      !isFiniteNonNegativeInteger(end)
    ) {
      return null
    }
    key.range = { start, end }
  }
  if (typeof variant === "string") {
    key.variant = variant
  }
  if (typeof derivation === "string") {
    key.derivation = derivation
  }
  try {
    validateResourceKey(key)
  } catch {
    return null
  }
  return key
}

export function sameResourceKey(a: ResourceKey, b: ResourceKey): boolean {
  return resourceKeyId(a) === resourceKeyId(b)
}

/**
 * 渲染键包含 styleRevision/viewport/zoom/rotation。
 * 改字号只应失效此键，不能失效网络资源键。
 */
export function renderKeyId(parts: RenderKeyParts): string {
  return JSON.stringify([
    resourceKeyId(parts.resource),
    parts.styleRevision,
    [
      Math.round(parts.viewport.width * 100) / 100,
      Math.round(parts.viewport.height * 100) / 100,
      parts.viewport.rotation ?? null,
    ],
    parts.zoom,
    parts.rotation ?? null,
  ])
}

export function epubChapterKey(
  bookId: string,
  fileVersion: string,
  resourceId: string,
  href?: string,
): ResourceKey {
  return {
    bookId,
    fileVersion,
    kind: "epub-chapter",
    resourceId,
    derivation: href,
  }
}

export function epubResourceKey(
  bookId: string,
  fileVersion: string,
  resourceId: string,
  href?: string,
): ResourceKey {
  return {
    bookId,
    fileVersion,
    kind: "epub-resource",
    resourceId,
    derivation: href,
  }
}

export function comicPageKey(
  bookId: string,
  fileVersion: string,
  resourceId: string,
  variant?: string,
): ResourceKey {
  return {
    bookId,
    fileVersion,
    kind: "comic-page",
    resourceId,
    variant,
  }
}

export function pdfRangeKey(
  bookId: string,
  fileVersion: string,
  start: number,
  end: number,
): ResourceKey {
  return {
    bookId,
    fileVersion,
    kind: "pdf-range",
    resourceId: `${start}-${end}`,
    range: { start, end },
  }
}

/** PDF 页渲染键；只用于 L2 渲染缓存，不写入 L3 资源存储。 */
export function pdfPageKey(
  bookId: string,
  fileVersion: string,
  page: number,
): ResourceKey {
  return {
    bookId,
    fileVersion,
    kind: "pdf-page",
    resourceId: `page-${page}`,
  }
}

export function manifestKey(
  bookId: string,
  fileVersion: string,
): ResourceKey {
  return {
    bookId,
    fileVersion,
    kind: "manifest",
    resourceId: "manifest",
  }
}
