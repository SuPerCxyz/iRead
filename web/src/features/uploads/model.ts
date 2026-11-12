import type { BackgroundTask } from "@/features/library/types"

import type {
  UploadDTO,
  UploadErrorInfo,
  UploadItem,
  UploadPhase,
  UploadSnapshot,
  UploadState,
  UploadTaskStatus,
} from "./types"
import { UPLOAD_PHASES, UPLOAD_STATES } from "./types"

export const MAX_UPLOAD_FILES = 50
export const MAX_UPLOAD_BYTES = 2 ** 30
export const UPLOAD_CONCURRENCY = 2
export const UPLOAD_SNAPSHOT_KEY = "iread.upload.queue.v1"
export const ACCEPTED_EXTENSIONS = [".epub", ".pdf", ".cbz", ".cbr"] as const

export interface FileLike {
  name: string
  size: number
  lastModified: number
}

export interface UploadSelection<T extends FileLike> {
  clientUploadId: string
  fileName: string
  byteSize: number
  lastModified: number
  file: T
}

export interface UploadRejection {
  fileName: string
  message: string
}

export interface UploadSelectionResult<T extends FileLike> {
  selections: UploadSelection<T>[]
  rejections: UploadRejection[]
  overflow: number
}

export interface UploadSelectionOptions {
  idFactory?: () => string
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf(".")
  if (index < 0) {
    return ""
  }
  return name.slice(index).toLowerCase()
}

export function createClientUploadId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}

function duplicateKey(file: { name: string; size: number }): string {
  return `${file.name}\u0000${file.size}`
}

function shouldGuardDuplicate(item: UploadItem): boolean {
  return (
    item.phase === "queued" ||
    item.phase === "creating" ||
    item.phase === "uploading" ||
    item.phase === "verifying" ||
    item.phase === "failed" ||
    item.phase === "needs-file"
  )
}

export function prepareUploadSelection<T extends FileLike>(
  files: T[],
  existingItems: UploadItem[],
  options: UploadSelectionOptions = {},
): UploadSelectionResult<T> {
  const idFactory = options.idFactory ?? createClientUploadId
  const remaining = MAX_UPLOAD_FILES - existingItems.length
  const known = new Set(
    existingItems
      .filter((item) => shouldGuardDuplicate(item))
      .map((item) =>
        duplicateKey({ name: item.fileName, size: item.byteSize }),
      ),
  )
  const selections: UploadSelection<T>[] = []
  const rejections: UploadRejection[] = []
  let overflow = 0

  for (const file of files) {
    if (selections.length >= Math.max(0, remaining)) {
      overflow += 1
      continue
    }
    const extension = fileExtension(file.name)
    if (
      !(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)
    ) {
      rejections.push({
        fileName: file.name,
        message: "仅支持 EPUB、PDF、CBZ、CBR 文件。",
      })
      continue
    }
    if (file.size <= 0) {
      rejections.push({
        fileName: file.name,
        message: "文件为空，无法上传。",
      })
      continue
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      rejections.push({
        fileName: file.name,
        message: "文件超过 1 GiB，无法上传。",
      })
      continue
    }
    const key = duplicateKey(file)
    if (known.has(key)) {
      rejections.push({
        fileName: file.name,
        message: "这个文件已在待上传列表中。",
      })
      continue
    }
    known.add(key)
    selections.push({
      clientUploadId: idFactory(),
      fileName: file.name,
      byteSize: file.size,
      lastModified: file.lastModified,
      file,
    })
  }

  return { selections, rejections, overflow }
}

export function createUploadItem<T extends FileLike>(
  selection: UploadSelection<T>,
): UploadItem {
  return {
    clientUploadId: selection.clientUploadId,
    uploadId: null,
    fileName: selection.fileName,
    byteSize: selection.byteSize,
    bytesSent: 0,
    phase: "queued",
    state: null,
    bookId: null,
    duplicateOfBookId: null,
    taskId: null,
    task: null,
    taskUnavailable: false,
    error: null,
  }
}

export function phaseFromUploadState(state: UploadState): UploadPhase {
  switch (state) {
    case "awaiting-upload":
      return "queued"
    case "uploading":
      return "uploading"
    case "stored":
      return "saved"
    case "duplicate":
      return "duplicate"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "expired":
      return "expired"
  }
}

