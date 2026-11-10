import { isDecimalRevision, parseAppearanceRecord } from "./api"
import type { AppearanceRecord } from "./api"
import {
  sanitizeAppliedCss,
  type AppliedCss,
} from "./apply"
import {
  copyDefaultAppearance,
  validateAppearanceValue,
  type AppearanceValue,
} from "./model"

export const APPEARANCE_STORAGE_KEY = "iread.appearance.v1"

export interface AppearanceMirror {
  record: AppearanceRecord | null
  pending: AppearanceValue | null
  baseRevision: string
  appliedCss: AppliedCss
}

export function createEmptyMirror(): AppearanceMirror {
  return {
    record: null,
    pending: null,
    baseRevision: "0",
    appliedCss: {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readAppearanceMirror(): AppearanceMirror | null {
  if (typeof window === "undefined") {
    return null
  }

  let raw: string | null
  try {
    raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }

  let record: AppearanceRecord | null = null
  if (parsed.record !== null) {
    record = parseAppearanceRecord(parsed.record)
    if (record === null) {
      return null
    }
  }

  let pending: AppearanceValue | null = null
  if (parsed.pending !== null) {
    const value = validateAppearanceValue(parsed.pending)
    if (!value.ok) {
      return null
    }
    pending = value.value
  }

  if (
    typeof parsed.baseRevision !== "string" ||
    !isDecimalRevision(parsed.baseRevision)
  ) {
    return null
  }

  return {
    record,
    pending,
    baseRevision: parsed.baseRevision,
    appliedCss: sanitizeAppliedCss(parsed.appliedCss),
  }
}

export function writeAppearanceMirror(mirror: AppearanceMirror): boolean {
  if (typeof window === "undefined") {
    return false
  }
  try {
    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(mirror),
    )
    return true
  } catch {
    return false
  }
}

export function appearanceValueFromMirror(
  mirror: AppearanceMirror | null,
): AppearanceValue {
  if (mirror === null) {
    return copyDefaultAppearance()
  }
  return (
    mirror.pending ??
    mirror.record?.value ??
    copyDefaultAppearance()
  )
}
