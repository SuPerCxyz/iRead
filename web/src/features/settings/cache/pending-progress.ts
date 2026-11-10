import { ReaderProgressStore } from "@/features/reader/session/progress-store"
import type { ProgressOutboxRecord } from "@/features/reader/session/progress-store"

/**
 * “立即更新”前检查本机是否还有待同步/冲突的阅读进度。
 *
 * 只读取 `iread-progress-v1` 的 outbox，不写入、不清理；
 * 进度保存开关与设备预加载偏好是独立存储，不受缓存清理影响。
 */
export function countUnsyncedProgressRecords(
  records: readonly ProgressOutboxRecord[],
): number {
  return records.filter(
    (record) =>
      record.pending !== null ||
      record.queued !== null ||
      record.inFlight !== null ||
      record.state === "pending" ||
      record.state === "syncing" ||
      record.state === "conflict" ||
      record.state === "auth-required" ||
      record.state === "error",
  ).length
}

export async function countUnsyncedProgress(): Promise<number> {
  const store = new ReaderProgressStore()
  try {
    await store.open()
    const records = await store.listOutbox()
    return countUnsyncedProgressRecords(records)
  } finally {
    store.close()
  }
}
