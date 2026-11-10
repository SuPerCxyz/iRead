import { ApiError, isRecord } from "@/lib/api"

export const BOOK_FORMATS = ["epub", "pdf", "cbz", "cbr"] as const
export type BookFormat = (typeof BOOK_FORMATS)[number]

export const BOOK_STATUSES = [
  "indexing",
  "ready",
  "unsupported",
  "error",
] as const
export type BookStatus = (typeof BOOK_STATUSES)[number]

export type BookSort =
  | "recent-added"
  | "recent-read"
  | "title"
  | "updated"

export interface ReadingCapabilities {
  canRead: boolean
  unavailableReason: string
  features: string[]
}

export interface BookCover {
  href: string
  mediaType: string
  width: number | null
  height: number | null
}

export interface BookProgress {
  progressPercent: number
  updatedAt: string
}

export interface BookSummary {
  bookId: string
  title: string
  subtitle: string | null
  authors: string[]
  format: BookFormat
  byteSize: number
  status: BookStatus
  cover: BookCover | null
  progress: BookProgress | null
  readingCapabilities: ReadingCapabilities
  createdAt: string
  updatedAt: string
}

export interface BookMetadata {
  title: string | null
  subtitle: string | null
  language: string | null
  publisher: string | null
  publishedAt: string | null
  identifier: string | null
  authors: string[]
  pageCount: number | null
  coverResourceId: string | null
  indexVersion: number
  extractionStatus: string
  extractedAt: string | null
}

export interface BookDetail extends BookSummary {
  fileVersion: string
  originalFileName: string
  extension: string
  metadata: BookMetadata | null
  indexTaskId: string | null
}

export interface BookListPage {
  books: BookSummary[]
  nextCursor: string | null
  total: number | null
}

function protocolError(message: string): never {
  throw new ApiError(0, "protocol_error", message, "", {})
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

function readNullableString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const value = record[key]
  if (value === null || value === undefined) {
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
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    protocolError(`服务器返回的${label}无效。`)
  }
  return [...value]
}

function parseCover(value: unknown): BookCover | null {
  if (value === null || value === undefined) {
    return null
  }
  if (!isRecord(value)) {
    protocolError("服务器返回的封面信息无效。")
  }
  const width = value.width
  const height = value.height
  if (
    width !== null &&
    width !== undefined &&
    (typeof width !== "number" || !Number.isFinite(width))
  ) {
    protocolError("服务器返回的封面宽度无效。")
  }
  if (
    height !== null &&
    height !== undefined &&
    (typeof height !== "number" || !Number.isFinite(height))
  ) {
    protocolError("服务器返回的封面高度无效。")
  }
  return {
    href: readString(value, "href", "封面地址"),
    mediaType: readString(value, "mediaType", "封面类型"),
    width: typeof width === "number" ? width : null,
    height: typeof height === "number" ? height : null,
  }
}

function parseProgress(value: unknown): BookProgress | null {
  if (value === null || value === undefined) {
    return null
  }
  if (!isRecord(value)) {
    protocolError("服务器返回的阅读进度无效。")
  }
  const percent = readFiniteNumber(value, "progressPercent", "阅读进度")
  if (percent < 0 || percent > 100) {
    protocolError("服务器返回的阅读进度超出范围。")
  }
  return {
    progressPercent: percent,
    updatedAt: readString(value, "updatedAt", "阅读进度时间"),
  }
}

function parseReadingCapabilities(value: unknown): ReadingCapabilities {
  if (!isRecord(value)) {
    protocolError("服务器返回的阅读能力信息无效。")
  }
  return {
    canRead: readBoolean(value, "canRead", "阅读能力"),
    unavailableReason:
      typeof value.unavailableReason === "string"
        ? value.unavailableReason
        : "",
    features: readStringArray(value.features, "阅读能力列表"),
  }
}

