import { describe, expect, it, vi } from "vitest"

import {
  MiB,
  PRELOAD_WINDOWS,
  READER_CACHE_BUDGETS,
  resolvePrefetchWindow,
  selectCacheTier,
} from "../src/features/reader/cache/budgets"
import {
  DEVICE_PREFERENCES_STORAGE_KEY,
  parseDevicePreferences,
  readDevicePreloadProfile,
  resetSessionPreloadProfile,
  subscribeDevicePreloadProfile,
  writeDevicePreloadProfile,
} from "../src/features/reader/cache/device-preferences"
import { LruCache } from "../src/features/reader/cache/lru"
import { ReaderMemoryCache } from "../src/features/reader/cache/memory-cache"
import {
  comicPageKey,
  epubChapterKey,
  parseResourceKeyId,
  pdfRangeKey,
  renderKeyId,
  resourceKeyId,
  sameResourceKey,
  validateResourceKey,
} from "../src/features/reader/cache/resource-key"
import { ReaderRenderCache } from "../src/features/reader/cache/render-cache"
import {
  clearTrackedReaderCaches,
  trackedReaderCacheCounts,
} from "../src/features/reader/cache/registry"

function fakeClock(start = 1_000): {
  now: () => number
  advance: (ms: number) => void
} {
  let value = start
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
    },
  }
}

describe("LruCache", () => {
  it("evicts the least recently used entry when over the object budget", () => {
    const clock = fakeClock()
    const cache = new LruCache<string, number>({
      maxBytes: 1_000,
      maxEntries: 2,
      sizeOf: () => 1,
      now: clock.now,
    })
    cache.set("a", 1)
    cache.set("b", 2)
    expect(cache.get("a")).toBe(1)
    cache.set("c", 3)
    expect(cache.get("b")).toBeNull()
    expect(cache.get("a")).toBe(1)
    expect(cache.get("c")).toBe(3)
    expect(cache.stats().evictions).toBe(1)
  })

  it("honors the byte budget and calls onEvict", () => {
    const evicted: string[] = []
    const cache = new LruCache<string, string>({
      maxBytes: 10,
      maxEntries: 10,
      sizeOf: (value) => value.length,
      onEvict: (entry, reason) => {
        evicted.push(`${entry.key}:${reason}`)
      },
    })
    cache.set("a", "12345")
    cache.set("b", "67890")
    cache.set("c", "xyz")
    expect(evicted).toEqual(["a:lru"])
    expect(cache.stats().bytes).toBe(8)
  })

  it("expires entries by maxAgeMs and counts expirations", () => {
    const clock = fakeClock()
    const cache = new LruCache<string, string>({
      maxBytes: 100,
      maxEntries: 10,
      maxAgeMs: 50,
      sizeOf: (value) => value.length,
      now: clock.now,
    })
    cache.set("a", "x")
    clock.advance(51)
    expect(cache.get("a")).toBeNull()
    const stats = cache.stats()
    expect(stats.expirations).toBe(1)
    expect(stats.misses).toBe(1)
  })

  it("protects recently left entries until the protection expires", () => {
    const clock = fakeClock()
    const cache = new LruCache<string, number>({
      maxBytes: 100,
      maxEntries: 1,
      sizeOf: () => 1,
      now: clock.now,
    })
    cache.set("old", 1)
    cache.protect("old", 1_000)
    cache.set("new", 2)
    expect(cache.get("old")).toBe(1)
    expect(cache.get("new")).toBeNull()
    clock.advance(1_001)
    cache.set("newer", 3)
    expect(cache.get("old")).toBeNull()
    expect(cache.get("newer")).toBe(3)
    expect(cache.stats().entries).toBe(1)
  })

  it("replaces values and releases the old one", () => {
    const onEvict = vi.fn()
    const cache = new LruCache<string, string>({
      maxBytes: 100,
      maxEntries: 10,
      sizeOf: (value) => value.length,
      onEvict,
    })
    cache.set("a", "one")
    cache.set("a", "two")
    expect(cache.get("a")).toBe("two")
    expect(onEvict).toHaveBeenCalledWith(
      expect.objectContaining({ key: "a", value: "one" }),
      "replace",
    )
  })
})

