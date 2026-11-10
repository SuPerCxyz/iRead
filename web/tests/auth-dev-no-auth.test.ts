import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearCsrfToken } from "../src/lib/api"
import {
  getAuthStatus,
  type AuthStatus,
} from "../src/features/auth/api"
import {
  isDevNoAuthStatus,
  resolveAuthPhase,
} from "../src/features/auth/context"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function statusPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      initialized: true,
      authenticated: false,
      csrfToken: "dev-no-auth",
      csrfExpiresAt: null,
      setupTokenRequired: false,
      ...overrides,
    },
  }
}

function authStatus(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    initialized: true,
    authenticated: false,
    csrfToken: "csrf-token",
    csrfExpiresAt: null,
    setupTokenRequired: false,
    ...overrides,
  }
}

beforeEach(() => {
  clearCsrfToken()
})

afterEach(() => {
  clearCsrfToken()
  vi.unstubAllGlobals()
})

describe("devNoAuth status parsing", () => {
  it("reads devNoAuth=true from the status response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          statusPayload({
            devNoAuth: true,
            authenticated: true,
            initialized: true,
            csrfToken: "dev-no-auth",
          }),
        ),
      ),
    )

    await expect(getAuthStatus()).resolves.toMatchObject({
      devNoAuth: true,
      authenticated: true,
      initialized: true,
    })
  })

  it("defaults to false when an older backend omits the field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(statusPayload())),
    )

    await expect(getAuthStatus()).resolves.toMatchObject({
      devNoAuth: false,
    })
  })

  it("does not enable dev mode for non-boolean truthy values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(statusPayload({ devNoAuth: "true" })),
      ),
    )

    await expect(getAuthStatus()).resolves.toMatchObject({
      devNoAuth: false,
    })
  })
})

describe("devNoAuth auth phase", () => {
  it("enters authenticated directly even without a real session", () => {
    expect(
      resolveAuthPhase(
        authStatus({
          devNoAuth: true,
          authenticated: false,
          initialized: false,
        }),
      ),
    ).toBe("authenticated")
  })

  it("keeps setup/login behavior when devNoAuth is absent or false", () => {
    expect(
      resolveAuthPhase(authStatus({ initialized: false })),
    ).toBe("setup")
    expect(
      resolveAuthPhase(authStatus({ initialized: true })),
    ).toBe("login")
    expect(
      resolveAuthPhase(
        authStatus({ initialized: true, authenticated: true }),
      ),
    ).toBe("authenticated")
    expect(
      resolveAuthPhase(
        authStatus({ initialized: true, devNoAuth: false }),
      ),
    ).toBe("login")
  })

  it("recognizes only an explicit true status", () => {
    expect(isDevNoAuthStatus(null)).toBe(false)
    expect(isDevNoAuthStatus(authStatus())).toBe(false)
    expect(
      isDevNoAuthStatus(authStatus({ devNoAuth: true })),
    ).toBe(true)
  })
})
