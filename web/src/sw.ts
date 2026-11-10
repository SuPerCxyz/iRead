/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core"
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from "workbox-precaching"
import { registerRoute } from "workbox-routing"

import { isShellPath } from "@/lib/path"

declare const __IREAD_BUILD_ID__: string

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>
  __IREAD_BUILD_ID__: string
}

// 仅用于让不同构建的 sw.js 字节不同，便于更新检测；不参与运行时逻辑。
self.__IREAD_BUILD_ID__ = __IREAD_BUILD_ID__

clientsClaim()
cleanupOutdatedCaches()

// Range 请求必须在 precache 之前直通网络，不能缓存或改写 206 响应。
registerRoute(
  ({ request }) => request.headers.has("range"),
  ({ request }) => fetch(request),
)

// 只预缓存构建 Shell；不缓存 API、原件、章节、页面或 Range 响应。
precacheAndRoute(self.__WB_MANIFEST)

// 只为已知客户端导航路由提供 index.html fallback。
// 用 pathname 判断，支持查询字符串与尾斜杠；未知路径不进入该路由。
registerRoute(
  ({ request, url }) =>
    request.mode === "navigate" && isShellPath(url.pathname),
  createHandlerBoundToURL("index.html"),
)

// 新 SW 只在用户点击“立即更新”后收到该消息；绝不自动 skipWaiting。
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data: unknown = event.data
  if (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "SKIP_WAITING"
  ) {
    void self.skipWaiting()
  }
})
