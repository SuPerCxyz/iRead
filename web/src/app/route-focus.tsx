import { useEffect, useRef } from "react"
import { useLocation } from "react-router-dom"

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false
  }
  if (element.isContentEditable) {
    return true
  }
  return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
}

export function RouteFocus() {
  const location = useLocation()
  const lastKey = useRef(location.key)

  useEffect(() => {
    if (lastKey.current === location.key) {
      return
    }
    lastKey.current = location.key

    if (isEditableElement(document.activeElement)) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>("[data-route-heading]")
      heading?.focus({ preventScroll: true })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [location.key])

  return null
}
