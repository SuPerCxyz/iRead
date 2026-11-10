import { describe, expect, it } from "vitest"

import { ApiError } from "../src/lib/api"
import {
  librarySettingsConflict,
  librarySettingsFieldError,
} from "../src/features/library/settings/api"
import {
  DEFAULT_LIBRARY_VIEW,
  parseLibraryViewRecord,
  validateLibraryViewValue,
} from "../src/features/library/settings/model"

const RECORD = {
  schemaVersion: 1,
  revision: "4",
  updatedAt: "2026-11-10T00:00:00Z",
  value: DEFAULT_LIBRARY_VIEW,
}

describe("library view settings model", () => {
  it("accepts the complete default value and record", () => {
    expect(validateLibraryViewValue(DEFAULT_LIBRARY_VIEW)).toEqual(
      DEFAULT_LIBRARY_VIEW,
    )
    expect(parseLibraryViewRecord(RECORD)).toEqual(RECORD)
  })

  it("rejects unknown, missing and out-of-range fields", () => {
    expect(
      validateLibraryViewValue({
        ...DEFAULT_LIBRARY_VIEW,
        extra: true,
      }),
    ).toBeNull()
    const missing: Record<string, unknown> = { ...DEFAULT_LIBRARY_VIEW }
    delete missing.showSubtitle
    expect(validateLibraryViewValue(missing)).toBeNull()
    expect(
      validateLibraryViewValue({ ...DEFAULT_LIBRARY_VIEW, columns: 1 }),
    ).toBeNull()
    expect(
      validateLibraryViewValue({ ...DEFAULT_LIBRARY_VIEW, columns: 2.5 }),
    ).toBeNull()
    expect(
      validateLibraryViewValue({ ...DEFAULT_LIBRARY_VIEW, coverRatio: "1:1" }),
    ).toBeNull()
  })

  it("rejects malformed revisions and timestamps", () => {
    expect(
      parseLibraryViewRecord({ ...RECORD, revision: "01" }),
    ).toBeNull()
    expect(
      parseLibraryViewRecord({ ...RECORD, updatedAt: "not-a-time" }),
    ).toBeNull()
  })
})

describe("library settings errors", () => {
  it("extracts the current record from a 409 conflict", () => {
    const error = new ApiError(
      409,
      "revision_conflict",
      "书库设置已在另一处更新",
      "",
      { current: { ...RECORD, revision: "5" } },
    )
    const conflict = librarySettingsConflict(error)
    expect(conflict?.revision).toBe("5")
    expect(
      librarySettingsConflict(
        new ApiError(409, "state_conflict", "冲突", "", {}),
      ),
    ).toBeNull()
  })

  it("extracts a field error from a 422 response", () => {
    const error = new ApiError(
      422,
      "invalid_request",
      "columns 仅支持 auto 或 2–8 的整数",
      "",
      { field: "columns" },
    )
    expect(librarySettingsFieldError(error)).toEqual({
      field: "columns",
      message: "columns 仅支持 auto 或 2–8 的整数",
    })
    expect(
      librarySettingsFieldError(
        new ApiError(500, "internal_error", "失败", "", {}),
      ),
    ).toBeNull()
  })
})
