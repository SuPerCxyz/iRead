import { evaluateCustomAccent } from "./color"
import {
  isAccentPreset,
  resolveThemeMode,
  type AppearanceValue,
} from "./model"

export const CUSTOM_ACCENT_VARIABLES = [
  "--primary",
  "--primary-foreground",
  "--ring",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-ring",
] as const

export const APPLIED_CSS_KEYS = [
  ...CUSTOM_ACCENT_VARIABLES,
  "--iread-content-width",
] as const

export type AppliedCssKey = (typeof APPLIED_CSS_KEYS)[number]
export type AppliedCss = Partial<Record<AppliedCssKey, string>>

const HEX_COLOR_PATTERN = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/
const CONTENT_WIDTH_PATTERN = /^(?:[5-9][0-9]|100)%$/

export function isAppliedCssValue(
  key: AppliedCssKey,
  value: string,
): boolean {
  if (key === "--iread-content-width") {
    return CONTENT_WIDTH_PATTERN.test(value)
  }
  return HEX_COLOR_PATTERN.test(value)
}

export function sanitizeAppliedCss(input: unknown): AppliedCss {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    return {}
  }
  const result: AppliedCss = {}
  for (const key of APPLIED_CSS_KEYS) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === "string" && isAppliedCssValue(key, value)) {
      result[key] = value
    }
  }
  return result
}

function clearCustomAccent(root: HTMLElement) {
  for (const variable of CUSTOM_ACCENT_VARIABLES) {
    root.style.removeProperty(variable)
  }
}

export function applyAppearance(
  root: HTMLElement,
  value: AppearanceValue,
  prefersDark: boolean,
): AppliedCss {
  const resolvedMode = resolveThemeMode(value.themeMode, prefersDark)
  const appliedCss: AppliedCss = {}

  root.classList.toggle("dark", resolvedMode === "dark")
  root.dataset.lightPreset = value.lightPreset
  root.dataset.darkPreset = value.darkPreset
  root.dataset.density = value.density
  root.dataset.navCompact = String(value.navCompact)

  clearCustomAccent(root)

  if (isAccentPreset(value.accent)) {
    root.dataset.accent = value.accent
  } else {
    delete root.dataset.accent
    const evaluation = evaluateCustomAccent(value.accent)
    if (evaluation.ok) {
      const variables: Array<[AppliedCssKey, string]> = [
        ["--primary", evaluation.color],
        ["--primary-foreground", evaluation.foreground],
        ["--ring", evaluation.color],
        ["--sidebar-primary", evaluation.color],
        ["--sidebar-primary-foreground", evaluation.foreground],
        ["--sidebar-ring", evaluation.color],
      ]
      for (const [variable, cssValue] of variables) {
        root.style.setProperty(variable, cssValue)
        appliedCss[variable] = cssValue
      }
    }
  }

  const contentWidth =
    value.contentWidth === "auto" ? "100%" : `${value.contentWidth}%`
  root.style.setProperty("--iread-content-width", contentWidth)
  appliedCss["--iread-content-width"] = contentWidth

  return appliedCss
}
