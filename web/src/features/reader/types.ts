import { ApiError, isRecord } from "@/lib/api"
import type {
  BookFormat,
  ReadingCapabilities,
} from "@/features/library/types"

/**
 * 阅读器共享 DTO 与解析。
 *
 * 数据形状以 contracts 第 6/8/9 节和阶段3–6决策文件的 manifest/locator
 * 为准；这里只做前端消费所需的校验，不在缺字段时伪造可读正文或位置。
 */

export const READER_LOCATOR_TYPES = [
  "epub-cfi",
  "epub-anchor",
  "pdf-page",
  "comic-page",
] as const
export type ReaderLocatorType = (typeof READER_LOCATOR_TYPES)[number]

export const READER_FORMATS = ["epub", "pdf", "cbz", "cbr"] as const

export interface EpubTextQuote {
  exact: string
  prefix: string
  suffix: string
}

export interface EpubCfiLocatorPayload {
  locatorVersion: number
  spineIndex: number
  resourceId: string
  href: string
  cfi: string
  chapterProgress: number
  textQuote: EpubTextQuote | null
}

export interface EpubAnchorLocatorPayload {
  locatorVersion: number
  spineIndex: number
  resourceId: string
  href: string
  anchorId: string | null
  chapterProgress: number
  textQuote: EpubTextQuote | null
}

export interface PdfViewState {
  layoutMode: string
  zoomMode: string
  manualScale: number | null
}

export interface PdfRelativeViewport {
  x: number
  y: number
  width: number
  height: number
}

export interface PdfPageLocatorPayload {
  locatorVersion: number
  page: number
  pageOffset: number
  relativeViewport: PdfRelativeViewport | null
  view: PdfViewState | null
}

export const COMIC_DIRECTIONS = ["ltr", "rtl"] as const
export type ComicDirection = (typeof COMIC_DIRECTIONS)[number]

export const COMIC_MODES = ["single", "double", "continuous"] as const
export type ComicMode = (typeof COMIC_MODES)[number]

export const COMIC_FITS = ["screen", "width", "original"] as const
export type ComicFit = (typeof COMIC_FITS)[number]

export interface ComicPageLocatorPayload {
  locatorVersion: number
  page: number
  pageOffset: number
  direction: ComicDirection
  mode: ComicMode
  fit: ComicFit
}

export type ReaderLocatorPayload =
  | EpubCfiLocatorPayload
  | EpubAnchorLocatorPayload
  | PdfPageLocatorPayload
  | ComicPageLocatorPayload

export type ReaderLocator =
  | { locatorType: "epub-cfi"; locatorPayload: EpubCfiLocatorPayload }
  | { locatorType: "epub-anchor"; locatorPayload: EpubAnchorLocatorPayload }
  | { locatorType: "pdf-page"; locatorPayload: PdfPageLocatorPayload }
  | { locatorType: "comic-page"; locatorPayload: ComicPageLocatorPayload }

export type ReaderLocation = ReaderLocator & { progressPercent: number }

export interface ReaderTocItem {
  title: string
  href: string
  resourceId: string
  fragment: string
  level: number
  children: ReaderTocItem[]
}

export interface EpubRendition {
  layout: string
  flow: string
  spread: string
  direction: string
}

export interface EpubSpineItem {
  index: number
  resourceId: string
  href: string
  mediaType: string
  linear: boolean
  cfiBase: string
  size: number
}

export interface EpubResource {
  href: string
  mediaType: string
  size: number
  kind: string
}

export interface EpubFormatData {
  rendition: EpubRendition
  spine: EpubSpineItem[]
  resources: Record<string, EpubResource>
}

export interface PdfFormatData {
  contentHref: string
  byteSize: number
  etag: string
  pageCount: number
}

export interface ComicPage {
  page: number
  resourceId: string
  width: number
  height: number
  mediaType: string
  size: number
  availableVariants: string[]
}

export interface ComicFormatData {
  pageCount: number
  pages: ComicPage[]
}

interface ReaderManifestBase {
  schemaVersion: number
  bookId: string
  fileVersion: string
  indexVersion: number
  readingCapabilities: ReadingCapabilities
  toc: ReaderTocItem[]
}

