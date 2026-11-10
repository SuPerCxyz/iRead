import { useLayoutEffect, useRef } from "react"
import { useLocation, useNavigationType } from "react-router-dom"

const STORAGE_KEY = "iread.scroll-positions.v1"

type ScrollPositions = Record<string, number>

function loadPositions(): ScrollPositions {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (raw === null) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "number"),
    )
  } catch {
    return {}
  }
}

function persistPositions(positions: ScrollPositions) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(positions))
  } catch {
    // 私密模式或存储配额不足时，滚动恢复降级为当前会话内存。
  }
}

function readRestoreScroll(state: unknown): number | null {
  if (typeof state !== "object" || state === null) {
    return null
  }
  const value = (state as Record<string, unknown>).restoreScroll
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return null
  }
  return value
}

export function ScrollRestoration() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const positions = useRef<ScrollPositions>(loadPositions())
  const activeKey = useRef(location.key)
  const frame = useRef<number | null>(null)

  useLayoutEffect(() => {
    window.history.scrollRestoration = "manual"
  }, [])

  useLayoutEffect(() => {
    const key = location.key
    const savedPositions = positions.current
    activeKey.current = key

    const onScroll = () => {
      if (frame.current !== null) {
        return
      }
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null
        savedPositions[activeKey.current] = window.scrollY
        persistPositions(savedPositions)
      })
    }

    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      window.removeEventListener("scroll", onScroll)
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current)
        frame.current = null
      }
      savedPositions[key] = window.scrollY
      persistPositions(savedPositions)
    }
  }, [location.key])

  useLayoutEffect(() => {
    const requested = readRestoreScroll(location.state)
    const saved = positions.current[location.key]
    const target =
      requested ?? (navigationType === "POP" ? saved : undefined)

    const restoreFrame = window.requestAnimationFrame(() => {
      if (target !== undefined) {
        window.scrollTo(0, target)
      } else if (navigationType !== "POP") {
        window.scrollTo(0, 0)
      }
    })

    return () => window.cancelAnimationFrame(restoreFrame)
  }, [location.key, location.state, navigationType])

  return null
}
