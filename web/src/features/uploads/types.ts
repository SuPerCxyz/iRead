import { ApiError, isRecord } from "@/lib/api"

import type { BackgroundTaskError, TaskState } from "@/features/library/types"

export const UPLOAD_STATES = [
  "awaiting-upload",
  "uploading",
  "stored",
  "duplicate",
  "failed",
  "cancelled",
  "expired",
] as const
export type UploadState = (typeof UPLOAD_STATES)[number]

export interface UploadErrorInfo {
  code: string
  message: string
  reason?: string
  retryable: boolean
}

export interface UploadDTO {
  schemaVersion: number
  uploadId: string
  clientUploadId: string
  fileName: string
  expectedSize: number
  bytesReceived: number
  state: UploadState
  bookId: string | null
  duplicateOfBookId: string | null
  taskId: string | null
  error: UploadErrorInfo | null
  createdAt: string
  updatedAt: string
}

export const UPLOAD_PHASES = [
  "queued",
  "creating",
  "uploading",
  "verifying",
  "saved",
  "duplicate",
  "failed",
  "cancelling",
  "cancelled",
  "expired",
  "needs-file",
] as const
export type UploadPhase = (typeof UPLOAD_PHASES)[number]

export interface UploadTaskStatus {
  state: TaskState
  phase: string
  completedUnits: number
  totalUnits: number | null
  error: BackgroundTaskError | null
  cancellationRequested: boolean
}

export interface UploadItem {
  clientUploadId: string
  uploadId: string | null
  fileName: string
  byteSize: number
  bytesSent: number
  phase: UploadPhase
  state: UploadState | null
  bookId: string | null
  duplicateOfBookId: string | null
  taskId: string | null
  task: UploadTaskStatus | null
  taskUnavailable: boolean
  error: UploadErrorInfo | null
}

export interface UploadSnapshot {
  schemaVersion: 1
  items: UploadItem[]
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

function readNumber(
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

export function parseUploadDTO(value: unknown): UploadDTO {
  if (!isRecord(value)) {
    protocolError("服务器返回的上传信息无效。")
  }
  const state = readString(value, "state", "上传状态")
  if (!(UPLOAD_STATES as readonly string[]).includes(state)) {
    protocolError("服务器返回的上传状态无效。")
  }
  const expectedSize = readNumber(value, "expectedSize", "预期文件大小")
  if (expectedSize <= 0) {
    protocolError("服务器返回的预期文件大小无效。")
  }
  const bytesReceived = readNumber(value, "bytesReceived", "已接收字节数")
  if (bytesReceived < 0) {
    protocolError("服务器返回的已接收字节数无效。")
  }
  let error: UploadErrorInfo | null = null
  const errorValue = value.error
  if (errorValue !== null && errorValue !== undefined) {
    if (!isRecord(errorValue)) {
      protocolError("服务器返回的上传错误无效。")
    }
    const reason =
      typeof errorValue.reason === "string" && errorValue.reason.length > 0
        ? errorValue.reason
        : undefined
    error = {
      code: readString(errorValue, "code", "上传错误码"),
      message:
        typeof errorValue.message === "string" ? errorValue.message : "",
      reason,
      retryable: readBoolean(errorValue, "retryable", "上传可重试标记"),
    }
  }
  return {
    schemaVersion:
      typeof value.schemaVersion === "number" ? value.schemaVersion : 1,
    uploadId: readString(value, "uploadId", "上传编号"),
    clientUploadId: readString(value, "clientUploadId", "客户端上传编号"),
    fileName: readString(value, "fileName", "文件名"),
    expectedSize,
    bytesReceived,
    state: state as UploadState,
    bookId: readNullableString(value, "bookId", "上传书籍编号"),
    duplicateOfBookId: readNullableString(
      value,
      "duplicateOfBookId",
      "重复书籍编号",
    ),
    taskId: readNullableString(value, "taskId", "上传任务编号"),
    error,
    createdAt: readString(value, "createdAt", "上传创建时间"),
    updatedAt: readString(value, "updatedAt", "上传更新时间"),
  }
}
