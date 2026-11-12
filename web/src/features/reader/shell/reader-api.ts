import {
  ApiError,
  apiGet,
  apiPost,
  apiPut,
  fetchAuthStatus,
  isRecord,
} from "@/lib/api"
import type { BookFormat } from "@/features/library/types"

import {
  parseBookReaderOverrides,
  parseReaderBookmark,
  parseReaderBookmarkPage,
  parseReaderManifest,
  parseReaderProgress,
  parseReaderSettingsEnvelope,
  type BookReaderOverrides,
  type ReaderBookmark,
  type ReaderBookmarkPage,
  type ReaderLocatorPayload,
  type ReaderLocatorType,
  type ReaderManifest,
  type ReaderProfile,
  type ReaderProgress,
  type ReaderSettingsEnvelope,
} from "../types"

function bookPath(bookId: string): string {
  return `/api/v1/books/${encodeURIComponent(bookId)}`
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  )
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.length === 0) {
    return null
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds)
  }
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) {
    return null
  }
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
}

function errorFromResponse(response: Response, payload: unknown): ApiError {
  const envelope =
    isRecord(payload) && isRecord(payload.error) ? payload.error : null
  return new ApiError(
    response.status,
    typeof envelope?.code === "string" ? envelope.code : "http_error",
    typeof envelope?.message === "string"
      ? envelope.message
      : `服务器返回 ${response.status}。`,
    typeof envelope?.requestId === "string"
      ? envelope.requestId
      : response.headers.get("X-Request-Id") ?? "",
    isRecord(envelope?.details) ? envelope.details : {},
    parseRetryAfter(response.headers.get("Retry-After")),
  )
}

/**
 * 书签分页和条件删除需要读取 meta 与 If-Match，统一 API 入口的
 * data-only 返回不足，因此这里保留一个窄请求器。
 */
async function readerRawRequest(
  path: string,
  options: {
    method: "GET" | "DELETE"
    signal?: AbortSignal
    headers?: Record<string, string>
    csrf?: boolean
  },
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  }
  if (options.csrf === true) {
    const status = await fetchAuthStatus(options.signal)
    headers["X-CSRF-Token"] = status.csrfToken
  }

  let response: Response
  try {
    response = await fetch(path, {
      method: options.method,
      credentials: "same-origin",
      headers,
      signal: options.signal,
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new ApiError(
      0,
      "network_error",
      "无法连接本机服务，请检查网络后重试。",
      "",
      {},
    )
  }

  const text = await response.text()
  let payload: unknown = null
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }
  if (!response.ok) {
    throw errorFromResponse(response, payload)
  }
  if (response.status === 204 || text.length === 0) {
    return null
  }
  return payload
}

export async function fetchReaderManifest(
  bookId: string,
  signal?: AbortSignal,
): Promise<ReaderManifest> {
  const data = await apiGet<unknown>(`${bookPath(bookId)}/manifest`, signal)
  return parseReaderManifest(data)
}

export async function fetchReaderProgress(
  bookId: string,
  signal?: AbortSignal,
): Promise<ReaderProgress | null> {
  const data = await apiGet<unknown | null>(
    `${bookPath(bookId)}/progress`,
    signal,
  )
  return data === null ? null : parseReaderProgress(data)
}

export interface BookmarkPageParams {
  fileVersion: string
  cursor?: string | null
  limit?: number
}

export async function fetchReaderBookmarkPage(
  bookId: string,
  params: BookmarkPageParams,
  signal?: AbortSignal,
): Promise<ReaderBookmarkPage> {
  const search = new URLSearchParams()
  search.set("fileVersion", params.fileVersion)
  search.set("limit", String(params.limit ?? 100))
  if (params.cursor !== undefined && params.cursor !== null) {
    search.set("cursor", params.cursor)
  }
  const payload = await readerRawRequest(
    `${bookPath(bookId)}/bookmarks?${search.toString()}`,
    { method: "GET", signal },
  )
  return parseReaderBookmarkPage(payload)
}

export interface CreateReaderBookmarkInput {
  fileVersion: string
  format: BookFormat
  locatorType: ReaderLocatorType
  locatorPayload: ReaderLocatorPayload
  clientMutationId: string
  label?: string
}

