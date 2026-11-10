import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@/styles/iread.css"

import { App } from "@/app/app"
import { AppProviders } from "@/app/providers"
import { applyAppearance } from "@/features/appearance/apply"
import { copyDefaultAppearance } from "@/features/appearance/model"
import {
  appearanceValueFromMirror,
  readAppearanceMirror,
} from "@/features/appearance/storage"
import { registerAppServiceWorker } from "@/pwa/register"

// 在 React 渲染前同步应用本地镜像，避免首屏闪烁。
const initialMirror = readAppearanceMirror()
const initialAppearance =
  initialMirror === null
    ? copyDefaultAppearance()
    : appearanceValueFromMirror(initialMirror)
applyAppearance(
  document.documentElement,
  initialAppearance,
  window.matchMedia("(prefers-color-scheme: dark)").matches,
)

const root = document.getElementById("root")

if (root === null) {
  throw new Error("缺少根节点 #root。")
}

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
)

if (import.meta.env.PROD) {
  registerAppServiceWorker()
}
