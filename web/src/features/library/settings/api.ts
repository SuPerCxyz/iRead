import { ApiError, apiGet, apiPut } from "@/lib/api"

import {
  parseLibraryViewRecord,
  type LibraryViewRecord,
  type LibraryViewValue,
} from "./model"

export const LIBRARY_SETTINGS_ENDPOINT = "/api/v1/settings/library"
export const LIBRARY_SETTINGS_QUERY_KEY = ["settings", "library"] as const

export class LibrarySettingsProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LibrarySettingsProtocolError"
  }
}

export async function fetchLibrarySettings(
  signal?: AbortSignal,
): Promise<LibraryViewRecord> {
  const data = await apiGet<unknown>(LIBRARY_SETTINGS_ENDPOINT, signal)
  const record = parseLibraryViewRecord(data)
  if (record === null) {
    throw new LibrarySettingsProtocolError(
      "服务器返回的书库视图设置格式无效。",
    )
  }
  return record
}

export async function putLibrarySettings(
  baseRevision: string,
  value: LibraryViewValue,
): Promise<LibraryViewRecord> {
  const data = await apiPut<unknown>(LIBRARY_SETTINGS_ENDPOINT, {
    schemaVersion: 1,
    baseRevision,
    value,
  })
  const record = parseLibraryViewRecord(data)
  if (record === null) {
    throw new LibrarySettingsProtocolError(
      "服务器返回的书库视图设置格式无效。",
    )
  }
  return record
}

export function librarySettingsConflict(
  error: unknown,
): LibraryViewRecord | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null
  }
  return parseLibraryViewRecord(error.details.current)
}

export function librarySettingsFieldError(
  error: unknown,
): { field: string; message: string } | null {
  if (!(error instanceof ApiError) || error.status !== 422) {
    return null
  }
  const field = error.details.field
  if (typeof field !== "string" || field.length === 0) {
    return null
  }
  return {
    field,
    message: error.message || "书库视图设置值无效。",
  }
}
