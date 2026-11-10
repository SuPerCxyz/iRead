import { useEffect, useRef } from "react"
import { useLocation } from "react-router-dom"

import { useSidebar } from "@/components/ui/sidebar"

export function useSidebarFocusReturn() {
  const { isMobile, openMobile } = useSidebar()
  const location = useLocation()
  const wasOpen = useRef(false)
  const pathWhenOpened = useRef(location.pathname)

  useEffect(() => {
    if (!isMobile) {
      wasOpen.current = false
      return
    }

    if (openMobile) {
      wasOpen.current = true
      pathWhenOpened.current = location.pathname
      return
    }

    if (!wasOpen.current) {
      return
    }
    wasOpen.current = false

    if (pathWhenOpened.current !== location.pathname) {
      return
    }

    let cancelled = false
    let frames = 0
    let focusTimer: number | null = null

    const focusTrigger = () => {
      if (cancelled) {
        return
      }
      if (document.querySelector('[data-mobile="true"]') === null) {
        focusTimer = window.setTimeout(() => {
          if (cancelled) {
            return
          }
          document
            .querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')
            ?.focus()
        }, 50)
        return
      }
      frames += 1
      if (frames < 60) {
        window.requestAnimationFrame(focusTrigger)
      }
    }

    const frame = window.requestAnimationFrame(focusTrigger)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      if (focusTimer !== null) {
        window.clearTimeout(focusTimer)
      }
    }
  }, [isMobile, location.pathname, openMobile])
}
