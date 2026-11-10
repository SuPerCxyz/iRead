import { ApiError } from "@/lib/api"
import type { BackgroundTask, TaskState } from "@/features/library/types"
import type { PwaStatus } from "@/pwa/register"

/**
 * 设置页“缓存与 PWA”的纯展示模型。
 *
 * 这里只做状态/单位/错误映射，便于单测覆盖；真实读写分别在
 * server api、reader cache admin 与 pwa/register 中完成。
 */

export interface CacheKindUsageLike {
  bytes: number
  entries: number
}

export interface CacheClearFailureLike {
  area: string
  name: string
  message: string
  retryable: boolean
}

export interface ClientClearSummaryLike {
  ok: boolean
  clearedBytes: number
  clearedEntries: number
  failures: readonly CacheClearFailureLike[]
  remaining: {
    totalMeasured: CacheKindUsageLike
  }
}

export type ClientClearOutcomeKind = "success" | "partial" | "failed"

export interface ClientClearOutcome {
  kind: ClientClearOutcomeKind
  title: string
  description: string
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const
const KIB = 2 ** 10

function trimFraction(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")
}

/** 以 1024 进制格式化字节；0/负数/非法值统一显示 0 B。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B"
  }
  let index = 0
  let value = bytes
  while (value >= KIB && index < BYTE_UNITS.length - 1) {
    value /= KIB
    index += 1
  }
  const digits = index === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${trimFraction(value.toFixed(digits))} ${BYTE_UNITS[index]}`
}

/** 精确字节数，用于“精确测量”旁的可核对值。 */
export function formatExactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 字节"
  }
  return `${Math.round(bytes).toLocaleString("zh-CN")} 字节`
}

export function formatEntries(entries: number): string {
  const value = Number.isFinite(entries) && entries > 0 ? Math.round(entries) : 0
  return `${value.toLocaleString("zh-CN")} 条`
}

export function formatTimestamp(value: string | null): string {
  if (value === null || value.length === 0) {
    return "尚未记录"
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return "时间无效"
  }
  return new Date(parsed).toLocaleString("zh-CN")
}

export function isTerminalTaskState(state: TaskState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled"
}

export function isActiveTaskState(state: TaskState): boolean {
  return state === "queued" || state === "running"
}

