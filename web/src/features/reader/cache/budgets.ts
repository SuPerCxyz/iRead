import type { ResourceKey } from "./resource-key"

/**
 * 三层缓存预算的起点值。它们是可配置的导出常量，不是服务端设置，
 * 也不进入全局 reader / 单书 overrides 同步。
 *
 * 预算按“移动/桌面”两档；真实设备档位可在运行时用 selectCacheTier 选择。
 * L1 存网络资源字节，L2 存引擎渲染对象，L3 存可重建的持久资源。
 */
export type CacheTier = "mobile" | "desktop"

export const MiB = 1_024 * 1_024

export interface CacheLayerBudget {
  maxBytes: number
  maxEntries: number
  maxAgeMs: number
}

export interface ReaderCacheBudget {
  tier: CacheTier
  l1: CacheLayerBudget
  l2: CacheLayerBudget
  l3: CacheLayerBudget
  /** 刚离开的页/章节在 L1 中的保护期，便于反向快速命中。 */
  departureProtectionMs: number
  /** 资源加载并发上限；移动 2、桌面 4 是实测起点。 */
  concurrency: number
}

export const READER_CACHE_BUDGETS: Record<CacheTier, ReaderCacheBudget> = {
  mobile: {
    tier: "mobile",
    l1: {
      maxBytes: 32 * MiB,
      maxEntries: 160,
      maxAgeMs: 10 * 60_000,
    },
    l2: {
      maxBytes: 64 * MiB,
      maxEntries: 16,
      maxAgeMs: 5 * 60_000,
    },
    l3: {
      maxBytes: 256 * MiB,
      maxEntries: 1_200,
      maxAgeMs: 30 * 24 * 60 * 60_000,
    },
    departureProtectionMs: 15_000,
    concurrency: 2,
  },
  desktop: {
    tier: "desktop",
    l1: {
      maxBytes: 96 * MiB,
      maxEntries: 480,
      maxAgeMs: 10 * 60_000,
    },
    l2: {
      maxBytes: 192 * MiB,
      maxEntries: 48,
      maxAgeMs: 5 * 60_000,
    },
    l3: {
      maxBytes: 1_024 * MiB,
      maxEntries: 6_000,
      maxAgeMs: 30 * 24 * 60 * 60_000,
    },
    departureProtectionMs: 30_000,
    concurrency: 4,
  },
}

export function cacheBudgetForTier(tier: CacheTier): ReaderCacheBudget {
  return READER_CACHE_BUDGETS[tier]
}

export function selectCacheTier(input: {
  mobile?: boolean
  deviceMemoryGb?: number
  maxTouchPoints?: number
}): CacheTier {
  if (input.mobile === true) {
    return "mobile"
  }
  if (
    input.deviceMemoryGb !== undefined &&
    Number.isFinite(input.deviceMemoryGb) &&
    input.deviceMemoryGb <= 4
  ) {
    return "mobile"
  }
  if (
    input.maxTouchPoints !== undefined &&
    input.maxTouchPoints > 1 &&
    input.deviceMemoryGb === undefined
  ) {
    // 触屏平板没有 deviceMemory 时按移动档位保守起步。
    return "mobile"
  }
  return "desktop"
}

/**
 * 只在浏览器中做一次粗粒度档位判断；调用方仍可显式覆盖。
 * 不把 UA 当作能力证明，仅用于预算默认值。
 */
export function detectCacheTier(): CacheTier {
  if (typeof window === "undefined") {
    return "desktop"
  }
  const navigatorWithMemory = navigator as Navigator & {
    deviceMemory?: number
  }
  const mobile =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 767px)").matches
  return selectCacheTier({
    mobile,
    deviceMemoryGb: navigatorWithMemory.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
  })
}

export const PRELOAD_PROFILES = ["saver", "balanced", "fast"] as const
export type PreloadProfile = (typeof PRELOAD_PROFILES)[number]

export interface PrefetchWindow {
  before: number
  after: number
}

/**
 * 节省 1/1、均衡 2/4、极速 3/6 只是候选窗口。
 * 实际预取还要受方向、速度、可见优先级和取消约束。
 */
export const PRELOAD_WINDOWS: Record<PreloadProfile, PrefetchWindow> = {
  saver: { before: 1, after: 1 },
  balanced: { before: 2, after: 4 },
  fast: { before: 3, after: 6 },
}

export const MAX_PREFETCH_UNITS = 8
export const FAST_SCROLL_VELOCITY = 1.5

export type ReaderTravelDirection = "forward" | "backward" | "stationary"

export interface PrefetchWindowInput {
  direction?: ReaderTravelDirection
  /** 有符号逻辑单位/秒；绝对值只用于判断快速滚动。 */
  velocity?: number
}

/**
 * 方向/速度只调整候选窗口，不扩大持久下载范围。
 * 快速向前时把前向候选加 1、反向同理；静止时回到档位默认值。
 */
export function resolvePrefetchWindow(
  profile: PreloadProfile,
  input: PrefetchWindowInput = {},
): PrefetchWindow {
  const base = PRELOAD_WINDOWS[profile]
  const direction = input.direction ?? "stationary"
  if (direction === "stationary") {
    return { ...base }
  }
  const fast =
    Math.abs(input.velocity ?? 0) >= FAST_SCROLL_VELOCITY
  if (!fast) {
    return { ...base }
  }
  if (direction === "forward") {
    return {
      before: Math.max(1, base.before - 1),
      after: Math.min(MAX_PREFETCH_UNITS, base.after + 1),
    }
  }
  return {
    before: Math.min(MAX_PREFETCH_UNITS, base.before + 1),
    after: Math.max(1, base.after - 1),
  }
}

/** 可见资源附近的候选键；供调度器 cancelObsolete/prefetch 使用。 */
export function prefetchKeysAround(
  orderedKeys: ResourceKey[],
  currentIndex: number,
  window: PrefetchWindow,
): ResourceKey[] {
  if (orderedKeys.length === 0) {
    return []
  }
  const start = Math.max(0, currentIndex - window.before)
  const end = Math.min(
    orderedKeys.length - 1,
    currentIndex + window.after,
  )
  return orderedKeys.slice(start, end + 1)
}
