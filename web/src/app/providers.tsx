import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

import { AppearanceProvider } from "@/features/appearance/appearance-provider"
import { AuthProvider } from "@/features/auth/auth-provider"
import { QUERY_DEFAULTS } from "@/lib/query"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      ...QUERY_DEFAULTS,
    },
  },
})

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppearanceProvider>{children}</AppearanceProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