export interface EpubReaderManifest extends ReaderManifestBase {
  format: "epub"
  formatData: EpubFormatData
}

export interface PdfReaderManifest extends ReaderManifestBase {
  format: "pdf"
  formatData: PdfFormatData
}

export interface ComicReaderManifest extends ReaderManifestBase {
  format: "cbz" | "cbr"
  formatData: ComicFormatData
}

export type ReaderManifest =
  | EpubReaderManifest
  | PdfReaderManifest
  | ComicReaderManifest

interface ReaderProgressMeta {
  schemaVersion: number
  bookId: string
  fileVersion: string
  format: BookFormat
  updatedAt: string
  revision: string
}

export type ReaderProgress = ReaderProgressMeta & ReaderLocation

export interface ReaderBookmarkMeta {
  schemaVersion: number
  bookmarkId: string
  bookId: string
  fileVersion: string
  format: BookFormat
  label: string
  revision: string
  createdAt: string
  updatedAt: string
}

export type ReaderBookmark = ReaderBookmarkMeta &
  ReaderLocator & { progressPercent: number }

export interface ReaderBookmarkPage {
  bookmarks: ReaderBookmark[]
  nextCursor: string | null
}

export interface ReaderSettingsEnvelope {
  schemaVersion: number
  revision: string
  updatedAt: string | null
  value: Record<string, unknown>
}

export const READER_PROFILES = ["web", "mobile"] as const
export type ReaderProfile = (typeof READER_PROFILES)[number]

export type ReaderSettingSource = "built-in" | "global" | "book"

export interface BookReaderOverrides {
  schemaVersion: number
  bookId: string
  fileVersion: string
  profile: ReaderProfile
  revision: string
  updatedAt: string | null
  overrides: Record<string, unknown>
  effectiveValues: Record<string, unknown>
  fieldSources: Record<string, unknown>
  globalRevision: string
  builtInVersion: number
}

function protocolError(message: string): never {
  throw new ApiError(0, "protocol_error", message, "", {})
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    protocolError(`服务器返回的${label}无效。`)
  }
  return value
}

function readString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key]
  if (typeof value !== "string") {
    protocolError(`服务器返回的${label}无效。`)
  }
  return value
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key]
  if (value === undefined || value === null) {
    return ""
  }
  if (typeof value !== "string") {
    protocolError(`服务器返回的${label}无效。`)
  }
  return value
}

function readNullableString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const value = record[key]
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== "string") {
    protocolError(`服务器返回的${label}无效。`)
  }
  return value
}

function readFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    protocolError(`服务器返回的${label}无效。`)
  }
  return value
}

function readRangeNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
  min: number,
  max: number,
): number {
  const value = readFiniteNumber(record, key, label)
  if (value < min || value > max) {
    protocolError(`服务器返回的${label}超出范围。`)
  }
  return value
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string,
): boolean {
  const value = record[key]
  if (typeof value !== "boolean") {
    protocolError(`服务器返回的${label}无效。`)
  }
  return value
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    protocolError(`服务器返回的${label}无效。`)
  }
  return [...value]
}

function readRevision(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key]
  if (typeof value === "string" && value.length > 0) {
    return value
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(value)
  }
  protocolError(`服务器返回的${label}无效。`)
}

function readFormat(record: Record<string, unknown>): BookFormat {
  const format = readString(record, "format", "书籍格式")
  if (!(READER_FORMATS as readonly string[]).includes(format)) {
    protocolError("服务器返回的书籍格式不受支持。")
  }
  return format as BookFormat
}

export function isReaderLocatorType(
  value: unknown,
): value is ReaderLocatorType {
  return (
    typeof value === "string" &&
    (READER_LOCATOR_TYPES as readonly string[]).includes(value)
  )
}

function parseTextQuote(value: unknown): EpubTextQuote | null {
  if (value === undefined || value === null) {
    return null
  }
  const record = readObject(value, "文本锚点")
  return {
    exact: readString(record, "exact", "文本锚点原文"),
    prefix: readOptionalString(record, "prefix", "文本锚点前缀"),
    suffix: readOptionalString(record, "suffix", "文本锚点后缀"),
  }
}

