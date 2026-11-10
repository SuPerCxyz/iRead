import { RefreshCw } from "lucide-react"
import { useLocation } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

import {
  applyUpdate,
  dismissUpdate,
  usePwaStatus,
} from "./register"
import { useAppearance } from "@/features/appearance/context"

export function UpdatePrompt() {
  const location = useLocation()
  const status = usePwaStatus()
  const { status: appearanceStatus } = useAppearance()
  const isReading = location.pathname.startsWith("/read/")
  const appearancePending = appearanceStatus !== "saved"

  if (!status.needRefresh || status.dismissed === "later") {
    return null
  }
  if (status.dismissed === "after-reading" && isReading) {
    return null
  }

  return (
    <Alert className="iread-update-prompt">
      <RefreshCw aria-hidden="true" />
      <AlertTitle>有新版本可用</AlertTitle>
      <AlertDescription>
        {isReading
          ? "阅读页不会自动刷新。退出阅读后可手动更新，当前阅读进度不会被打断。"
          : "更新会重新加载应用外壳；本机外观设置与阅读进度不受影响。"}
        {status.error === null ? null : (
          <p className="iread-update-prompt__error" role="alert">
            更新失败：{status.error} 请重试。
          </p>
        )}
        {!isReading && appearancePending ? (
          <p className="iread-update-prompt__error">
            外观设置尚未保存完成，请先等待保存后再更新。
          </p>
        ) : null}
        <div className="iread-update-prompt__actions">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => dismissUpdate("later")}
          >
            稍后
          </Button>
          {isReading ? (
            <Button
              type="button"
              size="sm"
              onClick={() => dismissUpdate("after-reading")}
            >
              退出阅读后更新
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={appearancePending}
              onClick={() => {
                void applyUpdate()
              }}
            >
              立即更新
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  )
}
