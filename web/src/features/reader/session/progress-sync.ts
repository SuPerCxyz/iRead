import { ApiError } from "@/lib/api"

import { describeError } from "@/features/library/errors"

export type ReaderProgressSaveStatus =
  | "idle"
  | "saving"
  | "saved"
  | "local-only"
  | "conflict"
  | "error"

export interface ReaderProgressSaveResult {
  status: ReaderProgressSaveStatus
  message: string
}

export function newClientMutationId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID()
  }
  return `reader-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
}

/**
 * 退出保存失败分类：网络/未实现/服务端故障都保留本机快照，
 * 不把“已保存在本机”说成“已跨端保存”。
 */
export function classifyProgressSaveError(
  error: unknown,
): ReaderProgressSaveResult {
  if (!(error instanceof ApiError)) {
    return {
      status: "local-only",
      message: "已保存在本机，但未能确认服务器同步，等待后续重试。",
    }
  }
  if (error.status === 409) {
    const message =
      error.code === "file_version_conflict"
        ? "原件已在别处更新，进度未写入服务器；本机位置已保留。"
        : "进度已在别处更新，未覆盖服务器记录；本机位置已保留。"
    return { status: "conflict", message }
  }
  if (error.status === 404) {
    return {
      status: "local-only",
      message: "进度服务尚未接入，当前位置已保存在本机。",
    }
  }
  if (error.status === 422) {
    return {
      status: "local-only",
      message: "服务器不接受当前定位，位置已保存在本机快照，未写入服务器。",
    }
  }
  if (error.status === 0 || error.status >= 500 || error.status === 429) {
    return {
      status: "local-only",
      message: "已保存在本机，联网或服务恢复后再同步。",
    }
  }
  return {
    status: "error",
    message: `未能写入本机进度记录：${describeError({
      status: error.status,
      code: error.code,
      message: error.message,
    })}`,
  }
}