function parseBookBase(record: Record<string, unknown>): BookSummary {
  const format = readString(record, "format", "书籍格式")
  if (!(BOOK_FORMATS as readonly string[]).includes(format)) {
    protocolError("服务器返回的书籍格式不受支持。")
  }
  const status = readString(record, "status", "书籍状态")
  if (!(BOOK_STATUSES as readonly string[]).includes(status)) {
    protocolError("服务器返回的书籍状态无效。")
  }
  const byteSize = readFiniteNumber(record, "byteSize", "文件大小")
  if (byteSize < 0) {
    protocolError("服务器返回的文件大小无效。")
  }
  return {
    bookId: readString(record, "bookId", "书籍编号"),
    title: readString(record, "title", "书名"),
    subtitle: readNullableString(record, "subtitle", "副标题"),
    authors: readStringArray(record.authors, "作者列表"),
    format: format as BookFormat,
    byteSize,
    status: status as BookStatus,
    cover: parseCover(record.cover),
    progress: parseProgress(record.progress),
    readingCapabilities: parseReadingCapabilities(record.readingCapabilities),
    createdAt: readString(record, "createdAt", "创建时间"),
    updatedAt: readString(record, "updatedAt", "更新时间"),
  }
}

export function parseBookSummary(value: unknown): BookSummary {
  if (!isRecord(value)) {
    protocolError("服务器返回的书籍信息无效。")
  }
  return parseBookBase(value)
}

function parseMetadata(value: unknown): BookMetadata | null {
  if (value === null || value === undefined) {
    return null
  }
  if (!isRecord(value)) {
    protocolError("服务器返回的书籍元数据无效。")
  }
  const pageCount = value.pageCount
  if (
    pageCount !== null &&
    pageCount !== undefined &&
    (typeof pageCount !== "number" ||
      !Number.isFinite(pageCount) ||
      pageCount < 0)
  ) {
    protocolError("服务器返回的页数无效。")
  }
  const indexVersion = readFiniteNumber(value, "indexVersion", "索引版本")
  if (indexVersion < 0) {
    protocolError("服务器返回的索引版本无效。")
  }
  return {
    title: readNullableString(value, "title", "元数据书名"),
    subtitle: readNullableString(value, "subtitle", "副标题"),
    language: readNullableString(value, "language", "语言"),
    publisher: readNullableString(value, "publisher", "出版社"),
    publishedAt: readNullableString(value, "publishedAt", "出版时间"),
    identifier: readNullableString(value, "identifier", "标识"),
    authors: readStringArray(value.authors, "元数据作者列表"),
    pageCount: typeof pageCount === "number" ? pageCount : null,
    coverResourceId: readNullableString(value, "coverResourceId", "封面资源"),
    indexVersion,
    extractionStatus:
      typeof value.extractionStatus === "string"
        ? value.extractionStatus
        : "pending",
    extractedAt: readNullableString(value, "extractedAt", "元数据提取时间"),
  }
}

export function parseBookDetail(value: unknown): BookDetail {
  if (!isRecord(value)) {
    protocolError("服务器返回的书籍详情无效。")
  }
  return {
    ...parseBookBase(value),
    fileVersion: readString(value, "fileVersion", "文件版本"),
    originalFileName: readString(value, "originalFileName", "原始文件名"),
    extension: readString(value, "extension", "文件扩展名"),
    metadata: parseMetadata(value.metadata),
    indexTaskId: readNullableString(value, "indexTaskId", "整理任务编号"),
  }
}

export function parseBookListEnvelope(value: unknown): BookListPage {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    protocolError("服务器返回的书库列表无效。")
  }
  const meta = value.meta
  if (!isRecord(meta)) {
    protocolError("服务器返回的书库分页信息无效。")
  }
  const total = meta.total
  if (
    total !== null &&
    total !== undefined &&
    (typeof total !== "number" || !Number.isFinite(total) || total < 0)
  ) {
    protocolError("服务器返回的书库总数无效。")
  }
  const nextCursor = meta.nextCursor
  if (
    nextCursor !== null &&
    nextCursor !== undefined &&
    typeof nextCursor !== "string"
  ) {
    protocolError("服务器返回的书库游标无效。")
  }
  return {
    books: value.data.map(parseBookSummary),
    nextCursor:
      typeof nextCursor === "string" && nextCursor.length > 0
        ? nextCursor
        : null,
    total: typeof total === "number" ? total : null,
  }
}

export const TASK_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const
export type TaskState = (typeof TASK_STATES)[number]

export interface TaskProgress {
  phase: string
  completedUnits: number
  totalUnits: number | null
}

export interface BackgroundTaskError {
  code: string
  message: string
  retryable: boolean
}

export interface BackgroundTask {
  schemaVersion: number
  taskId: string
  kind: string
  bookId: string | null
  state: TaskState
  attempt: number
  revision: string
  cancellationRequested: boolean
  progress: TaskProgress
  error: BackgroundTaskError | null
  createdAt: string
  updatedAt: string
}