function parsePdfView(value: unknown): PdfViewState | null {
  if (value === undefined || value === null) {
    return null
  }
  const record = readObject(value, "PDF 视图状态")
  const manualScale = record.manualScale
  if (
    manualScale !== undefined &&
    manualScale !== null &&
    (typeof manualScale !== "number" ||
      !Number.isFinite(manualScale) ||
      manualScale <= 0)
  ) {
    protocolError("服务器返回的 PDF 手动缩放无效。")
  }
  return {
    layoutMode: readOptionalString(record, "layoutMode", "PDF 布局"),
    zoomMode: readOptionalString(record, "zoomMode", "PDF 缩放模式"),
    manualScale: typeof manualScale === "number" ? manualScale : null,
  }
}

function parseRelativeViewport(value: unknown): PdfRelativeViewport | null {
  if (value === undefined || value === null) {
    return null
  }
  const record = readObject(value, "PDF 相对视口")
  return {
    x: readFiniteNumber(record, "x", "PDF 视口横坐标"),
    y: readFiniteNumber(record, "y", "PDF 视口纵坐标"),
    width: readFiniteNumber(record, "width", "PDF 视口宽度"),
    height: readFiniteNumber(record, "height", "PDF 视口高度"),
  }
}

export function parseReaderLocation(
  locatorTypeValue: unknown,
  payloadValue: unknown,
  progressPercentValue: unknown,
): ReaderLocation {
  if (!isReaderLocatorType(locatorTypeValue)) {
    protocolError("服务器返回的定位类型不受支持。")
  }
  const progressPercent =
    typeof progressPercentValue === "number" &&
    Number.isFinite(progressPercentValue)
      ? Math.min(100, Math.max(0, progressPercentValue))
      : 0
  const payload = readObject(payloadValue, "定位数据")

  if (locatorTypeValue === "epub-cfi") {
    return {
      locatorType: "epub-cfi",
      progressPercent,
      locatorPayload: {
        locatorVersion: readFiniteNumber(payload, "locatorVersion", "定位版本"),
        spineIndex: readFiniteNumber(payload, "spineIndex", "章节序号"),
        resourceId: readOptionalString(payload, "resourceId", "资源编号"),
        href: readOptionalString(payload, "href", "章节地址"),
        cfi: readString(payload, "cfi", "EPUB CFI"),
        chapterProgress: readRangeNumber(
          payload,
          "chapterProgress",
          "章节内比例",
          0,
          1,
        ),
        textQuote: parseTextQuote(payload.textQuote),
      },
    }
  }

  if (locatorTypeValue === "epub-anchor") {
    return {
      locatorType: "epub-anchor",
      progressPercent,
      locatorPayload: {
        locatorVersion: readFiniteNumber(payload, "locatorVersion", "定位版本"),
        spineIndex: readFiniteNumber(payload, "spineIndex", "章节序号"),
        resourceId: readOptionalString(payload, "resourceId", "资源编号"),
        href: readOptionalString(payload, "href", "章节地址"),
        anchorId: readNullableString(payload, "anchorId", "锚点编号"),
        chapterProgress: readRangeNumber(
          payload,
          "chapterProgress",
          "章节内比例",
          0,
          1,
        ),
        textQuote: parseTextQuote(payload.textQuote),
      },
    }
  }

  if (locatorTypeValue === "pdf-page") {
    return {
      locatorType: "pdf-page",
      progressPercent,
      locatorPayload: {
        locatorVersion: readFiniteNumber(payload, "locatorVersion", "定位版本"),
        page: readRangeNumber(payload, "page", "PDF 页码", 1, 1_000_000),
        pageOffset: readRangeNumber(payload, "pageOffset", "页内偏移", 0, 1),
        relativeViewport: parseRelativeViewport(payload.relativeViewport),
        view: parsePdfView(payload.view),
      },
    }
  }

  const direction = readString(payload, "direction", "漫画阅读方向")
  if (!(COMIC_DIRECTIONS as readonly string[]).includes(direction)) {
    protocolError("服务器返回的漫画阅读方向无效。")
  }
  const mode = readString(payload, "mode", "漫画阅读模式")
  if (!(COMIC_MODES as readonly string[]).includes(mode)) {
    protocolError("服务器返回的漫画阅读模式无效。")
  }
  const fit = readString(payload, "fit", "漫画适应模式")
  if (!(COMIC_FITS as readonly string[]).includes(fit)) {
    protocolError("服务器返回的漫画适应模式无效。")
  }
  return {
    locatorType: "comic-page",
    progressPercent,
    locatorPayload: {
      locatorVersion: readFiniteNumber(payload, "locatorVersion", "定位版本"),
      page: readRangeNumber(payload, "page", "漫画页码", 1, 1_000_000),
      pageOffset: readRangeNumber(payload, "pageOffset", "页内偏移", 0, 1),
      direction: direction as ComicDirection,
      mode: mode as ComicMode,
      fit: fit as ComicFit,
    },
  }
}

