/**
 * 活动 L1/L2 缓存登记表。
 *
 * 退出登录/设置页清理时，Shell 不一定持有内存缓存实例；
 * 构造时登记、dispose 时注销，清理函数可以统一释放。
 * 这里只保存引用，不复制正文；登记对象必须实现 clear()。
 */

export type ReaderTrackedCacheKind = "memory" | "render"

export interface ReaderTrackedCache {
  clear(): void
}

interface TrackedEntry {
  kind: ReaderTrackedCacheKind
  cache: ReaderTrackedCache
}

const tracked = new Set<TrackedEntry>()

export function trackReaderCache(
  kind: ReaderTrackedCacheKind,
  cache: ReaderTrackedCache,
): () => void {
  const entry: TrackedEntry = { kind, cache }
  tracked.add(entry)
  return () => {
    tracked.delete(entry)
  }
}

export interface ReaderTrackedClearFailure {
  kind: ReaderTrackedCacheKind
  message: string
}

export function clearTrackedReaderCaches(): ReaderTrackedClearFailure[] {
  const failures: ReaderTrackedClearFailure[] = []
  for (const entry of tracked) {
    try {
      entry.cache.clear()
    } catch (error) {
      failures.push({
        kind: entry.kind,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return failures
}

export function trackedReaderCacheCounts(): Record<
  ReaderTrackedCacheKind,
  number
> {
  const counts: Record<ReaderTrackedCacheKind, number> = {
    memory: 0,
    render: 0,
  }
  for (const entry of tracked) {
    counts[entry.kind] += 1
  }
  return counts
}
