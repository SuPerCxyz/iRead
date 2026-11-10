import { useEffect } from "react"

import { useAuth } from "@/features/auth/context"

import { shouldShowLogin } from "./errors"

export function useLoginOnAuthError(error: unknown): void {
  const { refresh } = useAuth()
  useEffect(() => {
    if (shouldShowLogin(error)) {
      void refresh()
    }
  }, [error, refresh])
}
