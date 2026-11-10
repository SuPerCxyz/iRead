import {
  PRELOAD_PROFILES,
  type PreloadProfile,
} from "./budgets"

/**
 * 设备预加载档位只写本机 localStorage，按 origin/浏览器存储分区生效；
 * 不进入 app_settings.reader、BookReaderOverrides 或跨端同步。
 */
export const DEVICE_PREFERENCES_STORAGE_KEY = "iread.device-preferences.v1"

export interface DevicePreferences {
  schemaVersion: 1
  preloadProfile: PreloadProfile
}

export interface DevicePreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface DevicePreferenceWriteResult {
  ok: boolean
  profile: PreloadProfile
  /** false 时表示只在当前会话内存生效，调用方应提示“档位仅本次会话生效”。 */
  persisted: boolean
  error?: string
}

let sessionProfile: PreloadProfile = "balanced"

function isPreloadProfile(value: unknown): value is PreloadProfile {
  return (
    typeof value === "string" &&
    (PRELOAD_PROFILES as readonly string[]).includes(value)
  )
}

export function parseDevicePreferences(
  raw: string | null,
): DevicePreferences | null {
  if (raw === null) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null
  }
  const record = parsed as Record<string, unknown>
  if (
    record.schemaVersion !== 1 ||
    !isPreloadProfile(record.preloadProfile)
  ) {
    return null
  }
  return {
    schemaVersion: 1,
    preloadProfile: record.preloadProfile,
  }
}

function defaultStorage(): DevicePreferenceStorage | null {
  if (typeof window === "undefined") {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** 读取档位；损坏/不可读都回退到当前会话档位（默认 balanced）。 */
export function readDevicePreloadProfile(
  storage: DevicePreferenceStorage | null = defaultStorage(),
): PreloadProfile {
  if (storage === null) {
    return sessionProfile
  }
  try {
    const parsed = parseDevicePreferences(
      storage.getItem(DEVICE_PREFERENCES_STORAGE_KEY),
    )
    if (parsed !== null) {
      sessionProfile = parsed.preloadProfile
    }
  } catch {
    // 私密模式或存储被禁用时保持会话内选择。
  }
  return sessionProfile
}

/**
 * 写入档位。存储失败不抛异常：内存继续当前选择，
 * 返回 persisted=false 供 UI 提示“档位仅本次会话生效”。
 */
export function writeDevicePreloadProfile(
  profile: PreloadProfile,
  storage: DevicePreferenceStorage | null = defaultStorage(),
): DevicePreferenceWriteResult {
  sessionProfile = profile
  if (storage === null) {
    return {
      ok: false,
      profile,
      persisted: false,
      error: "本机存储不可用",
    }
  }
  try {
    storage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, preloadProfile: profile }),
    )
    return { ok: true, profile, persisted: true }
  } catch (error) {
    return {
      ok: false,
      profile,
      persisted: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 同分区标签通过 storage 事件更新档位；改档位只调整当前候选预取，
 * 不重置阅读位置。返回取消订阅函数。
 */
export function subscribeDevicePreloadProfile(
  listener: (profile: PreloadProfile) => void,
  target: Pick<Window, "addEventListener" | "removeEventListener"> | null =
    typeof window === "undefined" ? null : window,
): () => void {
  if (target === null) {
    return () => undefined
  }
  const handler = (event: Event): void => {
    const storageEvent = event as StorageEvent
    if (storageEvent.key !== DEVICE_PREFERENCES_STORAGE_KEY) {
      return
    }
    const parsed = parseDevicePreferences(storageEvent.newValue)
    if (parsed === null) {
      return
    }
    sessionProfile = parsed.preloadProfile
    listener(parsed.preloadProfile)
  }
  target.addEventListener("storage", handler)
  return () => {
    target.removeEventListener("storage", handler)
  }
}

/** 仅供测试或“恢复默认”操作重置模块内会话档位。 */
export function resetSessionPreloadProfile(): void {
  sessionProfile = "balanced"
}
