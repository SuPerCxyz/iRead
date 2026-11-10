import { afterEach, describe, expect, it, vi } from "vitest"

import { evaluateCustomAccent } from "../src/features/appearance/color"
import {
  AppearanceProtocolError,
  fetchAppearance,
} from "../src/features/appearance/api"
import {
  DEFAULT_APPEARANCE,
  buttonSizeForDensity,
  resolveThemeMode,
  validateAppearanceValue,
} from "../src/features/appearance/model"
import {
  compareRevisions,
  isOlderThanConfirmedRevision,
  reconcileAppearance,
} from "../src/features/appearance/reconcile"
import {
  APPEARANCE_STORAGE_KEY,
  readAppearanceMirror,
  writeAppearanceMirror,
  type AppearanceMirror,
} from "../src/features/appearance/storage"
import type { AppearanceRecord } from "../src/features/appearance/api"

function record(revision: string): AppearanceRecord {
  return {
    schemaVersion: 1,
    revision,
    updatedAt: null,
    value: { ...DEFAULT_APPEARANCE },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("appearance model", () => {
  it("accepts the contract default value", () => {
    const result = validateAppearanceValue(DEFAULT_APPEARANCE)
    expect(result.ok).toBe(true)
  })

  it("rejects unknown fields and missing fields", () => {
    const withUnknown = {
      ...DEFAULT_APPEARANCE,
      unknownField: true,
    }
    const unknownResult = validateAppearanceValue(withUnknown)
    expect(unknownResult.ok).toBe(false)

    const missing: Partial<typeof DEFAULT_APPEARANCE> = {
      ...DEFAULT_APPEARANCE,
    }
    delete missing.navCompact
    const missingResult = validateAppearanceValue(missing)
    expect(missingResult.ok).toBe(false)
  })

  it("rejects invalid enum, range and uppercase hex values", () => {
    expect(
      validateAppearanceValue({
        ...DEFAULT_APPEARANCE,
        themeMode: "sepia",
      }).ok,
    ).toBe(false)

    expect(
      validateAppearanceValue({
        ...DEFAULT_APPEARANCE,
        contentWidth: 49,
      }).ok,
    ).toBe(false)

    expect(
      validateAppearanceValue({
        ...DEFAULT_APPEARANCE,
        contentWidth: 50.5,
      }).ok,
    ).toBe(false)

    expect(
      validateAppearanceValue({
        ...DEFAULT_APPEARANCE,
        accent: "#AABBCC",
      }).ok,
    ).toBe(false)

    expect(
      validateAppearanceValue({
        ...DEFAULT_APPEARANCE,
        accent: "#ffffff",
      }).ok,
    ).toBe(false)
  })

  it("resolves system mode without writing state", () => {
    expect(resolveThemeMode("system", true)).toBe("dark")
    expect(resolveThemeMode("system", false)).toBe("light")
    expect(resolveThemeMode("light", true)).toBe("light")
    expect(resolveThemeMode("dark", false)).toBe("dark")
  })

  it("maps density to official button sizes", () => {
    expect(buttonSizeForDensity("compact")).toBe("sm")
    expect(buttonSizeForDensity("standard")).toBe("default")
    expect(buttonSizeForDensity("relaxed")).toBe("lg")
  })
})

describe("custom accent contrast", () => {
  it("accepts a color with enough ring and foreground contrast", () => {
    const result = evaluateCustomAccent("#2563eb")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.color).toBe("#2563eb")
      expect(result.foreground).toBe("#ffffff")
      expect(result.contrastOnWhite).toBeGreaterThanOrEqual(3)
      expect(result.contrastOnNearBlack).toBeGreaterThanOrEqual(3)
      expect(result.foregroundContrast).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("normalizes valid uppercase input", () => {
    const result = evaluateCustomAccent("#2563EB")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.color).toBe("#2563eb")
    }
  })

  it("rejects malformed and low-ring-contrast colors", () => {
    expect(evaluateCustomAccent("#12345").ok).toBe(false)
    expect(evaluateCustomAccent("#ffffff").ok).toBe(false)
    expect(evaluateCustomAccent("#000000").ok).toBe(false)
  })

  it("matches every server background, not only white and near-black", () => {
    // #5f5f5f 对 #18181b 只有 2.77:1，服务端会拒绝。
    expect(evaluateCustomAccent("#5f5f5f").ok).toBe(false)
    // #0000ff 对近黑背景不足 3:1。
    expect(evaluateCustomAccent("#0000ff").ok).toBe(false)
    // #16a34a 五组背景都 >=3，前景取更高对比度的黑色。
    const result = evaluateCustomAccent("#16a34a")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.foreground).toBe("#000000")
      expect(result.foregroundContrast).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe("appearance mirror", () => {
  it("round-trips record, pending and baseRevision", () => {
    const values = new Map<string, string>()
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value)
        },
      },
    })

    const mirror: AppearanceMirror = {
      record: record("7"),
      pending: {
        ...DEFAULT_APPEARANCE,
        themeMode: "dark",
        density: "compact",
      },
      baseRevision: "7",
      appliedCss: {
        "--primary": "#2563eb",
        "--iread-content-width": "60%",
      },
    }

    expect(writeAppearanceMirror(mirror)).toBe(true)
    expect(values.has(APPEARANCE_STORAGE_KEY)).toBe(true)
    expect(readAppearanceMirror()).toEqual(mirror)
  })

  it("accepts old mirrors without appliedCss and filters invalid CSS", () => {
    const values = new Map<string, string>()
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value)
        },
      },
    })

    values.set(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        record: null,
        pending: null,
        baseRevision: "0",
      }),
    )
    expect(readAppearanceMirror()?.appliedCss).toEqual({})

    values.set(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        record: null,
        pending: null,
        baseRevision: "0",
        appliedCss: {
          "--primary": "#2563eb",
          "--ring": "red",
          "--evil": "#ffffff",
          "--iread-content-width": "101%",
        },
      }),
    )
    expect(readAppearanceMirror()?.appliedCss).toEqual({
      "--primary": "#2563eb",
    })
  })

  it("ignores malformed or contract-invalid mirrors", () => {
    const values = new Map<string, string>()
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value)
        },
      },
    })

    values.set(APPEARANCE_STORAGE_KEY, "{not-json")
    expect(readAppearanceMirror()).toBeNull()

    values.set(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        record: null,
        pending: { ...DEFAULT_APPEARANCE, unknown: 1 },
        baseRevision: "0",
      }),
    )
    expect(readAppearanceMirror()).toBeNull()
  })
})

