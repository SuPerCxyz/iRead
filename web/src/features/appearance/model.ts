import { evaluateCustomAccent } from "./color"

export const THEME_MODES = ["system", "light", "dark"] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export const LIGHT_PRESETS = ["template", "paper", "white"] as const
export type LightPreset = (typeof LIGHT_PRESETS)[number]

export const DARK_PRESETS = ["template", "gray", "midnight"] as const
export type DarkPreset = (typeof DARK_PRESETS)[number]

export const ACCENT_PRESETS = ["default", "blue", "green"] as const
export type AccentPreset = (typeof ACCENT_PRESETS)[number]
export type AppearanceAccent = AccentPreset | `#${string}`

export const DENSITIES = ["compact", "standard", "relaxed"] as const
export type Density = (typeof DENSITIES)[number]

export type ContentWidth = "auto" | number

export interface AppearanceValue {
  themeMode: ThemeMode
  lightPreset: LightPreset
  darkPreset: DarkPreset
  accent: AppearanceAccent
  density: Density
  contentWidth: ContentWidth
  navCompact: boolean
}

export type AppearanceField = keyof AppearanceValue | "value"

export interface AppearanceFieldError {
  field: AppearanceField
  message: string
}

export type AppearanceValidationResult =
  | { ok: true; value: AppearanceValue }
  | { ok: false; errors: AppearanceFieldError[] }

export const DEFAULT_APPEARANCE: AppearanceValue = {
  themeMode: "system",
  lightPreset: "template",
  darkPreset: "template",
  accent: "default",
  density: "standard",
  contentWidth: "auto",
  navCompact: false,
}

const APPEARANCE_KEYS = Object.keys(DEFAULT_APPEARANCE) as Array<
  keyof AppearanceValue
>

const HEX_ACCENT_PATTERN = /^#[0-9a-f]{6}$/

export function isHexAccent(value: string): value is `#${string}` {
  return HEX_ACCENT_PATTERN.test(value)
}

export function isAccentPreset(value: string): value is AccentPreset {
  return (ACCENT_PRESETS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validateAppearanceValue(
  input: unknown,
): AppearanceValidationResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ field: "value", message: "外观设置必须是对象。" }],
    }
  }

  const errors: AppearanceFieldError[] = []
  const presentKeys = new Set(Object.keys(input))

  for (const key of APPEARANCE_KEYS) {
    if (!presentKeys.has(key)) {
      errors.push({ field: key, message: "缺少必填字段。" })
    }
  }

  for (const key of presentKeys) {
    if (!APPEARANCE_KEYS.includes(key as keyof AppearanceValue)) {
      errors.push({ field: "value", message: `未知字段：${key}` })
    }
  }

  const themeMode = input.themeMode
  if (
    typeof themeMode !== "string" ||
    !(THEME_MODES as readonly string[]).includes(themeMode)
  ) {
    errors.push({ field: "themeMode", message: "主题模式无效。" })
  }

  const lightPreset = input.lightPreset
  if (
    typeof lightPreset !== "string" ||
    !(LIGHT_PRESETS as readonly string[]).includes(lightPreset)
  ) {
    errors.push({ field: "lightPreset", message: "浅色预设无效。" })
  }

  const darkPreset = input.darkPreset
  if (
    typeof darkPreset !== "string" ||
    !(DARK_PRESETS as readonly string[]).includes(darkPreset)
  ) {
    errors.push({ field: "darkPreset", message: "深色预设无效。" })
  }

  const accent = input.accent
  if (
    typeof accent !== "string" ||
    (!isAccentPreset(accent) && !isHexAccent(accent))
  ) {
    errors.push({
      field: "accent",
      message: "强调色必须是官方预设或小写十六进制颜色。",
    })
  } else if (isHexAccent(accent)) {
    const contrast = evaluateCustomAccent(accent)
    if (!contrast.ok) {
      errors.push({ field: "accent", message: contrast.message })
    }
  }

  const density = input.density
  if (
    typeof density !== "string" ||
    !(DENSITIES as readonly string[]).includes(density)
  ) {
    errors.push({ field: "density", message: "密度无效。" })
  }

  const contentWidth = input.contentWidth
  if (
    contentWidth !== "auto" &&
    !(
      typeof contentWidth === "number" &&
      Number.isInteger(contentWidth) &&
      contentWidth >= 50 &&
      contentWidth <= 100
    )
  ) {
    errors.push({
      field: "contentWidth",
      message: "内容宽度必须是 auto 或 50–100 之间的整数。",
    })
  }

  if (typeof input.navCompact !== "boolean") {
    errors.push({ field: "navCompact", message: "导航紧凑度必须是布尔值。" })
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      themeMode: themeMode as ThemeMode,
      lightPreset: lightPreset as LightPreset,
      darkPreset: darkPreset as DarkPreset,
      accent: accent as AppearanceAccent,
      density: density as Density,
      contentWidth: contentWidth as ContentWidth,
      navCompact: navCompactValue(input.navCompact),
    },
  }
}

function navCompactValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : false
}

export type AppearanceButtonSize = "sm" | "default" | "lg"

export function buttonSizeForDensity(
  density: Density,
): AppearanceButtonSize {
  if (density === "compact") {
    return "sm"
  }
  if (density === "relaxed") {
    return "lg"
  }
  return "default"
}

export function resolveThemeMode(
  themeMode: ThemeMode,
  prefersDark: boolean,
): "light" | "dark" {
  if (themeMode === "system") {
    return prefersDark ? "dark" : "light"
  }
  return themeMode
}

export function copyDefaultAppearance(): AppearanceValue {
  return { ...DEFAULT_APPEARANCE }
}