function parseTocItems(value: unknown, depth: number): ReaderTocItem[] {
  if (!Array.isArray(value)) {
    protocolError("服务器返回的目录无效。")
  }
  if (depth > 16) {
    protocolError("服务器返回的目录层级过深。")
  }
  return value.map((entry) => {
    const record = readObject(entry, "目录项")
    const level = readRangeNumber(record, "level", "目录层级", 0, 32)
    return {
      title: readString(record, "title", "目录标题"),
      href: readOptionalString(record, "href", "目录地址"),
      resourceId: readOptionalString(record, "resourceId", "目录资源编号"),
      fragment: readOptionalString(record, "fragment", "目录片段"),
      level,
      children:
        record.children === undefined || record.children === null
          ? []
          : parseTocItems(record.children, depth + 1),
    }
  })
}

function parseReadingCapabilities(value: unknown): ReadingCapabilities {
  const record = readObject(value, "阅读能力")
  return {
    canRead: readBoolean(record, "canRead", "阅读能力"),
    unavailableReason: readOptionalString(
      record,
      "unavailableReason",
      "不可阅读原因",
    ),
    features: readStringArray(record.features ?? [], "阅读能力列表"),
  }
}

function parseEpubFormatData(value: unknown): EpubFormatData {
  const record = readObject(value, "EPUB 清单数据")
  const renditionRecord = readObject(record.rendition ?? {}, "EPUB 排版声明")
  if (!Array.isArray(record.spine)) {
    protocolError("服务器返回的 EPUB spine 无效。")
  }
  const resourcesRecord = readObject(record.resources ?? {}, "EPUB 资源表")
  const resources: Record<string, EpubResource> = {}
  for (const [resourceId, resourceValue] of Object.entries(resourcesRecord)) {
    const resource = readObject(resourceValue, "EPUB 资源")
    resources[resourceId] = {
      href: readOptionalString(resource, "href", "资源地址"),
      mediaType: readOptionalString(resource, "mediaType", "资源类型"),
      size: readFiniteNumber(resource, "size", "资源大小"),
      kind: readOptionalString(resource, "kind", "资源分类"),
    }
  }
  return {
    rendition: {
      layout: readOptionalString(renditionRecord, "layout", "EPUB 布局"),
      flow: readOptionalString(renditionRecord, "flow", "EPUB 流式模式"),
      spread: readOptionalString(renditionRecord, "spread", "EPUB 跨页"),
      direction: readOptionalString(renditionRecord, "direction", "EPUB 方向"),
    },
    spine: record.spine.map((entry) => {
      const item = readObject(entry, "EPUB spine 项")
      return {
        index: readRangeNumber(item, "index", "章节序号", 0, 1_000_000),
        resourceId: readOptionalString(item, "resourceId", "章节资源编号"),
        href: readOptionalString(item, "href", "章节地址"),
        mediaType: readOptionalString(item, "mediaType", "章节类型"),
        linear: item.linear === undefined ? true : readBoolean(item, "linear", "章节线性标记"),
        cfiBase: readOptionalString(item, "cfiBase", "CFI 基址"),
        size: readFiniteNumber(item, "size", "章节大小"),
      }
    }),
    resources,
  }
}

function parsePdfFormatData(value: unknown): PdfFormatData {
  const record = readObject(value, "PDF 清单数据")
  const pageCount = readRangeNumber(record, "pageCount", "PDF 页数", 0, 1_000_000)
  return {
    contentHref: readOptionalString(record, "contentHref", "PDF 内容地址"),
    byteSize: readFiniteNumber(record, "byteSize", "PDF 字节数"),
    etag: readOptionalString(record, "etag", "PDF ETag"),
    pageCount,
  }
}