describe("appearance api errors", () => {
  it("treats a successful non-JSON response as a protocol error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    )
    await expect(fetchAppearance()).rejects.toBeInstanceOf(
      AppearanceProtocolError,
    )
  })

  it("treats a successful response without data as a protocol error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    )
    await expect(fetchAppearance()).rejects.toBeInstanceOf(
      AppearanceProtocolError,
    )
  })
})

describe("appearance reconciliation", () => {
  it("compares decimal revisions without number precision loss", () => {
    expect(compareRevisions("10", "9")).toBe(1)
    expect(compareRevisions("9", "10")).toBe(-1)
    expect(compareRevisions("0", "0")).toBe(0)
    expect(compareRevisions("9007199254740993", "9007199254740992")).toBe(1)
  })

  it("ignores an initial GET older than a session-confirmed PUT", () => {
    expect(isOlderThanConfirmedRevision("0", "5")).toBe(true)
    expect(isOlderThanConfirmedRevision("4", "5")).toBe(true)
    expect(isOlderThanConfirmedRevision("5", "5")).toBe(false)
    expect(isOlderThanConfirmedRevision("6", "5")).toBe(false)
    expect(isOlderThanConfirmedRevision("0", null)).toBe(false)
  })

  it("applies the server when there is no pending and server is not older", () => {
    const result = reconcileAppearance(record("2"), {
      record: record("1"),
      pending: null,
      baseRevision: "1",
      appliedCss: {},
    })
    expect(result.type).toBe("apply-server")
  })

  it("retries pending when the server still matches baseRevision", () => {
    const result = reconcileAppearance(record("3"), {
      record: record("3"),
      pending: { ...DEFAULT_APPEARANCE, density: "relaxed" },
      baseRevision: "3",
      appliedCss: {},
    })
    expect(result.type).toBe("retry")
  })

  it("opens conflict instead of overwriting a newer server revision", () => {
    const result = reconcileAppearance(record("4"), {
      record: record("3"),
      pending: { ...DEFAULT_APPEARANCE, density: "relaxed" },
      baseRevision: "3",
      appliedCss: {},
    })
    expect(result.type).toBe("conflict")
    if (result.type === "conflict") {
      expect(result.current.revision).toBe("4")
    }
  })

  it("restores a newer local record when the server is older", () => {
    const result = reconcileAppearance(record("4"), {
      record: record("9"),
      pending: null,
      baseRevision: "9",
      appliedCss: {},
    })
    expect(result.type).toBe("restore-local")
    if (result.type === "restore-local") {
      expect(result.baseRevision).toBe("4")
    }
  })
})
