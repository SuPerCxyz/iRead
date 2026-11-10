import { Fragment } from "react"
import { Link, useLocation } from "react-router-dom"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"

import { normalizePathname } from "@/lib/path"

interface Crumb {
  label: string
  to?: string
}

function buildCrumbs(pathname: string): Crumb[] {
  const path = normalizePathname(pathname)

  if (path === "/") {
    return [{ label: "首页" }]
  }

  if (path === "/library") {
    return [{ label: "首页", to: "/" }, { label: "书库" }]
  }

  if (path.startsWith("/books/")) {
    return [
      { label: "首页", to: "/" },
      { label: "书库", to: "/library" },
      { label: "书籍" },
    ]
  }

  if (path === "/settings") {
    return [{ label: "首页", to: "/" }, { label: "设置" }]
  }

  return [{ label: "首页", to: "/" }, { label: "页面不存在" }]
}

export function AppBreadcrumbs() {
  const location = useLocation()
  const crumbs = buildCrumbs(location.pathname)

  return (
    <Breadcrumb aria-label="面包屑">
      <BreadcrumbList>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1
          return (
            <Fragment key={`${crumb.label}-${index}`}>
              <BreadcrumbItem>
                {crumb.to === undefined ? (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={crumb.to}>{crumb.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {isLast ? null : <BreadcrumbSeparator />}
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
