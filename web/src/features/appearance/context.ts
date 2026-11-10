import { createContext, useContext } from "react"

import type { AppearanceRecord } from "./api"
import type { AppearanceValue } from "./model"

export type AppearanceSaveStatus =
  | "saved"
  | "saving"
  | "pending"
  | "conflict"
  | "error"

export interface AppearanceContextValue {
  value: AppearanceValue
  prefersDark: boolean
  resolvedMode: "light" | "dark"
  update: (patch: Partial<AppearanceValue>) => void
  reset: () => void
  status: AppearanceSaveStatus
  statusText: string
  online: boolean
  storageUnavailable: boolean
  saveError: string | null
  loadError: string | null
  conflict: AppearanceRecord | null
  retry: () => void
  loadServerSettings: () => void
  keepLocalAndResave: () => void
}

export const AppearanceContext = createContext<AppearanceContextValue | null>(
  null,
)

export function useAppearance(): AppearanceContextValue {
  const context = useContext(AppearanceContext)
  if (context === null) {
    throw new Error("useAppearance 必须在 AppearanceProvider 内使用。")
  }
  return context
}
