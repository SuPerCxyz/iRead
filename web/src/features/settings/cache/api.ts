import { ApiError, apiGet, apiPost, isRecord } from "@/lib/api"
import {
  parseBackgroundTask,
  type BackgroundTask,
} from "@/features/library/types"

/**
 * 服务端派生阅读缓存 API。
 *
 * GET /api/v1/cache/usage 是服务端真实目录统计；POST /cache/clear 只允许
 * `reading-derived`，202 返回任务编号，进度通过 /api/v1/tasks/{id} 轮询。
 * 原文件、SQLite、阅读进度、书签、偏好均不在清理范围内。
 */

export const CACHE_USAGE_ENDPOINT = "/api/v1/cache/usage"
export const CACHE_CLEAR_ENDPOINT = "/api/v1/cache/clear"
export const CACHE_CLEAR_SCOPE = "reading-derived"

export interface ServerCacheKindUsage {
  bytes: number
  entries: number
}

export interface ServerCacheUsage {
  derivedBytes: number
  entries: number
  byKind: {
    covers: ServerCacheKindUsage
    comic: ServerCacheKindUsage
  }
  task: BackgroundTask | null
}

function protocolError(message: string): ApiError {
  return new ApiError(0, "protocol_error", message, "", {})
}

function readUsage(value: unknown, label: string): ServerCacheKindUsage {
  if (!isRecord(value)) {
    throw protocolError(`服务器返回的${label}缓存用量无效。`)
  }
  const bytes = value.bytes
  const entries = value.entries
  if (
    typeof bytes !== "number" ||
    !Number.isFinite(bytes) ||
    bytes < 0 ||
    typeof entries !== "number" ||
    !Number.isFinite(entries) ||
    entries < 0
  ) {
    throw protocolError(`服务器返回的${label}缓存用量无效。`)
  }
  return { bytes, entries }
}

export function parseServerCacheUsage(value: unknown): ServerCacheUsage {
  if (!isRecord(value)) {
    throw protocolError("服务器返回的缓存用量格式无效。")
  }
  const derivedBytes = value.derivedBytes
  const entries = value.entries
  if (
    typeof derivedBytes !== "number" ||
    !Number.isFinite(derivedBytes) ||
    derivedBytes < 0 ||
    typeof entries !== "number" ||
    !Number.isFinite(entries) ||
    entries < 0
  ) {
    throw protocolError("服务器返回的缓存用量格式无效。")
  }
  if (!isRecord(value.byKind)) {
    throw protocolError("服务器返回的缓存分类用量无效。")
  }
  let task: BackgroundTask | null = null
  if (value.task !== null && value.task !== undefined) {
    task = parseBackgroundTask(value.task)
  }
  return {
    derivedBytes,
    entries,
    byKind: {
      covers: readUsage(value.byKind.covers, "封面"),
      comic: readUsage(value.byKind.comic, "漫画页"),
    },
    task,
  }
}

export function parseCacheClearAccepted(value: unknown): { taskId: string } {
  if (!isRecord(value) || typeof value.taskId !== "string") {
    throw protocolError("服务器未返回缓存清理任务编号。")
  }
  const taskId = value.taskId.trim()
  if (taskId.length === 0) {
    throw protocolError("服务器未返回缓存清理任务编号。")
  }
  return { taskId }
}

export async function fetchServerCacheUsage(
  signal?: AbortSignal,
): Promise<ServerCacheUsage> {
  const data = await apiGet<unknown>(CACHE_USAGE_ENDPOINT, signal)
  return parseServerCacheUsage(data)
}

export async function requestServerCacheClear(): Promise<{ taskId: string }> {
  const data = await apiPost<unknown>(CACHE_CLEAR_ENDPOINT, {
    scope: CACHE_CLEAR_SCOPE,
  })
  return parseCacheClearAccepted(data)
}

export async function fetchCacheClearTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<BackgroundTask> {
  const data = await apiGet<unknown>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}`,
    signal,
  )
  return parseBackgroundTask(data)
}
