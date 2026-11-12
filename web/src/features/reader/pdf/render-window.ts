/**
 * PDF 虚拟渲染窗口的纯逻辑。
 *
 * visible 是当前视口真正覆盖的页；prefetch 是前后方向的候选页；retain
 * 是两者合并后的活动窗口，供“页面是否仍值得继续渲染”的判断使用。
 * 真正保留多少张画布由像素预算决定，不在这里展开。
 */

export interface PdfPrefetchWindow {
  before: number
  after: number
}

export interface PdfRenderWindowInput {
  visible: readonly number[]
  pageCount: number
  coarse: boolean
}

export interface PdfRenderWindow {
  visible: number[]
  prefetch: number[]
  retain: number[]
}

/** 桌面：前向 6 页、后向 2 页。 */
export const PDF_DESKTOP_PREFETCH: PdfPrefetchWindow = {
  before: 2,
  after: 6,
}

/** 移动：前向 4 页、后向 1 页。 */
export const PDF_MOBILE_PREFETCH: PdfPrefetchWindow = {
  before: 1,
  after: 4,
}

export function pdfPrefetchWindowFor(coarse: boolean): PdfPrefetchWindow {
  return coarse ? PDF_MOBILE_PREFETCH : PDF_DESKTOP_PREFETCH
}

function normalizePage(value: number, pageCount: number): number | null {
  if (!Number.isFinite(value)) {
    return null
  }
  const page = Math.floor(value)
  if (page < 1 || page > pageCount) {
    return null
  }
  return page
}

/**
 * 计算渲染窗口。visible 会去重、排序并丢弃越界页；prefetch 在可见页
 * 前后展开，按到可见范围的距离排序，同距离时前向页优先。
 */
export function computePdfRenderWindow(
  input: PdfRenderWindowInput,
  prefetch: PdfPrefetchWindow = pdfPrefetchWindowFor(input.coarse),
): PdfRenderWindow {
  const pageCount =
    Number.isSafeInteger(input.pageCount) && input.pageCount > 0
      ? input.pageCount
      : 0
  if (pageCount === 0) {
    return { visible: [], prefetch: [], retain: [] }
  }

  const visible = [
    ...new Set(
      input.visible
        .map((page) => normalizePage(page, pageCount))
        .filter((page): page is number => page !== null),
    ),
  ].sort((left, right) => left - right)
  if (visible.length === 0) {
    return { visible: [], prefetch: [], retain: [] }
  }

  const before = Math.max(0, Math.floor(prefetch.before))
  const after = Math.max(0, Math.floor(prefetch.after))
  const firstVisible = visible[0]
  const lastVisible = visible[visible.length - 1]
  const visibleSet = new Set(visible)
  const prefetchPages: number[] = []
  const start = Math.max(1, firstVisible - before)
  const end = Math.min(pageCount, lastVisible + after)
  for (let page = start; page <= end; page += 1) {
    if (!visibleSet.has(page)) {
      prefetchPages.push(page)
    }
  }

  const distance = (page: number): number => {
    if (page < firstVisible) {
      return firstVisible - page
    }
    if (page > lastVisible) {
      return page - lastVisible
    }
    return 0
  }
  const forward = (page: number): boolean => page > lastVisible
  prefetchPages.sort((left, right) => {
    const distanceDelta = distance(left) - distance(right)
    if (distanceDelta !== 0) {
      return distanceDelta
    }
    if (forward(left) !== forward(right)) {
      return forward(left) ? -1 : 1
    }
    return left - right
  })

  return {
    visible,
    prefetch: prefetchPages,
    retain: [...visible, ...prefetchPages].sort((left, right) => left - right),
  }
}
