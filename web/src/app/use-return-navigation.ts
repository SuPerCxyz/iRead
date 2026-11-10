import { useCallback } from "react"
import { useLocation, useNavigate } from "react-router-dom"

import { readSourceState, returnLabel } from "./navigation"

export function useReturnNavigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const source = readSourceState(location.state)
  const target = source?.from ?? "/library"
  const hasSource = source !== null

  const goBack = useCallback(() => {
    if (!hasSource) {
      // 直接深链接没有来源条目：替换当前条目，避免后退再次进入详情/阅读器。
      navigate("/library", { replace: true })
      return
    }
    navigate(-1)
  }, [hasSource, navigate])

  return {
    goBack,
    label: returnLabel(target),
  }
}
