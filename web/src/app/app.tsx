import { BrowserRouter } from "react-router-dom"

import { UpdatePrompt } from "@/pwa/update-prompt"

import { RouteFocus } from "./route-focus"
import { ScrollRestoration } from "./scroll-restoration"
import { AppRoutes } from "./router"

export function App() {
  return (
    <BrowserRouter>
      <RouteFocus />
      <ScrollRestoration />
      <AppRoutes />
      <UpdatePrompt />
    </BrowserRouter>
  )
}
