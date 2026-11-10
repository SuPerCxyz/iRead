import {
  ApiError,
  apiGet,
  apiPut,
} from "@/lib/api"

import {
  validateAppearanceValue,
  type AppearanceValue,
} from "./model"

export const APPEARANCE_ENDPOINT = "/api/v1/settings/appearance"
export const APPEARANCE_QUERY_KEY = ["settings", "appearance"] as const

export interface AppearanceRecord {
  schemaVersion: 1
  revision: string
  updatedAt: string | null
  value: AppearanceValue
}

const DECIMAL_REVISION = /^(?:0|[1-9][0-9]*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isDecimalRevision(value: string): boolean {
  return DECIMAL_REVISION.test(value)
}

export function parseAppearanceRecord(input: unknown): AppearanceRecord | null {
  if (!isRecord(input)) {
    return null
  }
  if (input.schemaVersion !== 1) {
    return null
  }
  if (
    typeof input.revision !== "string" ||
    !DECIMAL_REVISION.test(input.revision)
  ) {
    return null
  }
  if (
    input.updatedAt !== null &&
    (typeof input.updatedAt !== "string" ||
      Number.isNaN(Date.parse(input.updatedAt)))
  ) {
    return null
  }
  const value = validateAppearanceValue(input.value)
  if (!value.ok) {
    return null
  }
  return {
    schemaVersion: 1,
    revision: input.revision,
    updatedAt: input.updatedAt,
    value: value.value,
  }
}

export class AppearanceRequestError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string
  readonly details: Record<string, unknown>

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string,
    details: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AppearanceRequestError"
    this.status = status
    this.code = code
    this.requestId = requestId
    this.details = details
  }
}

export class AppearanceNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AppearanceNetworkError"
  }
}

export class AppearanceProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AppearanceProtocolError"
  }
}

function toAppearanceError(error: unknown): unknown {
  if (!(error instanceof ApiError)) {
    return error
  }
  if (error.code === "network_error") {
    return new AppearanceNetworkError(error.message)
  }
  if (error.code === "protocol_error") {
    return new AppearanceProtocolError(error.message)
  }
  return new AppearanceRequestError(
    error.status,
    error.code,
    error.message,
    error.requestId,
    error.details,
  )
}

async function requestData(
  request: Promise<unknown>,
): Promise<unknown> {
  try {
    return await request
  } catch (error) {
    throw toAppearanceError(error)
  }
}

export async function fetchAppearance(
  signal?: AbortSignal,
): Promise<AppearanceRecord> {
  const data = await requestData(
    apiGet<unknown>(APPEARANCE_ENDPOINT, signal),
  )
  const record = parseAppearanceRecord(data)
  if (record === null) {
    throw new AppearanceProtocolError("服务器返回的外观设置格式无效。")
  }
  return record
}

export async function putAppearance(
  baseRevision: string,
  value: AppearanceValue,
): Promise<AppearanceRecord> {
  const data = await requestData(
    apiPut<unknown>(APPEARANCE_ENDPOINT, {
      schemaVersion: 1,
      baseRevision,
      value,
    }),
  )
  const record = parseAppearanceRecord(data)
  if (record === null) {
    throw new AppearanceProtocolError("服务器返回的外观设置格式无效。")
  }
  return record
}

export function conflictRecord(
  error: AppearanceRequestError,
): AppearanceRecord | null {
  if (error.status !== 409) {
    return null
  }
  return parseAppearanceRecord(error.details.current)
}