describe("ReaderMemoryCache and ReaderRenderCache", () => {
  it("sizes Blob/ArrayBuffer/string entries and enforces a custom budget", () => {
    const cache = new ReaderMemoryCache({
      tier: "mobile",
      budget: {
        maxBytes: 20,
        maxEntries: 10,
        maxAgeMs: 60_000,
      },
    })
    cache.set("a", new Uint8Array([1, 2, 3]))
    cache.set("b", "abcd")
    cache.set("c", new Blob([new Uint8Array(5)]))
    const stats = cache.stats
    expect(stats.tier).toBe("mobile")
    expect(stats.bytes).toBe(12)
    expect(stats.entries).toBe(3)
  })

  it("releases render entries on eviction and clear", () => {
    const released: string[] = []
    const cache = new ReaderRenderCache<{ id: string }>({
      maxBytes: 100,
      maxEntries: 2,
      maxAgeMs: 60_000,
    })
    const release = (value: { id: string }): void => {
      released.push(value.id)
    }
    cache.register("a", { id: "a" }, { bytes: 10, release })
    cache.register("b", { id: "b" }, { bytes: 10, release })
    cache.register("c", { id: "c" }, { bytes: 10, release })
    expect(released).toEqual(["a"])
    cache.clear()
    expect(released.sort()).toEqual(["a", "b", "c"])
    expect(cache.stats.releases).toBe(3)
  })

  it("releases a single render key explicitly", () => {
    const release = vi.fn()
    const cache = new ReaderRenderCache<string>()
    cache.register("canvas:1", "bitmap", { bytes: 1, release })
    expect(cache.release("canvas:1")).toBe(true)
    expect(release).toHaveBeenCalledWith("bitmap")
    expect(cache.get("canvas:1")).toBeNull()
    cache.dispose()
  })

  it("tracks active L1/L2 caches for logout clearing", () => {
    const before = trackedReaderCacheCounts()
    const memory = new ReaderMemoryCache("mobile")
    const render = new ReaderRenderCache<string>("mobile")
    memory.set("key", new Blob(["data"]))
    render.register("render-key", "value", { bytes: 1 })
    const after = trackedReaderCacheCounts()
    expect(after.memory).toBeGreaterThanOrEqual(before.memory + 1)
    expect(after.render).toBeGreaterThanOrEqual(before.render + 1)

    expect(clearTrackedReaderCaches()).toEqual([])
    expect(memory.keys()).toEqual([])
    expect(render.get("render-key")).toBeNull()

    memory.dispose()
    render.dispose()
    const disposed = trackedReaderCacheCounts()
    expect(disposed.memory).toBeLessThanOrEqual(after.memory - 1)
    expect(disposed.render).toBeLessThanOrEqual(after.render - 1)
  })
})

describe("resource keys", () => {
  it("produces stable keys independent of object property order", () => {
    const a = epubChapterKey("book-1", "f".repeat(64), "abc123", "a/b.xhtml")
    const b = {
      derivation: "a/b.xhtml",
      resourceId: "abc123",
      kind: "epub-chapter" as const,
      fileVersion: "f".repeat(64),
      bookId: "book-1",
    }
    expect(resourceKeyId(a)).toBe(resourceKeyId(b))
    expect(sameResourceKey(a, b)).toBe(true)
    expect(parseResourceKeyId(resourceKeyId(a))).toEqual(a)
  })

  it("separates ranges, variants and derivation versions", () => {
    const base = pdfRangeKey("book", "v", 0, 65_535)
    const next = pdfRangeKey("book", "v", 65_536, 131_071)
    expect(resourceKeyId(base)).not.toBe(resourceKeyId(next))
    expect(
      resourceKeyId(comicPageKey("book", "v", "r1", "screen")),
    ).not.toBe(
      resourceKeyId(comicPageKey("book", "v", "r1", "original")),
    )
    expect(() =>
      validateResourceKey({
        bookId: "book",
        fileVersion: "v",
        kind: "pdf-range",
        resourceId: "bad",
        range: { start: 10, end: 5 },
      }),
    ).toThrow()
  })

  it("includes styleRevision/viewport/zoom/rotation in render keys", () => {
    const resource = epubChapterKey("book", "v", "r1")
    const base = {
      resource,
      styleRevision: "style-1",
      viewport: { width: 390, height: 844 },
      zoom: 1,
    }
    expect(renderKeyId(base)).toBe(renderKeyId({ ...base }))
    expect(
      renderKeyId({ ...base, styleRevision: "style-2" }),
    ).not.toBe(renderKeyId(base))
    expect(renderKeyId({ ...base, zoom: 1.5 })).not.toBe(
      renderKeyId(base),
    )
    expect(
      renderKeyId({ ...base, rotation: 90 }),
    ).not.toBe(renderKeyId(base))
  })
})