export function applyUploadDTO(item: UploadItem, dto: UploadDTO): UploadItem {
  const phase = phaseFromUploadState(dto.state)
  const bytesSent =
    dto.state === "stored"
      ? dto.expectedSize
      : Math.max(item.bytesSent, dto.bytesReceived)
  return {
    ...item,
    uploadId: dto.uploadId,
    fileName: dto.fileName,
    byteSize: dto.expectedSize,
    bytesSent: Math.min(dto.expectedSize, bytesSent),
    phase,
    state: dto.state,
    bookId: dto.bookId,
    duplicateOfBookId: dto.duplicateOfBookId,
    taskId: dto.taskId,
    error: dto.error,
    task: dto.state === "stored" ? item.task : null,
    taskUnavailable: dto.state === "stored" ? item.taskUnavailable : false,
  }
}

export function applyTaskToItem(
  item: UploadItem,
  task: BackgroundTask,
): UploadItem {
  const status: UploadTaskStatus = {
    state: task.state,
    phase: task.progress.phase,
    completedUnits: task.progress.completedUnits,
    totalUnits: task.progress.totalUnits,
    error: task.error,
    cancellationRequested: task.cancellationRequested,
  }
  return {
    ...item,
    taskId: task.taskId,
    task: status,
    taskUnavailable: false,
  }
}

export function restorePhaseForMissingFile(item: UploadItem): UploadItem {
  // failed 是终态诊断结果，恢复后保留服务端 reason；不能改写成 needs-file，
  // 否则用户刷新页面就看不到具体失败原因。
  if (
    item.phase === "queued" ||
    item.phase === "creating" ||
    item.phase === "uploading" ||
    item.phase === "verifying"
  ) {
    return { ...item, phase: "needs-file" }
  }
  return item
}

export function selectQueuedItems(
  items: UploadItem[],
  activeCount: number,
  concurrency = UPLOAD_CONCURRENCY,
): UploadItem[] {
  const slots = Math.max(0, concurrency - activeCount)
  if (slots === 0) {
    return []
  }
  return items.filter((item) => item.phase === "queued").slice(0, slots)
}

export function uploadProgressPercent(item: UploadItem): number {
  if (
    item.phase === "verifying" ||
    item.phase === "saved" ||
    item.phase === "duplicate"
  ) {
    return 100
  }
  if (item.byteSize <= 0) {
    return 0
  }
  return Math.min(100, Math.max(0, (item.bytesSent / item.byteSize) * 100))
}

export function uploadStatusText(item: UploadItem): string {
  switch (item.phase) {
    case "queued":
      return "等待上传"
    case "creating":
      return "正在创建上传"
    case "uploading":
      return "上传中"
    case "verifying":
      return "验证 / 整理中"
    case "saved":
      if (item.taskUnavailable) {
        return "已保存，整理状态暂不可用"
      }
      if (item.task === null) {
        return item.taskId === null
          ? "已保存，可在详情查看状态"
          : "已保存，等待整理"
      }
      switch (item.task.state) {
        case "queued":
        case "running":
          return item.task.cancellationRequested
            ? "已保存，正在取消整理"
            : "已保存，正在整理"
        case "succeeded":
          return "已保存，整理完成"
        case "failed":
          return "已保存，整理失败"
        case "cancelled":
          return "已保存，整理已取消"
      }
      return "已保存，等待整理"
    case "duplicate":
      return "书库中已有此文件"
    case "failed":
      return "上传失败"
    case "cancelling":
      return "正在取消上传"
    case "cancelled":
      return "已取消"
    case "expired":
      return "上传已过期"
    case "needs-file":
      return "需要重新选择文件"
  }
}

export function uploadPhaseBadgeVariant(
  item: UploadItem,
): "default" | "secondary" | "destructive" | "outline" {
  switch (item.phase) {
    case "failed":
    case "expired":
      return "destructive"
    case "saved":
    case "duplicate":
      return "default"
    case "cancelled":
    case "needs-file":
      return "outline"
    default:
      return "secondary"
  }
}

export function canCancelUpload(item: UploadItem): boolean {
  if (item.phase === "queued" || item.phase === "creating") {
    return true
  }
  if (item.phase === "uploading" || item.phase === "verifying") {
    return (
      item.uploadId !== null &&
      (item.state === "awaiting-upload" ||
        item.state === "uploading" ||
        item.state === null)
    )
  }
  return false
}

export function canRetryUpload(item: UploadItem): boolean {
  return item.phase === "failed" && item.error?.retryable !== false
}

export function canReselectUpload(item: UploadItem): boolean {
  return item.phase === "failed" || item.phase === "needs-file"
}