const TASK_STATE_LABELS: Record<TaskState, string> = {
  queued: "排队中",
  running: "清理中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

export function cacheTaskStateLabel(state: TaskState): string {
  return TASK_STATE_LABELS[state]
}

export interface CacheTaskProgressView {
  completedUnits: number
  totalUnits: number | null
  percent: number | null
  label: string
}

export function cacheTaskProgress(task: BackgroundTask): CacheTaskProgressView {
  const completedUnits = Math.max(0, task.progress.completedUnits)
  const totalUnits = task.progress.totalUnits
  if (totalUnits === null || totalUnits <= 0) {
    return {
      completedUnits,
      totalUnits,
      percent: null,
      label: `${formatEntries(completedUnits)}已处理`,
    }
  }
  const percent = Math.min(
    100,
    Math.max(0, Math.round((completedUnits / totalUnits) * 100)),
  )
  return {
    completedUnits,
    totalUnits,
    percent,
    label: `${formatEntries(completedUnits)} / ${formatEntries(totalUnits)}`,
  }
}

export function describeCacheTaskCompletion(task: BackgroundTask): string {
  const progress = cacheTaskProgress(task)
  if (task.state === "succeeded") {
    return `已清理 ${formatEntries(progress.completedUnits)}可重建缓存。`
  }
  if (task.state === "cancelled") {
    return "清理任务已取消；已删除的部分不会回滚。"
  }
  return (
    task.error?.message ??
    "部分缓存未能清理，可重试。影响范围：封面缓存（covers）与漫画页缓存（comic）。"
  )
}

export function serverCacheIsEmpty(usage: {
  derivedBytes: number
  entries: number
}): boolean {
  return usage.derivedBytes <= 0 && usage.entries <= 0
}

export function clientCacheIsEmpty(usage: {
  totalMeasured: CacheKindUsageLike
}): boolean {
  return (
    usage.totalMeasured.bytes <= 0 && usage.totalMeasured.entries <= 0
  )
}

/**
 * 清理结果映射。失败的空缓存不能伪装成成功；部分删除保留剩余用量，
 * 便于界面展示“还有多少未清理”并给出重试。
 */
export function describeClientClear(
  summary: ClientClearSummaryLike,
): ClientClearOutcome {
  const cleared = `已清理 ${formatEntries(summary.clearedEntries)}（${formatBytes(
    summary.clearedBytes,
  )}）。`
  if (summary.ok) {
    return {
      kind: "success",
      title: "本机阅读缓存已清理",
      description: clientCacheIsEmpty(summary.remaining)
        ? `${cleared}本机阅读内容缓存已为空。`
        : `${cleared}仍检测到 ${formatBytes(
            summary.remaining.totalMeasured.bytes,
          )} 可重建内容，可再次清理。`,
    }
  }

  const retained = formatBytes(summary.remaining.totalMeasured.bytes)
  const retainedEntries = formatEntries(
    summary.remaining.totalMeasured.entries,
  )
  const failureText = `${summary.failures.length} 项未能清理`
  if (summary.clearedBytes > 0 || summary.clearedEntries > 0) {
    return {
      kind: "partial",
      title: "本机阅读缓存部分清理",
      description: `${cleared}${failureText}，剩余 ${retained} / ${retainedEntries}。已删除的条目不会回滚，可重试剩余范围。`,
    }
  }
  return {
    kind: "failed",
    title: "未能清理本机阅读缓存",
    description: `${failureText}，仍占用 ${retained} / ${retainedEntries}。请检查浏览器存储权限后重试。`,
  }
}

export function clearFailureLabel(failure: CacheClearFailureLike): string {
  return `${failure.area} · ${failure.name}：${failure.message}`
}

const CACHE_ERROR_MESSAGES: Record<string, string> = {
  cache_clear_failed: "缓存清理暂时失败，可重试。",
  invalid_request: "缓存清理请求无效，请刷新页面后重试。",
  unsupported_media_type: "缓存清理请求格式无效，请刷新页面后重试。",
  payload_too_large: "缓存清理请求过大，请刷新页面后重试。",
  unauthenticated: "登录状态已失效，请重新登录。",
  forbidden: "安全校验失败，请刷新页面后重试。",
  network_error: "无法连接本机服务，请确认服务已启动后重试。",
  protocol_error: "服务器响应格式异常，请刷新页面后重试。",
}

export function describeCacheRequestError(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof ApiError) {
    const known = CACHE_ERROR_MESSAGES[error.code]
    if (known !== undefined) {
      return known
    }
    if (error.status === 401) {
      return "登录状态已失效，请重新登录。"
    }
    if (error.status === 403) {
      return "安全校验失败，请刷新页面后重试。"
    }
    if (error.status === 503) {
      return "缓存清理暂时不可用，可稍后重试。"
    }
    if (error.status === 0) {
      return "无法连接本机服务，请确认服务已启动后重试。"
    }
    if (error.status >= 500) {
      return "服务器暂时无法完成缓存请求，请稍后重试。"
    }
    return error.message.length > 0 ? error.message : fallback
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  return fallback
}

export function describePwaStatus(status: PwaStatus): {
  label: string
  description: string
} {
  switch (status.status) {
    case "unsupported":
      return {
        label: "不支持",
        description: "当前浏览器不支持 Service Worker；应用仍可在线使用。",
      }
    case "disabled":
      return {
        label: "未启用",
        description:
          "开发模式未启用 Service Worker；离线能力需使用生产构建验证。",
      }
    case "registering":
      return {
        label: "注册中",
        description: "正在注册 Service Worker。",
      }
    case "update-available":
      return {
        label: "可更新",
        description:
          "有新版本等待更新；只有你点击“立即更新”后才会重新加载。",
      }
    case "error":
      return {
        label: "错误",
        description: `Service Worker 注册失败：${
          status.error ?? "未知错误"
        }`,
      }
    default:
      return {
        label: "已启用",
        description: "Service Worker 已注册；应用外壳与已缓存内容可离线打开。",
      }
  }
}

export function pwaUpdateBlockReason(input: {
  appearancePending: boolean
  pendingProgress: number | null
}): string | null {
  if (input.appearancePending) {
    return "外观设置尚未保存完成，请先等待保存后再更新。"
  }
  if (input.pendingProgress !== null && input.pendingProgress > 0) {
    return `有 ${input.pendingProgress} 条阅读进度尚未同步，请等待同步完成后再更新。`
  }
  return null
}

export const OFFLINE_SCOPE_NOTE =
  "离线只保证已缓存的应用外壳与有限已授权内容，不承诺整本图书离线可读，也不会在后台持续下载大书。"

export const CLEAR_SCOPE_NOTE =
  "只删除可重建的封面与漫画页派生缓存，不删除原件、阅读进度、阅读偏好、书签或全局设置。"
