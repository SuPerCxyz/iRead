/**
 * 已渲染 PDF 页的 canvas 像素预算。
 *
 * 只负责记账与淘汰顺序：真正释放 canvas、page.cleanup() 由引擎执行。
 * visible 页必须由调用方放进 protectedPages，预算不会淘汰它们；即使
 * 保护页本身已超预算，也只会停止继续淘汰并报告实际像素数。
 */

export const DESKTOP_CANVAS_PIXEL_BUDGET = 40_000_000
export const MOBILE_CANVAS_PIXEL_BUDGET = 12_000_000

export interface CanvasPixelEntry {
  pageNumber: number
  pixels: number
  lastUsed: number
}

interface CanvasPixelRecord {
  pixels: number
  lastUsed: number
}

export class CanvasPixelBudget {
  #maxPixels: number
  #totalPixels = 0
  #useSeq = 0
  readonly #entries = new Map<number, CanvasPixelRecord>()

  constructor(maxPixels: number) {
    this.#maxPixels = Math.max(0, Math.floor(maxPixels))
  }

  get maxPixels(): number {
    return this.#maxPixels
  }

  get totalPixels(): number {
    return this.#totalPixels
  }

  get size(): number {
    return this.#entries.size
  }

  setMaxPixels(maxPixels: number): void {
    this.#maxPixels = Math.max(0, Math.floor(maxPixels))
  }

  /** 记录/更新一页的像素数，并把它标记为最近使用。 */
  touch(pageNumber: number, pixels: number): void {
    const nextPixels = Math.max(0, Math.floor(pixels))
    const previous = this.#entries.get(pageNumber)
    if (previous !== undefined) {
      this.#totalPixels -= previous.pixels
    }
    this.#entries.set(pageNumber, {
      pixels: nextPixels,
      lastUsed: ++this.#useSeq,
    })
    this.#totalPixels += nextPixels
  }

  remove(pageNumber: number): void {
    const entry = this.#entries.get(pageNumber)
    if (entry === undefined) {
      return
    }
    this.#entries.delete(pageNumber)
    this.#totalPixels -= entry.pixels
  }

  clear(): void {
    this.#entries.clear()
    this.#totalPixels = 0
    this.#useSeq = 0
  }

  has(pageNumber: number): boolean {
    return this.#entries.has(pageNumber)
  }

  pixelsFor(pageNumber: number): number {
    return this.#entries.get(pageNumber)?.pixels ?? 0
  }

  /**
   * 按 lastUsed 从旧到新淘汰，直到回到预算内。
   * @returns 被淘汰的页码；调用方负责释放对应 canvas。
   */
  evict(protectedPages: ReadonlySet<number> | readonly number[] = []): number[] {
    if (this.#totalPixels <= this.#maxPixels) {
      return []
    }
    const protectedSet =
      protectedPages instanceof Set ? protectedPages : new Set(protectedPages)
    const candidates = [...this.#entries.entries()]
      .filter(([pageNumber]) => !protectedSet.has(pageNumber))
      .sort(
        ([leftPage, left], [rightPage, right]) =>
          left.lastUsed - right.lastUsed || leftPage - rightPage,
      )
    const evicted: number[] = []
    for (const [pageNumber, entry] of candidates) {
      if (this.#totalPixels <= this.#maxPixels) {
        break
      }
      this.#entries.delete(pageNumber)
      this.#totalPixels -= entry.pixels
      evicted.push(pageNumber)
    }
    return evicted
  }

  /** 测试/诊断用快照，按 lastUsed 从旧到新排列。 */
  snapshot(): CanvasPixelEntry[] {
    return [...this.#entries.entries()]
      .map(([pageNumber, entry]) => ({
        pageNumber,
        pixels: entry.pixels,
        lastUsed: entry.lastUsed,
      }))
      .sort(
        (left, right) =>
          left.lastUsed - right.lastUsed || left.pageNumber - right.pageNumber,
      )
  }
}