function parseComicFormatData(value: unknown): ComicFormatData {
  const record = readObject(value, "漫画清单数据")
  if (!Array.isArray(record.pages)) {
    protocolError("服务器返回的漫画页列表无效。")
  }
  return {
    pageCount: readRangeNumber(record, "pageCount", "漫画页数", 0, 1_000_000),
    pages: record.pages.map((entry) => {
      const page = readObject(entry, "漫画页")
      return {
        page: readRangeNumber(page, "page", "漫画页码", 1, 1_000_000),
        resourceId: readOptionalString(page, "resourceId", "漫画页资源编号"),
        width: readFiniteNumber(page, "width", "漫画页宽度"),
        height: readFiniteNumber(page, "height", "漫画页高度"),
        mediaType: readOptionalString(page, "mediaType", "漫画页类型"),
        size: readFiniteNumber(page, "size", "漫画页大小"),
        availableVariants: readStringArray(
          page.availableVariants ?? [],
          "漫画页可用变体",
        ),
      }
    }),
  }
}

export function parseReaderManifest(value: unknown): ReaderManifest {
  const record = readObject(value, "阅读清单")
  const format = readFormat(record)
  const base = {
    schemaVersion: readFiniteNumber(record, "schemaVersion", "清单版本"),
    bookId: readString(record, "bookId", "书籍编号"),
    fileVersion: readString(record, "fileVersion", "文件版本"),
    indexVersion: readFiniteNumber(record, "indexVersion", "索引版本"),
    readingCapabilities: parseReadingCapabilities(record.readingCapabilities),
    toc: parseTocItems(record.toc ?? [], 0),
  }
  if (format === "epub") {
    return { ...base, format, formatData: parseEpubFormatData(record.formatData) }
  }
  if (format === "pdf") {
    return { ...base, format, formatData: parsePdfFormatData(record.formatData) }
  }
  return {
    ...base,
    format,
    formatData: parseComicFormatData(record.formatData),
  }
}

export function parseReaderProgress(value: unknown): ReaderProgress {
  const record = readObject(value, "阅读进度")
  const location = parseReaderLocation(
    record.locatorType,
    record.locatorPayload,
    record.progressPercent,
  )
  const meta: ReaderProgressMeta = {
    schemaVersion:
      typeof record.schemaVersion === "number" ? record.schemaVersion : 1,
    bookId: readString(record, "bookId", "书籍编号"),
    fileVersion: readString(record, "fileVersion", "文件版本"),
    format: readFormat(record),
    updatedAt: readString(record, "updatedAt", "进度更新时间"),
    revision: readRevision(record, "revision", "进度修订号"),
  }
  return { ...meta, ...location }
}

export function parseReaderBookmark(value: unknown): ReaderBookmark {
  const record = readObject(value, "书签")
  const location = parseReaderLocation(
    record.locatorType,
    record.locatorPayload,
    record.progressPercent ?? 0,
  )
  const meta: ReaderBookmarkMeta = {
    schemaVersion:
      typeof record.schemaVersion === "number" ? record.schemaVersion : 1,
    bookmarkId: readString(record, "bookmarkId", "书签编号"),
    bookId: readString(record, "bookId", "书签书籍编号"),
    fileVersion: readString(record, "fileVersion", "书签文件版本"),
    format: readFormat(record),
    label: readString(record, "label", "书签标签"),
    revision: readRevision(record, "revision", "书签修订号"),
    createdAt: readString(record, "createdAt", "书签创建时间"),
    updatedAt: readString(record, "updatedAt", "书签更新时间"),
  }
  return { ...meta, ...location }
}

export function parseReaderBookmarkPage(value: unknown): ReaderBookmarkPage {
  const record = readObject(value, "书签列表")
  if (!Array.isArray(record.data)) {
    protocolError("服务器返回的书签列表无效。")
  }
  const meta = isRecord(record.meta) ? record.meta : {}
  const nextCursor = meta.nextCursor
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    typeof nextCursor !== "string"
  ) {
    protocolError("服务器返回的书签游标无效。")
  }
  return {
    bookmarks: record.data.map(parseReaderBookmark),
    nextCursor:
      typeof nextCursor === "string" && nextCursor.length > 0
        ? nextCursor
        : null,
  }
}