export function canRemoveUpload(item: UploadItem): boolean {
  if (
    item.phase === "duplicate" ||
    item.phase === "cancelled" ||
    item.phase === "expired" ||
    item.phase === "needs-file"
  ) {
    return true
  }
  if (item.phase === "failed") {
    return !canRetryUpload(item)
  }
  if (item.phase === "saved") {
    return (
      item.task === null ||
      item.task.state === "succeeded" ||
      item.task.state === "failed" ||
      item.task.state === "cancelled"
    )
  }
  return false
}

export function isUploadInProgress(item: UploadItem): boolean {
  return (
    item.phase === "queued" ||
    item.phase === "creating" ||
    item.phase === "uploading" ||
    item.phase === "verifying"
  )
}

export function taskProgressPercent(
  task: UploadTaskStatus,
): number | null {
  if (task.totalUnits === null || task.totalUnits <= 0) {
    return null
  }
  return Math.min(
    100,
    Math.max(0, (task.completedUnits / task.totalUnits) * 100),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(
  record: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = record[key]
  return typeof value === "string" ? value : fallback
}

function readNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  fallback = 0,
): number {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback
}

function readError(value: unknown): UploadErrorInfo | null {
  if (!isRecord(value) || typeof value.code !== "string") {
    return null
  }
  return {
    code: value.code,
    message: typeof value.message === "string" ? value.message : "",
    reason:
      typeof value.reason === "string" && value.reason.length > 0
        ? value.reason
        : undefined,
    retryable: value.retryable !== false,
  }
}

function readTask(value: unknown): UploadTaskStatus | null {
  if (!isRecord(value) || typeof value.state !== "string") {
    return null
  }
  const state = value.state
  if (
    state !== "queued" &&
    state !== "running" &&
    state !== "succeeded" &&
    state !== "failed" &&
    state !== "cancelled"
  ) {
    return null
  }
  return {
    state,
    phase: readString(value, "phase", "queued"),
    completedUnits: readNumber(value, "completedUnits"),
    totalUnits:
      value.totalUnits === null
        ? null
        : readNumber(value, "totalUnits"),
    error: readError(value.error),
    cancellationRequested: value.cancellationRequested === true,
  }
}

export function parseUploadSnapshot(value: unknown): UploadSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.items)
  ) {
    return { schemaVersion: 1, items: [] }
  }
  const items: UploadItem[] = []
  for (const raw of value.items.slice(0, MAX_UPLOAD_FILES)) {
    if (!isRecord(raw)) {
      continue
    }
    const phase = readString(raw, "phase")
    if (!(UPLOAD_PHASES as readonly string[]).includes(phase)) {
      continue
    }
    const state = readString(raw, "state")
    const uploadState =
      state !== "" && (UPLOAD_STATES as readonly string[]).includes(state)
        ? (state as UploadState)
        : null
    const clientUploadId = readString(raw, "clientUploadId")
    const fileName = readString(raw, "fileName")
    const byteSize = readNumber(raw, "byteSize")
    if (
      clientUploadId.length === 0 ||
      fileName.length === 0 ||
      byteSize <= 0
    ) {
      continue
    }
    items.push({
      clientUploadId,
      uploadId: readNullableString(raw, "uploadId"),
      fileName,
      byteSize,
      bytesSent: Math.min(byteSize, readNumber(raw, "bytesSent")),
      phase: phase as UploadPhase,
      state: uploadState,
      bookId: readNullableString(raw, "bookId"),
      duplicateOfBookId: readNullableString(raw, "duplicateOfBookId"),
      taskId: readNullableString(raw, "taskId"),
      task: readTask(raw.task),
      taskUnavailable: raw.taskUnavailable === true,
      error: readError(raw.error),
    })
  }
  return { schemaVersion: 1, items }
}

export function serializeUploadSnapshot(items: UploadItem[]): string {
  const payload: UploadSnapshot = {
    schemaVersion: 1,
    items: items.slice(0, MAX_UPLOAD_FILES).map((item) => ({
      clientUploadId: item.clientUploadId,
      uploadId: item.uploadId,
      fileName: item.fileName,
      byteSize: item.byteSize,
      bytesSent: item.bytesSent,
      phase: item.phase,
      state: item.state,
      bookId: item.bookId,
      duplicateOfBookId: item.duplicateOfBookId,
      taskId: item.taskId,
      task: item.task,
      taskUnavailable: item.taskUnavailable,
      error: item.error,
    })),
  }
  return JSON.stringify(payload)
}