export function parseBackgroundTask(value: unknown): BackgroundTask {
  if (!isRecord(value)) {
    protocolError("服务器返回的整理任务无效。")
  }
  const state = readString(value, "state", "任务状态")
  if (!(TASK_STATES as readonly string[]).includes(state)) {
    protocolError("服务器返回的任务状态无效。")
  }
  if (!isRecord(value.progress)) {
    protocolError("服务器返回的任务进度无效。")
  }
  const progress = value.progress
  const completedUnits = readFiniteNumber(
    progress,
    "completedUnits",
    "任务已完成数量",
  )
  if (completedUnits < 0) {
    protocolError("服务器返回的任务已完成数量无效。")
  }
  const totalUnits = progress.totalUnits
  if (
    totalUnits !== null &&
    totalUnits !== undefined &&
    (typeof totalUnits !== "number" ||
      !Number.isFinite(totalUnits) ||
      totalUnits < 0)
  ) {
    protocolError("服务器返回的任务总数量无效。")
  }
  const attempt = readFiniteNumber(value, "attempt", "任务尝试次数")
  if (attempt < 1) {
    protocolError("服务器返回的任务尝试次数无效。")
  }
  const revision = value.revision
  if (typeof revision !== "string" && typeof revision !== "number") {
    protocolError("服务器返回的任务 revision 无效。")
  }
  const errorValue = value.error
  let error: BackgroundTaskError | null = null
  if (errorValue !== null && errorValue !== undefined) {
    if (!isRecord(errorValue)) {
      protocolError("服务器返回的任务错误无效。")
    }
    error = {
      code: readString(errorValue, "code", "任务错误码"),
      message:
        typeof errorValue.message === "string" ? errorValue.message : "",
      retryable: readBoolean(errorValue, "retryable", "任务可重试标记"),
    }
  }
  return {
    schemaVersion:
      typeof value.schemaVersion === "number" ? value.schemaVersion : 1,
    taskId: readString(value, "taskId", "任务编号"),
    kind: typeof value.kind === "string" ? value.kind : "",
    bookId: readNullableString(value, "bookId", "任务书籍编号"),
    state: state as TaskState,
    attempt,
    revision: String(revision),
    cancellationRequested: readBoolean(
      value,
      "cancellationRequested",
      "任务取消请求",
    ),
    progress: {
      phase: typeof progress.phase === "string" ? progress.phase : "queued",
      completedUnits,
      totalUnits: typeof totalUnits === "number" ? totalUnits : null,
    },
    error,
    createdAt: readString(value, "createdAt", "任务创建时间"),
    updatedAt: readString(value, "updatedAt", "任务更新时间"),
  }
}

export function coverHrefFor(
  cover: BookCover | null,
  variant: "grid" | "detail",
): string | null {
  if (cover === null) {
    return null
  }
  try {
    const url = new URL(cover.href, "http://iread.local")
    url.searchParams.set("variant", variant)
    return `${url.pathname}${url.search}`
  } catch {
    return cover.href
  }
}

const BYTES_PER_KIB = 2 ** 10

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "未知大小"
  }
  if (bytes < BYTES_PER_KIB) {
    return `${Math.round(bytes)} B`
  }
  const units = ["KB", "MB", "GB"] as const
  let value = bytes / BYTES_PER_KIB
  let unitIndex = 0
  while (value >= BYTES_PER_KIB && unitIndex < units.length - 1) {
    value /= BYTES_PER_KIB
    unitIndex += 1
  }
  const rounded =
    value >= 10 ? Math.round(value).toString() : value.toFixed(1)
  return `${rounded} ${units[unitIndex]}`
}

export function formatProgressPercent(percent: number): string {
  if (!Number.isFinite(percent)) {
    return "0%"
  }
  return `${Math.round(Math.min(100, Math.max(0, percent)))}%`
}

export const FORMAT_LABELS: Record<BookFormat, string> = {
  epub: "EPUB",
  pdf: "PDF",
  cbz: "CBZ",
  cbr: "CBR",
}

export const TASK_PHASE_LABELS: Record<string, string> = {
  queued: "等待整理",
  metadata: "读取元数据",
  toc: "生成目录",
  cover: "生成封面",
  finalize: "整理收尾",
}

export function taskPhaseLabel(phase: string): string {
  return TASK_PHASE_LABELS[phase] ?? phase
}
