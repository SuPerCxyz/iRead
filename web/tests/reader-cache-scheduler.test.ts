import { describe, expect, it, vi } from "vitest"

import {
  ReaderResourceScheduler,
  ResourceCancelledError,
  ResourceStaleSessionError,
  isResourceCancellation,
  type ReaderResourceSchedulerEvent,
} from "../src/features/reader/session/resource-scheduler"
import {
  epubChapterKey,
  pdfRangeKey,
  type ResourceKey,
} from "../src/features/reader/cache/resource-key"

function key(index: number): ResourceKey {
  return epubChapterKey("book-1", "f".repeat(64), `chapter-${index}`)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("ReaderResourceScheduler", () => {
  it("merges in-flight requests with the same key", async () => {
    const scheduler = new ReaderResourceScheduler({ concurrency: 2 })
    const pending = deferred<string>()
    const loader = vi.fn(() => pending.promise)
    const first = scheduler.request(key(1), loader, {
      priority: "visible",
    })
    const second = scheduler.request(key(1), loader, {
      priority: "critical",
    })
    pending.resolve("payload")
    await expect(first).resolves.toBe("payload")
    await expect(second).resolves.toBe("payload")
    expect(loader).toHaveBeenCalledTimes(1)
    expect(scheduler.stats().deduped).toBe(1)
    expect(scheduler.stats().completed).toBe(1)
  })

  it("runs critical work before queued visible and prefetch work", async () => {
    const scheduler = new ReaderResourceScheduler({ concurrency: 1 })
    const started: string[] = []
    const gate = deferred<void>()
    const first = scheduler.request(
      key(0),
      async () => {
        started.push("active")
        await gate.promise
        return "active"
      },
      { priority: "visible" },
    )
    await flushMicrotasks()
    const prefetch = scheduler.request(
      key(1),
      async () => {
        started.push("prefetch")
        return "prefetch"
      },
      { priority: "prefetch" },
    )
    const visible = scheduler.request(
      key(2),
      async () => {
        started.push("visible")
        return "visible"
      },
      { priority: "visible" },
    )
    const critical = scheduler.request(
      key(3),
      async () => {
        started.push("critical")
        return "critical"
      },
      { priority: "critical" },
    )
    gate.resolve()
    await first
    await Promise.all([prefetch, visible, critical])
    expect(started).toEqual([
      "active",
      "critical",
      "visible",
      "prefetch",
    ])
  })

  it("preempts an active prefetch when a critical request arrives", async () => {
    const scheduler = new ReaderResourceScheduler({ concurrency: 1 })
    let aborted = false
    const prefetch = scheduler.request(
      key(1),
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true
              reject(new ResourceCancelledError("preempted"))
            },
            { once: true },
          )
        }),
      { priority: "prefetch" },
    )
    await flushMicrotasks()
    const critical = scheduler.request(
      key(2),
      async () => "critical",
      { priority: "critical" },
    )
    await expect(prefetch).rejects.toBeInstanceOf(
      ResourceCancelledError,
    )
    await expect(critical).resolves.toBe("critical")
    expect(aborted).toBe(true)
    expect(isResourceCancellation(await prefetch.catch((error) => error))).toBe(
      true,
    )
    expect(scheduler.stats().cancelled).toBe(1)
  })

  it("removes only the cancelled consumer while another remains", async () => {
    const scheduler = new ReaderResourceScheduler({ concurrency: 1 })
    const gate = deferred<string>()
    let underlyingAborted = false
    const loader = vi.fn((signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        underlyingAborted = true
      })
      return gate.promise
    })
    const firstController = new AbortController()
    const first = scheduler.request(key(1), loader, {
      signal: firstController.signal,
    })
    const second = scheduler.request(key(1), loader)
    await flushMicrotasks()
    firstController.abort()
    await expect(first).rejects.toBeInstanceOf(ResourceCancelledError)
    expect(underlyingAborted).toBe(false)
    gate.resolve("ok")
    await expect(second).resolves.toBe("ok")
    expect(scheduler.stats().cancelled).toBe(0)
  })

  it("aborts the underlying request when the last consumer leaves", async () => {
    const scheduler = new ReaderResourceScheduler({ concurrency: 1 })
    const controllerA = new AbortController()
    const controllerB = new AbortController()
    let underlyingAborted = false
    const loader = (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            underlyingAborted = true
            reject(new ResourceCancelledError("aborted"))
          },
          { once: true },
        )
      })
    const first = scheduler.request(key(1), loader, {
      signal: controllerA.signal,
    })
    const second = scheduler.request(key(1), loader, {
      signal: controllerB.signal,
    })
    await flushMicrotasks()
    controllerA.abort()
    controllerB.abort()
    await expect(first).rejects.toBeInstanceOf(ResourceCancelledError)
    await expect(second).rejects.toBeInstanceOf(ResourceCancelledError)
    expect(underlyingAborted).toBe(true)
    expect(scheduler.has(key(1))).toBe(false)
  })

  it("does not start a loader for an already-aborted consumer", async () => {
    const scheduler = new ReaderResourceScheduler()
    const controller = new AbortController()
    controller.abort()
    const loader = vi.fn(async () => "value")
    await expect(
      scheduler.request(key(9), loader, {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ResourceCancelledError)
    expect(loader).not.toHaveBeenCalled()
    expect(scheduler.stats().queued).toBe(0)
    expect(scheduler.stats().active).toBe(0)
  })

  it("cancels obsolete prefetch but keeps visible work", async () => {
    const scheduler = new ReaderResourceScheduler({ concurrency: 2 })
    const prefetchGate = deferred<string>()
    const visibleGate = deferred<string>()
    const prefetch = scheduler.request(
      key(1),
      () => prefetchGate.promise,
      { priority: "prefetch" },
    )
    const visible = scheduler.request(
      key(2),
      () => visibleGate.promise,
      { priority: "visible" },
    )
    await flushMicrotasks()
    const cancelled = scheduler.cancelObsolete([])
    expect(cancelled).toBe(1)
    await expect(prefetch).rejects.toBeInstanceOf(
      ResourceCancelledError,
    )
    visibleGate.resolve("visible")
    await expect(visible).resolves.toBe("visible")
  })

  it("rejects late results and future requests after dispose", async () => {
    const scheduler = new ReaderResourceScheduler({
      concurrency: 1,
      sessionGeneration: 7,
    })
    const gate = deferred<string>()
    const pending = scheduler.request(key(1), () => gate.promise)
    await flushMicrotasks()
    scheduler.dispose()
    await expect(pending).rejects.toBeInstanceOf(
      ResourceCancelledError,
    )
    gate.resolve("late")
    await flushMicrotasks()
    const events: ReaderResourceSchedulerEvent[] = []
    scheduler.subscribe((event) => events.push(event))
    await expect(
      scheduler.request(key(2), async () => "new"),
    ).rejects.toBeInstanceOf(ResourceStaleSessionError)
    expect(
      events.some((event) => event.type === "session-disposed"),
    ).toBe(false)
    expect(scheduler.sessionGeneration).toBe(8)
  })

  it("emits lifecycle events and can cancel all work", async () => {
    const events: ReaderResourceSchedulerEvent[] = []
    const scheduler = new ReaderResourceScheduler({
      concurrency: 2,
      onEvent: (event) => events.push(event),
    })
    const gate = deferred<string>()
    const pending = scheduler.request(key(1), () => gate.promise, {
      priority: "critical",
    })
    await flushMicrotasks()
    expect(events.map((event) => event.type)).toEqual([
      "queued",
      "started",
    ])
    expect(scheduler.cancelAll()).toBe(1)
    await expect(pending).rejects.toBeInstanceOf(
      ResourceCancelledError,
    )
    expect(events.at(-1)?.type).toBe("cancelled")
  })

  it("records cache hits for the performance panel", () => {
    const events: ReaderResourceSchedulerEvent[] = []
    const scheduler = new ReaderResourceScheduler({
      sessionGeneration: 3,
    })
    scheduler.subscribe((event) => events.push(event))
    scheduler.recordCacheHit(key(1), "L1")
    scheduler.recordCacheHit(key(2), "L3")
    expect(scheduler.stats().hits).toBe(2)
    expect(events).toEqual([
      expect.objectContaining({
        type: "hit",
        source: "L1",
        sessionGeneration: 3,
      }),
      expect.objectContaining({
        type: "hit",
        source: "L3",
      }),
    ])
    scheduler.dispose()
  })

  it("tracks PDF range keys separately", async () => {
    const scheduler = new ReaderResourceScheduler()
    const first = pdfRangeKey("book", "v", 0, 65_535)
    const second = pdfRangeKey("book", "v", 65_536, 131_071)
    expect(scheduler.has(first)).toBe(false)
    const result = await scheduler.request(first, async () => "chunk")
    expect(result).toBe("chunk")
    expect(scheduler.has(first)).toBe(false)
    expect(scheduler.has(second)).toBe(false)
  })
})