describe("cache budgets and device preferences", () => {
  it("keeps mobile/desktop budgets and dynamic windows separate", () => {
    expect(READER_CACHE_BUDGETS.mobile.l1.maxBytes).toBeLessThan(
      READER_CACHE_BUDGETS.desktop.l1.maxBytes,
    )
    expect(READER_CACHE_BUDGETS.mobile.concurrency).toBe(2)
    expect(PRELOAD_WINDOWS.balanced).toEqual({ before: 2, after: 4 })
    expect(
      resolvePrefetchWindow("balanced", {
        direction: "forward",
        velocity: 2,
      }),
    ).toEqual({ before: 1, after: 5 })
    expect(
      resolvePrefetchWindow("balanced", {
        direction: "backward",
        velocity: 2,
      }),
    ).toEqual({ before: 3, after: 3 })
    expect(resolvePrefetchWindow("saver")).toEqual({
      before: 1,
      after: 1,
    })
    expect(
      selectCacheTier({ mobile: false, deviceMemoryGb: 2 }),
    ).toBe("mobile")
    expect(selectCacheTier({ mobile: false, deviceMemoryGb: 8 })).toBe(
      "desktop",
    )
  })

  it("persists only the device preload profile and degrades in memory", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    resetSessionPreloadProfile()
    const result = writeDevicePreloadProfile("fast", storage)
    expect(result).toEqual({
      ok: true,
      profile: "fast",
      persisted: true,
    })
    expect(
      JSON.parse(
        values.get(DEVICE_PREFERENCES_STORAGE_KEY) ?? "{}",
      ),
    ).toEqual({ schemaVersion: 1, preloadProfile: "fast" })
    expect(readDevicePreloadProfile(storage)).toBe("fast")

    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded")
      },
    }
    const failed = writeDevicePreloadProfile("saver", failing)
    expect(failed.persisted).toBe(false)
    expect(failed.profile).toBe("saver")
    expect(readDevicePreloadProfile(failing)).toBe("saver")
  })

  it("rejects malformed preferences and follows storage events", () => {
    expect(parseDevicePreferences("not-json")).toBeNull()
    expect(
      parseDevicePreferences(
        JSON.stringify({ schemaVersion: 1, preloadProfile: "turbo" }),
      ),
    ).toBeNull()
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (
        type: string,
        listener: (event: Event) => void,
      ) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    const seen: string[] = []
    const unsubscribe = subscribeDevicePreloadProfile(
      (profile) => seen.push(profile),
      target,
    )
    listeners.get("storage")?.({
      key: DEVICE_PREFERENCES_STORAGE_KEY,
      newValue: JSON.stringify({
        schemaVersion: 1,
        preloadProfile: "saver",
      }),
    } as StorageEvent)
    expect(seen).toEqual(["saver"])
    unsubscribe()
    expect(listeners.has("storage")).toBe(false)
  })

  it("documents raw byte budgets in MiB without hiding scale", () => {
    expect(MiB).toBe(1024 * 1024)
    expect(READER_CACHE_BUDGETS.desktop.l3.maxBytes).toBe(1024 * MiB)
  })
})