export function parseReaderSettingsEnvelope(
  value: unknown,
): ReaderSettingsEnvelope {
  const record = readObject(value, "阅读设置")
  return {
    schemaVersion:
      typeof record.schemaVersion === "number" ? record.schemaVersion : 1,
    revision: readRevision(record, "revision", "设置修订号"),
    updatedAt: readNullableString(record, "updatedAt", "设置更新时间"),
    value: readObject(record.value ?? {}, "阅读设置值"),
  }
}

function readObjectField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  const value = record[key]
  if (value === undefined || value === null) {
    return {}
  }
  return readObject(value, label)
}

export function parseBookReaderOverrides(value: unknown): BookReaderOverrides {
  const record = readObject(value, "单书阅读设置")
  const profile =
    record.profile === "mobile" || record.profile === "web"
      ? record.profile
      : "web"
  return {
    schemaVersion:
      typeof record.schemaVersion === "number" ? record.schemaVersion : 1,
    bookId: readString(record, "bookId", "书籍编号"),
    fileVersion: readString(record, "fileVersion", "文件版本"),
    profile,
    revision: readRevision(record, "revision", "单书设置修订号"),
    updatedAt: readNullableString(record, "updatedAt", "单书设置更新时间"),
    overrides: readObjectField(record, "overrides", "单书覆盖值"),
    effectiveValues: readObjectField(
      record,
      "effectiveValues",
      "解析后的阅读设置",
    ),
    fieldSources: readObjectField(record, "fieldSources", "设置来源"),
    globalRevision:
      typeof record.globalRevision === "string"
        ? record.globalRevision
        : "0",
    builtInVersion:
      typeof record.builtInVersion === "number" &&
      Number.isFinite(record.builtInVersion)
        ? record.builtInVersion
        : 1,
  }
}

export function progressPercentForPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page) || page < 1) {
    return 0
  }
  const total = Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 1
  return Math.min(100, Math.max(0, ((page - 1) / Math.max(1, total - 1)) * 100))
}

export function pageForProgressPercent(
  percent: number,
  pageCount: number,
): number {
  const total = Math.max(1, Math.floor(pageCount))
  if (!Number.isFinite(percent)) {
    return 1
  }
  const clamped = Math.min(100, Math.max(0, percent))
  return Math.min(total, Math.max(1, Math.round(1 + (clamped / 100) * (total - 1))))
}

function normalizedOffset(offset: number): number {
  return Math.round(offset * 10_000)
}

/**
 * 判断两个 locator 是否指向同一稳定位置。用于“移除当前位置书签”。
 * 不使用 progressPercent 做唯一比较。
 */
export function sameReaderLocation(
  left: ReaderLocation,
  right: ReaderLocation,
): boolean {
  if (left.locatorType !== right.locatorType) {
    return false
  }
  if (
    left.locatorType === "pdf-page" &&
    right.locatorType === "pdf-page"
  ) {
    return (
      left.locatorPayload.page === right.locatorPayload.page &&
      normalizedOffset(left.locatorPayload.pageOffset) ===
        normalizedOffset(right.locatorPayload.pageOffset)
    )
  }
  if (
    left.locatorType === "comic-page" &&
    right.locatorType === "comic-page"
  ) {
    return left.locatorPayload.page === right.locatorPayload.page
  }
  if (left.locatorType === "epub-cfi" && right.locatorType === "epub-cfi") {
    return left.locatorPayload.cfi === right.locatorPayload.cfi
  }
  if (
    left.locatorType === "epub-anchor" &&
    right.locatorType === "epub-anchor"
  ) {
    return (
      left.locatorPayload.resourceId === right.locatorPayload.resourceId &&
      left.locatorPayload.anchorId === right.locatorPayload.anchorId &&
      left.locatorPayload.chapterProgress ===
        right.locatorPayload.chapterProgress
    )
  }
  return false
}

export function locatorPage(location: ReaderLocation): number | null {
  if (
    location.locatorType === "pdf-page" ||
    location.locatorType === "comic-page"
  ) {
    return location.locatorPayload.page
  }
  return null
}
