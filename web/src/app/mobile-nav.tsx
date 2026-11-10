import { Link, useLocation } from "react-router-dom"

import { SidebarMenuButton } from "@/components/ui/sidebar"

import { APP_NAV_ITEMS } from "./nav-items"

export function MobileNav() {
  const location = useLocation()

  return (
    <nav className="iread-mobile-nav" aria-label="主要导航">
      <ul className="iread-mobile-nav__list">
        {APP_NAV_ITEMS.map((item) => {
          const isActive = item.isActive(location.pathname)
          return (
            <li className="iread-mobile-nav__item" key={item.url}>
              <SidebarMenuButton
                asChild
                isActive={isActive}
                className="iread-mobile-nav__link"
              >
                <Link
                  to={item.url}
                  aria-current={isActive ? "page" : undefined}
                >
                  <item.icon aria-hidden="true" />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
