import { useEffect, useState } from "react"

import type { ReaderProfile } from "../types"

export const READER_MOBILE_MAX_WIDTH = 767
export const READER_PROFILE_MEDIA_QUERY = `(max-width: ${READER_MOBILE_MAX_WIDTH}px)`
export const READER_PROFILE_RESIZE_DEBOUNCE_MS = 200

const MOBILE_MAX_WIDTH = READER_MOBILE_MAX_WIDTH

/** 视口宽度严格小于 768px 为 mobile，其余为 web。 */
export function readerProfileFromViewport(width: number): ReaderProfile {
  return Number.isFinite(width) && width <= MOBILE_MAX_WIDTH ? "mobile" : "web"
}

function currentProfile(): ReaderProfile {
  if (typeof window === "undefined") {
    return "web"
  }
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(READER_PROFILE_MEDIA_QUERY).matches
      ? "mobile"
      : "web"
  }
  return readerProfileFromViewport(window.innerWidth)
}

/**
 * 阅读窗口样式 profile。resize 合并 200ms 后只切换一次，
 * 避免拖动窗口时反复拉取/应用不同的 profile。
 */
export function useReaderProfile(): ReaderProfile {
  const [profile, setProfile] = useState<ReaderProfile>(currentProfile)

  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }
    let timer: number | null = null
    const update = () => {
      timer = null
      setProfile((previous) => {
        const next = currentProfile()
        return previous === next ? previous : next
      })
    }
    const schedule = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
      }
      timer = window.setTimeout(update, READER_PROFILE_RESIZE_DEBOUNCE_MS)
    }
    window.addEventListener("resize", schedule)
    return () => {
      window.removeEventListener("resize", schedule)
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [])

  return profile
}
