/**
 * 认证生命周期结束（显式退出或会话失效）时的本机数据清理。
 *
 * 只清理可重建的阅读正文/封面缓存；进度 outbox、设备偏好和
 * 外观偏好不在这里处理。阅读器进度同步实例由阅读器在挂载时注册，
 * 认证层不主动创建实例：没有实例时跳过 suspend，避免为了退出而打开进度库。
 *
 * 清理失败不能阻止退出，因此 `runLogoutCleanup` 永远不 reject，
 * 由返回值区分成功、跳过和失败。
 */

export interface LogoutProgressSync {
  suspendForLogout: () => Promise<void>
}

export interface LogoutCleanupResult {
  contentCache: "cleared" | "failed"
  progress: "suspended" | "skipped" | "failed"
}

let activeProgressSync: LogoutProgressSync | null = null
let inFlight: Promise<LogoutCleanupResult> | null = null

/**
 * 注册当前活动的进度同步实例，返回注销函数。
 * 同一时间只保留一个实例；重复注册以最后一次为准。
 */
export function registerLogoutProgressSync(
  sync: LogoutProgressSync,
): () => void {
  activeProgressSync = sync
  return () => {
    if (activeProgressSync === sync) {
      activeProgressSync = null
    }
  }
}

async function clearContentCache(): Promise<boolean> {
  // 动态导入避免 auth → reader/cache 的静态循环依赖；
  // 清理代码只在本机退出/会话失效时加载，不进入认证模块的初始化路径。
  const { clearReadableContentOnLogout } = await import(
    "@/features/reader/cache/cache-admin"
  )
  const summary = await clearReadableContentOnLogout()
  return summary.ok
}

async function suspendProgress(sync: LogoutProgressSync): Promise<void> {
  await sync.suspendForLogout()
}

/**
 * 执行退出清理。并发的 401 与显式退出共享同一次清理；
 * 任一环节失败都只标记结果，不影响调用方继续退出。
 */
export function runLogoutCleanup(): Promise<LogoutCleanupResult> {
  if (inFlight !== null) {
    return inFlight
  }

  const sync = activeProgressSync
  const promise = (async (): Promise<LogoutCleanupResult> => {
    const [content, progress] = await Promise.allSettled([
      clearContentCache(),
      sync === null ? Promise.resolve() : suspendProgress(sync),
    ])
    return {
      contentCache:
        content.status === "fulfilled" && content.value === true
          ? "cleared"
          : "failed",
      progress:
        sync === null
          ? "skipped"
          : progress.status === "fulfilled"
            ? "suspended"
            : "failed",
    }
  })().finally(() => {
    if (inFlight === promise) {
      inFlight = null
    }
  })

  inFlight = promise
  return promise
}
