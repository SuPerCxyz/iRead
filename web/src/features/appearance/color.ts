export interface RgbColor {
  r: number
  g: number
  b: number
}

export type CustomAccentEvaluation =
  | {
      ok: true
      color: `#${string}`
      foreground: string
      contrastOnWhite: number
      contrastOnNearBlack: number
      foregroundContrast: number
    }
  | { ok: false; message: string }

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/
const BLACK = "#000000"
const WHITE = "#ffffff"
const MIN_RING_CONTRAST = 3
const MIN_FOREGROUND_CONTRAST = 4.5

// 与服务端 settings.accentBackgrounds 保持完全一致。
const ACCENT_BACKGROUNDS = [
  "#ffffff",
  "#f5f5f4",
  "#0a0a0a",
  "#18181b",
  "#0f172a",
] as const

export function normalizeHex(value: string): string | null {
  if (!HEX_PATTERN.test(value)) {
    return null
  }
  return value.toLowerCase()
}

export function hexToRgb(value: string): RgbColor | null {
  const normalized = normalizeHex(value)
  if (normalized === null) {
    return null
  }

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  }
}

function channelToLinear(channel: number): number {
  const srgb = channel / 255
  return srgb <= 0.04045
    ? srgb / 12.92
    : ((srgb + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(color: RgbColor): number {
  return (
    0.2126 * channelToLinear(color.r) +
    0.7152 * channelToLinear(color.g) +
    0.0722 * channelToLinear(color.b)
  )
}

export function contrastRatio(first: RgbColor, second: RgbColor): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

export function evaluateCustomAccent(value: string): CustomAccentEvaluation {
  const color = normalizeHex(value)
  if (color === null) {
    return {
      ok: false,
      message: "请输入六位十六进制颜色，例如 #2563eb。",
    }
  }

  const rgb = hexToRgb(color)
  const white = hexToRgb(WHITE)
  const nearBlack = hexToRgb("#0a0a0a")
  const black = hexToRgb(BLACK)

  if (rgb === null || white === null || nearBlack === null || black === null) {
    return {
      ok: false,
      message: "无法解析颜色。",
    }
  }

  let closestBackground: string = ACCENT_BACKGROUNDS[0]
  let closestRatio = Number.POSITIVE_INFINITY

  for (const background of ACCENT_BACKGROUNDS) {
    const backgroundRgb = hexToRgb(background)
    if (backgroundRgb === null) {
      return { ok: false, message: "无法解析背景色。" }
    }
    const ratio = contrastRatio(rgb, backgroundRgb)
    if (ratio < closestRatio) {
      closestRatio = ratio
      closestBackground = background
    }
    if (ratio < MIN_RING_CONTRAST) {
      return {
        ok: false,
        message: `强调色与背景 ${background} 的对比度只有 ${ratio.toFixed(2)}:1，至少需要 ${MIN_RING_CONTRAST}:1。`,
      }
    }
  }

  const contrastOnWhite = contrastRatio(rgb, white)
  const contrastOnNearBlack = contrastRatio(rgb, nearBlack)
  const contrastWithBlack = contrastRatio(rgb, black)
  const contrastWithWhite = contrastOnWhite
  const useBlack = contrastWithBlack >= contrastWithWhite
  const foreground = useBlack ? BLACK : WHITE
  const foregroundContrast = useBlack ? contrastWithBlack : contrastWithWhite

  if (foregroundContrast < MIN_FOREGROUND_CONTRAST) {
    return {
      ok: false,
      message: `强调色上的文字对比度只有 ${foregroundContrast.toFixed(2)}:1（最接近的背景 ${closestBackground} 为 ${closestRatio.toFixed(2)}:1），至少需要 ${MIN_FOREGROUND_CONTRAST}:1。`,
    }
  }

  return {
    ok: true,
    color: color as `#${string}`,
    foreground,
    contrastOnWhite,
    contrastOnNearBlack,
    foregroundContrast,
  }
}