export async function createReaderBookmark(
  bookId: string,
  input: CreateReaderBookmarkInput,
  signal?: AbortSignal,
): Promise<ReaderBookmark> {
  const data = await apiPost<unknown>(
    `${bookPath(bookId)}/bookmarks`,
    {
      schemaVersion: 1,
      fileVersion: input.fileVersion,
      format: input.format,
      locatorType: input.locatorType,
      locatorPayload: input.locatorPayload,
      clientMutationId: input.clientMutationId,
      ...(input.label === undefined ? {} : { label: input.label }),
    },
    signal,
  )
  return parseReaderBookmark(data)
}

export async function deleteReaderBookmark(
  bookId: string,
  bookmark: Pick<ReaderBookmark, "bookmarkId" | "revision">,
  signal?: AbortSignal,
): Promise<void> {
  await readerRawRequest(
    `${bookPath(bookId)}/bookmarks/${encodeURIComponent(bookmark.bookmarkId)}`,
    {
      method: "DELETE",
      signal,
      csrf: true,
      headers: { "If-Match": `"${bookmark.revision}"` },
    },
  )
}

export interface SaveReaderProgressInput {
  bookId: string
  fileVersion: string
  baseRevision: string
  clientMutationId: string
  format: BookFormat
  locatorType: ReaderLocatorType
  locatorPayload: ReaderLocatorPayload
  progressPercent: number
}

export async function putReaderProgress(
  input: SaveReaderProgressInput,
  signal?: AbortSignal,
): Promise<ReaderProgress> {
  const data = await apiPut<unknown>(
    `${bookPath(input.bookId)}/progress`,
    {
      schemaVersion: 1,
      fileVersion: input.fileVersion,
      baseRevision: input.baseRevision,
      clientMutationId: input.clientMutationId,
      format: input.format,
      locatorType: input.locatorType,
      locatorPayload: input.locatorPayload,
      progressPercent: input.progressPercent,
    },
    signal,
  )
  return parseReaderProgress(data)
}

export async function fetchReaderGlobalSettings(
  signal?: AbortSignal,
): Promise<ReaderSettingsEnvelope> {
  const data = await apiGet<unknown>("/api/v1/settings/reader", signal)
  return parseReaderSettingsEnvelope(data)
}

export async function putReaderGlobalSettings(
  input: { baseRevision: string; value: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<ReaderSettingsEnvelope> {
  const data = await apiPut<unknown>(
    "/api/v1/settings/reader",
    {
      schemaVersion: 1,
      baseRevision: input.baseRevision,
      value: input.value,
    },
    signal,
  )
  return parseReaderSettingsEnvelope(data)
}

function readerOverridesPath(
  bookId: string,
  profile: ReaderProfile,
): string {
  return `${bookPath(bookId)}/reader-overrides?profile=${encodeURIComponent(profile)}`
}

export async function fetchBookReaderOverrides(
  bookId: string,
  profile: ReaderProfile = "web",
  signal?: AbortSignal,
): Promise<BookReaderOverrides> {
  const data = await apiGet<unknown>(
    readerOverridesPath(bookId, profile),
    signal,
  )
  return parseBookReaderOverrides(data)
}

export async function putBookReaderOverrides(
  bookId: string,
  input: {
    fileVersion: string
    baseRevision: string
    overrides: Record<string, Record<string, unknown>>
    profile?: ReaderProfile
  },
  signal?: AbortSignal,
): Promise<BookReaderOverrides> {
  const data = await apiPut<unknown>(
    readerOverridesPath(bookId, input.profile ?? "web"),
    {
      schemaVersion: 1,
      fileVersion: input.fileVersion,
      baseRevision: input.baseRevision,
      overrides: input.overrides,
    },
    signal,
  )
  return parseBookReaderOverrides(data)
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

export function isConflictError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409
}

export function conflictRevision(error: unknown): string | null {
  if (!(error instanceof ApiError)) {
    return null
  }
  const current = error.details.current
  if (!isRecord(current)) {
    return null
  }
  const revision = current.revision
  if (typeof revision === "string" && revision.length > 0) {
    return revision
  }
  if (typeof revision === "number" && Number.isFinite(revision)) {
    return String(revision)
  }
  return null
}
