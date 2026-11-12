import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  apiGet,
  apiPatch,
  apiPut,
  clearCsrfToken,
  setCsrfToken,
  subscribeUnauthorized,
  type ApiError,
} from "../src/lib/api"

const STATUS_URL = "/api/v1/auth/status"
const APPEARANCE_URL = "/api/v1/settings/appearance"

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  })
}

function authStatus(token: string, authenticated = true): Response {
  return jsonResponse({
    data: {
      initialized: true,
      authenticated,
      csrfToken: token,
      csrfExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    },
  })
}

function callHeaders(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>
}

beforeEach(() => {
  clearCsrfToken()
})

afterEach(() => {
  clearCsrfToken()
  vi.unstubAllGlobals()
})

describe("api client", () => {
  it("returns the data envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { ok: true } })),
    )
    await expect(apiGet<{ ok: boolean }>("/api/v1/example")).resolves.toEqual({
      ok: true,
    })
  })

  it("maps error envelopes to ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "not_found",
              message: "没有找到",
              requestId: "req-1",
              details: { field: "bookId" },
            },
          },
          404,
          { "X-Request-Id": "header-id" },
        ),
      ),
    )

    await expect(apiGet("/api/v1/books/x")).rejects.toMatchObject<
      Partial<ApiError>
    >({
      name: "ApiError",
      status: 404,
      code: "not_found",
      message: "没有找到",
      requestId: "req-1",
      details: { field: "bookId" },
    })
  })

  it("maps network failures to a stable error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      }),
    )

    await expect(apiGet("/api/v1/example")).rejects.toMatchObject<
      Partial<ApiError>
    >({
      status: 0,
      code: "network_error",
    })
  })

  it("sends PATCH with JSON body and CSRF token", async () => {
    setCsrfToken("csrf-patch")
    let observedMethod: string | null = null
    let observedToken: string | null = null
    let observedBody: BodyInit | null | undefined = null
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedMethod = init?.method ?? null
        observedToken = callHeaders(init)["X-CSRF-Token"] ?? null
        observedBody = init?.body ?? null
        return jsonResponse({ data: { title: "新书名" } })
      }),
    )

    await expect(
      apiPatch<{ title: string }>("/api/v1/books/book-1", {
        title: "新书名",
      }),
    ).resolves.toEqual({ title: "新书名" })
    expect(observedMethod).toBe("PATCH")
    expect(observedToken).toBe("csrf-patch")
    expect(observedBody).toBe(JSON.stringify({ title: "新书名" }))
  })

  it("retries a CSRF failure once with a refreshed token", async () => {
    setCsrfToken("csrf-1")
    let putCount = 0
    let statusCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith(STATUS_URL)) {
        statusCount += 1
        return authStatus(`csrf-${statusCount + 1}`)
      }
      if (url.endsWith(APPEARANCE_URL)) {
        putCount += 1
        const headers = callHeaders(init)
        if (putCount === 1) {
          expect(headers["X-CSRF-Token"]).toBe("csrf-1")
          return jsonResponse(
            {
              error: {
                code: "forbidden",
                message: "安全校验失败",
                requestId: "req-csrf",
                details: { reason: "csrf_invalid" },
              },
            },
            403,
          )
        }
        expect(headers["X-CSRF-Token"]).toBe("csrf-2")
        return jsonResponse({ data: { saved: true } })
      }
      throw new Error(`unexpected url ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      apiPut<{ saved: boolean }>(APPEARANCE_URL, { value: 1 }),
    ).resolves.toEqual({ saved: true })

    expect(putCount).toBe(2)
    expect(statusCount).toBe(1)
  })

  it("does not retry non-CSRF 403 responses", async () => {
    setCsrfToken("csrf-1")
    let putCount = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        putCount += 1
        return jsonResponse(
          {
            error: {
              code: "invalid_origin",
              message: "来源不受信任",
              requestId: "req-origin",
              details: {},
            },
          },
          403,
        )
      }),
    )

    await expect(
      apiPut(APPEARANCE_URL, { value: 1 }),
    ).rejects.toMatchObject<Partial<ApiError>>({
      status: 403,
      code: "invalid_origin",
    })
    expect(putCount).toBe(1)
  })

  it("notifies subscribers and clears the token on 401", async () => {
    setCsrfToken("csrf-1")
    const listener = vi.fn()
    const unsubscribe = subscribeUnauthorized(listener)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "unauthenticated",
              message: "需要登录",
              requestId: "req-auth",
              details: {},
            },
          },
          401,
        ),
      ),
    )

    await expect(apiGet(APPEARANCE_URL)).rejects.toMatchObject<
      Partial<ApiError>
    >({ status: 401, code: "unauthenticated" })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("treats a successful non-JSON response as a protocol error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    )
    await expect(apiGet("/api/v1/example")).rejects.toMatchObject<
      Partial<ApiError>
    >({
      status: 0,
      code: "protocol_error",
    })
  })
})
