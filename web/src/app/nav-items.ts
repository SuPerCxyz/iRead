import { House, Library, Settings } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { normalizePathname } from "@/lib/path"

export interface AppNavItem {
  title: string
  url: string
  icon: LucideIcon
  isActive: (pathname: string) => boolean
}

export const APP_NAV_ITEMS: AppNavItem[] = [
  {
    title: "首页",
    url: "/",
    icon: House,
    isActive: (pathname) => normalizePathname(pathname) === "/",
  },
  {
    title: "书库",
    url: "/library",
    icon: Library,
    isActive: (pathname) => {
      const normalized = normalizePathname(pathname)
      return (
        normalized === "/library" || normalized.startsWith("/books/")
      )
    },
  },
  {
    title: "设置",
    url: "/settings",
    icon: Settings,
    isActive: (pathname) => normalizePathname(pathname) === "/settings",
  },
]
