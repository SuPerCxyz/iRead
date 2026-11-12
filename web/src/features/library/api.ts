import { ApiError, apiGet, apiPatch, apiPost, isRecord } from "@/lib/api"

import {
  parseBackgroundTask,
  parseBookDetail,
  parseBookListEnvelope,
  type BackgroundTask,
  type BookDetail,
  type BookFormat,
  type BookListPage,
  type BookSort,
} from "./types"

export const BOOKS_ENDPOINT = "/api/v1/books"
export const TASKS_ENDPOINT = "/api/v1/tasks"
export const BOOKS_PAGE_SIZE = 24

export interface BookListParams {
  q?: string
  format?: BookFormat | null
  readingState?: "unread" | "reading" | "finished" | null
  limit?: number
  cursor?: string | null
  sort?: BookSort
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

function errorFromResponse(
  response: Response,
  payload: unknown,
): ApiError {
  const envelope =
    isRecord(payload) && isRecord(payload.error) ? payload.error : null
  const code =
    typeof envelope?.code === "string" ? envelope.code : "http_error"
  const message =
    typeof envelope?.message === "string"
      ? envelope.message
      : `服务器返回 ${response.status}。`
  const requestId =
    typeof envelope?.requestId === "string"
      ? envelope.requestId
      : response.headers.get("X-Request-Id") ?? ""
  const details = isRecord(envelope?.details) ? envelope.details : {}
  return new ApiError(
    response.status,
    code,
    message,
    requestId,
    details,
    parseRetryAfter(response.headers.get("Retry-After")),
  )
}

export async function fetchBookListPage(
  params: BookListParams = {},
  signal?: AbortSignal,
): Promise<BookListPage> {
  const search = new URLSearchParams()
  search.set("limit", String(params.limit ?? BOOKS_PAGE_SIZE))
  const q = params.q?.trim() ?? ""
  if (q.length > 0) {
    search.set("q", q)
  }
  if (params.format !== null && params.format !== undefined) {
    search.set("format", params.format)
  }
  if (
    params.readingState !== null &&
    params.readingState !== undefined
  ) {
    search.set("readingState", params.readingState)
  }
  if (params.cursor !== null && params.cursor !== undefined) {
    search.set("cursor", params.cursor)
  }
  if (params.sort !== undefined && params.sort !== "recent-added") {
    search.set("sort", params.sort)
  }

  let response: Response
  try {
    response = await fetch(`${BOOKS_ENDPOINT}?${search.toString()}`, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
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
  return parseBookListEnvelope(payload)
}

export async function fetchBookDetail(
  bookId: string,
  signal?: AbortSignal,
): Promise<BookDetail> {
  const data = await apiGet<unknown>(
    `${BOOKS_ENDPOINT}/${encodeURIComponent(bookId)}`,
    signal,
  )
  return parseBookDetail(data)
}

export async function updateBookTitle(
  bookId: string,
  title: string,
  signal?: AbortSignal,
): Promise<BookDetail> {
  const data = await apiPatch<unknown>(
    `${BOOKS_ENDPOINT}/${encodeURIComponent(bookId)}`,
    { title },
    signal,
  )
  return parseBookDetail(data)
}

export function bookDownloadUrl(bookId: string): string {
  return `${BOOKS_ENDPOINT}/${encodeURIComponent(bookId)}/download`
}

export async function fetchBackgroundTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<BackgroundTask> {
  const data = await apiGet<unknown>(
    `${TASKS_ENDPOINT}/${encodeURIComponent(taskId)}`,
    signal,
  )
  return parseBackgroundTask(data)
}

export async function cancelBackgroundTask(
  task: BackgroundTask,
): Promise<BackgroundTask> {
  const data = await apiPost<unknown>(
    `${TASKS_ENDPOINT}/${encodeURIComponent(task.taskId)}/cancel`,
    { baseRevision: task.revision },
  )
  return parseBackgroundTask(data)
}

export async function retryBackgroundTask(
  task: BackgroundTask,
): Promise<BackgroundTask> {
  const data = await apiPost<unknown>(
    `${TASKS_ENDPOINT}/${encodeURIComponent(task.taskId)}/retry`,
    { baseRevision: task.revision },
  )
  return parseBackgroundTask(data)
}
