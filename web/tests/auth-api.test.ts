import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError, clearCsrfToken, setCsrfToken } from "../src/lib/api"
import {
  getAuthStatus,
  isSetupTokenInvalidError,
  setupAdmin,
} from "../src/features/auth/api"
import { validateSetupToken } from "../src/features/auth/model"

const SETUP_URL = "/api/v1/auth/setup"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function statusPayload(setupTokenRequired?: unknown): unknown {
  const data: Record<string, unknown> = {
    initialized: false,
    authenticated: false,
    csrfToken: "csrf-status",
    csrfExpiresAt: null,
  }
  if (setupTokenRequired !== undefined) {
    data.setupTokenRequired = setupTokenRequired
  }
  return { data }
}

beforeEach(() => {
  clearCsrfToken()
})

afterEach(() => {
  clearCsrfToken()
  vi.unstubAllGlobals()
})

describe("auth status setup token flag", () => {
  it("reads setupTokenRequired=true from the status response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(statusPayload(true))),
    )

    await expect(getAuthStatus()).resolves.toMatchObject({
      setupTokenRequired: true,
    })
  })

  it("defaults to false when an older backend omits the field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(statusPayload())),
    )

    await expect(getAuthStatus()).resolves.toMatchObject({
      setupTokenRequired: false,
    })
  })

  it("does not treat non-boolean values as requiring a setup token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(statusPayload("true"))),
    )

    await expect(getAuthStatus()).resolves.toMatchObject({
      setupTokenRequired: false,
    })
  })
})

describe("setup request body", () => {
  it("submits the installation token only when provided", async () => {
    setCsrfToken("csrf-1")
    const bodies: unknown[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(SETUP_URL)
        bodies.push(JSON.parse(String(init?.body)))
        return jsonResponse(
          {
            data: {
              initialized: true,
              authenticated: true,
              csrfToken: "csrf-next",
              csrfExpiresAt: null,
              setupTokenRequired: true,
            },
          },
          201,
        )
      }),
    )

    await setupAdmin("admin-password", "install-token")
    await setupAdmin("admin-password")

    expect(bodies).toEqual([
      { password: "admin-password", setupToken: "install-token" },
      { password: "admin-password" },
    ])
  })

  it("recognizes setup_token_invalid only for 403 forbidden", () => {
    const invalid = new ApiError(403, "forbidden", "安装令牌无效", "req-1", {
      reason: "setup_token_invalid",
    })
    const csrf = new ApiError(403, "forbidden", "CSRF", "req-2", {
      reason: "csrf_invalid",
    })
    const badRequest = new ApiError(400, "invalid_request", "bad", "req-3", {
      reason: "setup_token_invalid",
    })

    expect(isSetupTokenInvalidError(invalid)).toBe(true)
    expect(isSetupTokenInvalidError(csrf)).toBe(false)
    expect(isSetupTokenInvalidError(badRequest)).toBe(false)
    expect(isSetupTokenInvalidError(new Error("network"))).toBe(false)
  })
})

describe("setup token validation", () => {
  it("requires a non-empty value", () => {
    expect(validateSetupToken("")).toBe("请输入安装令牌。")
    expect(validateSetupToken("token")).toBeNull()
  })
})
