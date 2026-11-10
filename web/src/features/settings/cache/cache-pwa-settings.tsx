import { Info } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"

import { BrowserCacheSection } from "./browser-cache-section"
import { OFFLINE_SCOPE_NOTE } from "./model"
import { PwaSettingsSection } from "./pwa-settings-section"
import { ServerCacheSection } from "./server-cache-section"

/**
 * 设置页“缓存与 PWA”分组。
 *
 * 服务端派生缓存、浏览器阅读缓存与应用外壳缓存分开展示：三类数据的
 * 精确性、清理边界和离线承诺不同，不能合并成一个“清除全部数据”按钮。
 */
export function CachePwaSettings() {
  return (
    <div className="iread-cache-panel">
      <Alert>
        <Info aria-hidden="true" />
        <AlertTitle>缓存边界</AlertTitle>
        <AlertDescription>
          <p>
            服务端封面/漫画页缓存与浏览器阅读内容缓存都可以按需重建；原件、阅读进度、书签、阅读偏好和全局设置不在清理范围内。
          </p>
          <p>{OFFLINE_SCOPE_NOTE}</p>
        </AlertDescription>
      </Alert>

      <ServerCacheSection />
      <Separator />
      <BrowserCacheSection />
      <Separator />
      <PwaSettingsSection />
    </div>
  )
}
