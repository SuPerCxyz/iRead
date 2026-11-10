import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const cacheMocks = vi.hoisted(() => ({
  clearReadableContentOnLogout: vi.fn<() => Promise<{ ok: boolean }>>(),
}))

vi.mock("@/features/reader/cache/cache-admin", () => ({
  clearReadableContentOnLogout: cacheMocks.clearReadableContentOnLogout,
}))

type CleanupModule = typeof import("../src/features/auth/session-cleanup")

let cleanup: CleanupModule

beforeEach(async () => {
  vi.resetModules()
  cacheMocks.clearReadableContentOnLogout.mockReset()
  cacheMocks.clearReadableContentOnLogout.mockResolvedValue({ ok: true })
  cleanup = await import("../src/features/auth/session-cleanup")
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("runLogoutCleanup", () => {
  it("clears readable content and skips progress when no sync is registered", async () => {
    const result = await cleanup.runLogoutCleanup()

    expect(cacheMocks.clearReadableContentOnLogout).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      contentCache: "cleared",
      progress: "skipped",
    })
  })

  it("suspends the registered progress sync without clearing the outbox", async () => {
    const suspendForLogout = vi.fn(async () => undefined)
    cleanup.registerLogoutProgressSync({ suspendForLogout })

    const result = await cleanup.runLogoutCleanup()

    expect(suspendForLogout).toHaveBeenCalledTimes(1)
    expect(cacheMocks.clearReadableContentOnLogout).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      contentCache: "cleared",
      progress: "suspended",
    })
  })

  it("skips progress after the active sync is unregistered", async () => {
    const suspendForLogout = vi.fn(async () => undefined)
    const unregister = cleanup.registerLogoutProgressSync({
      suspendForLogout,
    })
    unregister()

    const result = await cleanup.runLogoutCleanup()

    expect(suspendForLogout).not.toHaveBeenCalled()
    expect(result.progress).toBe("skipped")
  })

  it("keeps the latest registration and ignores stale unregister calls", async () => {
    const first = { suspendForLogout: vi.fn(async () => undefined) }
    const second = { suspendForLogout: vi.fn(async () => undefined) }
    const unregisterFirst = cleanup.registerLogoutProgressSync(first)
    cleanup.registerLogoutProgressSync(second)
    unregisterFirst()

    await cleanup.runLogoutCleanup()

    expect(first.suspendForLogout).not.toHaveBeenCalled()
    expect(second.suspendForLogout).toHaveBeenCalledTimes(1)
  })

  it("does not reject when cache cleanup fails and still suspends progress", async () => {
    cacheMocks.clearReadableContentOnLogout.mockRejectedValueOnce(
      new Error("cache unavailable"),
    )
    const suspendForLogout = vi.fn(async () => undefined)
    cleanup.registerLogoutProgressSync({ suspendForLogout })

    const result = await cleanup.runLogoutCleanup()

    expect(result).toEqual({
      contentCache: "failed",
      progress: "suspended",
    })
    expect(suspendForLogout).toHaveBeenCalledTimes(1)
  })

  it("marks partial cache failures without rejecting logout", async () => {
    cacheMocks.clearReadableContentOnLogout.mockResolvedValueOnce({
      ok: false,
    })
    const suspendForLogout = vi.fn(async () => undefined)
    cleanup.registerLogoutProgressSync({ suspendForLogout })

    await expect(cleanup.runLogoutCleanup()).resolves.toEqual({
      contentCache: "failed",
      progress: "suspended",
    })
    expect(suspendForLogout).toHaveBeenCalledTimes(1)
  })

  it("does not reject when progress suspension fails and still clears cache", async () => {
    const suspendForLogout = vi.fn(async () => {
      throw new Error("progress locked")
    })
    cleanup.registerLogoutProgressSync({ suspendForLogout })

    const result = await cleanup.runLogoutCleanup()

    expect(result).toEqual({
      contentCache: "cleared",
      progress: "failed",
    })
    expect(cacheMocks.clearReadableContentOnLogout).toHaveBeenCalledTimes(1)
  })

  it("resolves when both cleanup paths fail", async () => {
    cacheMocks.clearReadableContentOnLogout.mockRejectedValueOnce(
      new Error("cache unavailable"),
    )
    cleanup.registerLogoutProgressSync({
      suspendForLogout: async () => {
        throw new Error("progress locked")
      },
    })

    await expect(cleanup.runLogoutCleanup()).resolves.toEqual({
      contentCache: "failed",
      progress: "failed",
    })
  })

  it("shares one cleanup between concurrent 401 and explicit logout", async () => {
    const deferred: { resolve?: () => void } = {}
    cacheMocks.clearReadableContentOnLogout.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          deferred.resolve = () => resolve({ ok: true })
        }),
    )

    const first = cleanup.runLogoutCleanup()
    const second = cleanup.runLogoutCleanup()
    expect(second).toBe(first)
    await vi.waitFor(() => {
      expect(
        cacheMocks.clearReadableContentOnLogout,
      ).toHaveBeenCalledTimes(1)
      expect(deferred.resolve).toBeTypeOf("function")
    })

    deferred.resolve?.()
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ contentCache: "cleared", progress: "skipped" })
    expect(b).toBe(a)

    // 完成后再次退出应重新执行清理，而不是复用已完成的结果。
    await cleanup.runLogoutCleanup()
    expect(cacheMocks.clearReadableContentOnLogout).toHaveBeenCalledTimes(2)
  })
})
