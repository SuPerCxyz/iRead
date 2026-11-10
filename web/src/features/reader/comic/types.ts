import type { ReaderEngine, ReaderEngineResult } from "../shell/engine"
import type {
  ComicDirection,
  ComicFit,
  ComicMode,
  ReaderLocation,
} from "../types"
import type { ReaderCacheRuntime } from "../session/reader-cache-runtime"

export const COMIC_GAP_MODES = ["compact", "standard", "relaxed"] as const
export type ComicGapMode = (typeof COMIC_GAP_MODES)[number]

export const COMIC_BACKGROUND_MODES = [
  "inherit",
  "paper",
  "white",
  "gray",
  "midnight",
] as const
export type ComicBackgroundMode = (typeof COMIC_BACKGROUND_MODES)[number]

/** 与用户设置面板的官方 spacing 档位对齐；具体像素由集成层 CSS 决定。 */
export const COMIC_GAP_PIXELS: Record<ComicGapMode, number> = {
  compact: 4,
  standard: 12,
  relaxed: 24,
}

export interface ComicReaderSettings {
  direction: ComicDirection
  mode: ComicMode
  fit: ComicFit
  gap: ComicGapMode
  background: ComicBackgroundMode
}

export const DEFAULT_COMIC_SETTINGS: ComicReaderSettings = {
  direction: "ltr",
  mode: "single",
  fit: "screen",
  gap: "standard",
  background: "inherit",
}

export type ComicVariant = "screen" | "original"

/** original 变体仅当前页可用，且必须同时满足服务端页约束。 */
export const COMIC_MAX_ORIGINAL_BYTES = 64 << 20
export const COMIC_MAX_ORIGINAL_PIXELS = 32_000_000

export interface ComicReaderEngineOptions {
  /** 构造时语言无关的格式提示；mount 后以真实 manifest 为准。 */
  format?: "cbz" | "cbr"
  settings?: Partial<ComicReaderSettings>
  initialLocation?: ReaderLocation | null
  fetchImpl?: typeof fetch
  /** 宿主获得焦点时响应方向键；默认开启，与共享 Shell 的 window 监听去重。 */
  keyboardNavigation?: boolean
  /** 仅在独立挂载/未接 Shell 手势时开启；默认关闭以免双触发。 */
  tapNavigation?: boolean
  /** Shell 每本书创建的会话缓存运行时；省略时引擎直连网络。 */
  cache?: ReaderCacheRuntime | null
  onNavigateRequest?: (direction: "previous" | "next") => void
  onToggleToolbarsRequest?: () => void
}

export interface ComicReaderEngine extends ReaderEngine {
  getSettings(): ComicReaderSettings
  applySettings(patch: Partial<ComicReaderSettings>): ComicReaderSettings
  getLocation(): ReaderLocation | null
  retry(page?: number): Promise<ReaderEngineResult>
}

export class ComicReaderError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable = false, cause?: unknown) {
    super(message, { cause })
    this.name = "ComicReaderError"
    this.retryable = retryable
  }
}

export class ComicPageError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean

  constructor(
    code: string,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = "ComicPageError"
    this.code = code
    this.status = options.status ?? 0
    this.retryable = options.retryable ?? false
  }
}

export function isComicReaderError(error: unknown): error is ComicReaderError {
  return error instanceof ComicReaderError
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function includes<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

/** 只接受枚举值，null/未知字段不写回，也不把无效值静默降级为用户选择。 */
export function normalizeComicSettings(
  value: Partial<ComicReaderSettings> | Record<string, unknown> | null,
): ComicReaderSettings {
  if (value === null || !isRecord(value)) {
    return { ...DEFAULT_COMIC_SETTINGS }
  }
  return {
    direction: includes(["ltr", "rtl"] as const, value.direction)
      ? value.direction
      : DEFAULT_COMIC_SETTINGS.direction,
    mode: includes(["single", "double", "continuous"] as const, value.mode)
      ? value.mode
      : DEFAULT_COMIC_SETTINGS.mode,
    fit: includes(["screen", "width", "original"] as const, value.fit)
      ? value.fit
      : DEFAULT_COMIC_SETTINGS.fit,
    gap: includes(COMIC_GAP_MODES, value.gap)
      ? value.gap
      : DEFAULT_COMIC_SETTINGS.gap,
    background: includes(COMIC_BACKGROUND_MODES, value.background)
      ? value.background
      : DEFAULT_COMIC_SETTINGS.background,
  }
}

/** 从 settings envelope 的 effectiveValues 中读取 comic 分组。 */
export function comicSettingsFromEffective(
  value: unknown,
): Partial<ComicReaderSettings> | null {
  if (!isRecord(value)) {
    return null
  }
  const direct = isRecord(value.comic) ? value.comic : value
  const result: Partial<ComicReaderSettings> = {}
  if (includes(["ltr", "rtl"] as const, direct.direction)) {
    result.direction = direct.direction
  }
  if (includes(["single", "double", "continuous"] as const, direct.mode)) {
    result.mode = direct.mode
  }
  if (includes(["screen", "width", "original"] as const, direct.fit)) {
    result.fit = direct.fit
  }
  if (includes(COMIC_GAP_MODES, direct.gap)) {
    result.gap = direct.gap
  }
  if (includes(COMIC_BACKGROUND_MODES, direct.background)) {
    result.background = direct.background
  }
  return Object.keys(result).length === 0 ? null : result
}
