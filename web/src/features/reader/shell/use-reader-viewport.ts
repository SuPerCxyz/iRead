import { useEffect, useState } from "react"
import type { RefObject } from "react"

import type { ReaderViewportMetrics } from "./engine"

const ZERO_METRICS: ReaderViewportMetrics = {
  width: 0,
  height: 0,
  visualWidth: 0,
  visualHeight: 0,
  offsetTop: 0,
  offsetLeft: 0,
  scale: 1,
  devicePixelRatio: 1,
}

function sameMetrics(
  left: ReaderViewportMetrics,
  right: ReaderViewportMetrics,
): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.visualWidth === right.visualWidth &&
    left.visualHeight === right.visualHeight &&
    left.offsetTop === right.offsetTop &&
    left.offsetLeft === right.offsetLeft &&
    left.scale === right.scale
  )
}

/**
 * 监听实际阅读区域的 Rect 与 visualViewport。
 * 度量结果用于手势区域和引擎视口通知，不写入内联样式。
 */
export function useReaderViewport(
  ref: RefObject<HTMLElement | null>,
): ReaderViewportMetrics {
  const [metrics, setMetrics] = useState<ReaderViewportMetrics>(ZERO_METRICS)

  useEffect(() => {
    const node = ref.current
    if (node === null) {
      return
    }
    let frame: number | null = null

    const measure = () => {
      frame = null
      const rect = node.getBoundingClientRect()
      const viewport = window.visualViewport
      const next: ReaderViewportMetrics = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visualWidth: Math.round(viewport?.width ?? window.innerWidth),
        visualHeight: Math.round(viewport?.height ?? window.innerHeight),
        offsetTop: Math.round(viewport?.offsetTop ?? 0),
        offsetLeft: Math.round(viewport?.offsetLeft ?? 0),
        scale: viewport?.scale ?? 1,
        devicePixelRatio: window.devicePixelRatio || 1,
      }
      setMetrics((current) => (sameMetrics(current, next) ? current : next))
    }

    const schedule = () => {
      if (frame === null) {
        frame = window.requestAnimationFrame(measure)
      }
    }

    schedule()
    const observer = new ResizeObserver(schedule)
    observer.observe(node)
    window.addEventListener("resize", schedule)
    const viewport = window.visualViewport
    viewport?.addEventListener("resize", schedule)
    viewport?.addEventListener("scroll", schedule)

    return () => {
      observer.disconnect()
      window.removeEventListener("resize", schedule)
      viewport?.removeEventListener("resize", schedule)
      viewport?.removeEventListener("scroll", schedule)
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [ref])

  return metrics
}
