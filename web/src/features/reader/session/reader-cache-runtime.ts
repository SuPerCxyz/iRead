import {
  cacheBudgetForTier,
  detectCacheTier,
  type CacheTier,
  type ReaderCacheBudget,
} from "../cache/budgets"
import { ReaderMemoryCache } from "../cache/memory-cache"
import { ReaderPersistentCache } from "../cache/persistent-cache"
import { ReaderRenderCache } from "../cache/render-cache"
import { ReaderResourceScheduler } from "./resource-scheduler"

/**
 * 单本书阅读会话的缓存运行时。
 *
 * Shell 在 manifest/fileVersion 确定后创建，切书或卸载时 dispose：
 * - scheduler 中止本会话在途请求；
 * - L1/L2 内存对象立即释放；
 * - L3 连接关闭但不删除持久内容（清理只走设置页）。
 */
export interface ReaderCacheRuntime {
  readonly bookId: string
  readonly fileVersion: string
  readonly tier: CacheTier
  readonly budget: ReaderCacheBudget
  readonly scheduler: ReaderResourceScheduler
  readonly memory: ReaderMemoryCache
  readonly render: ReaderRenderCache
  readonly persistent: ReaderPersistentCache
  dispose(): void
}

export interface ReaderCacheRuntimeOptions {
  bookId: string
  fileVersion: string
  /** 显式档位优先；省略时按当前设备粗粒度检测。 */
  tier?: CacheTier
  concurrency?: number
  persistent?: ReaderPersistentCache
  memory?: ReaderMemoryCache
  render?: ReaderRenderCache
  scheduler?: ReaderResourceScheduler
}

export function createReaderCacheRuntime(
  options: ReaderCacheRuntimeOptions,
): ReaderCacheRuntime {
  const tier = options.tier ?? detectCacheTier()
  const budget = cacheBudgetForTier(tier)
  const ownsPersistent = options.persistent === undefined
  const ownsMemory = options.memory === undefined
  const ownsRender = options.render === undefined
  const persistent = options.persistent ?? new ReaderPersistentCache({ tier })
  const memory = options.memory ?? new ReaderMemoryCache(tier)
  const render = options.render ?? new ReaderRenderCache(tier)
  const scheduler =
    options.scheduler ??
    new ReaderResourceScheduler({
      concurrency: options.concurrency ?? budget.concurrency,
    })
  let disposed = false
  return {
    bookId: options.bookId,
    fileVersion: options.fileVersion,
    tier,
    budget,
    scheduler,
    memory,
    render,
    persistent,
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      scheduler.dispose()
      if (ownsMemory) {
        memory.dispose()
      } else {
        memory.clear()
      }
      if (ownsRender) {
        render.dispose()
      } else {
        render.clear()
      }
      if (ownsPersistent) {
        persistent.close()
      }
    },
  }
}
