import { AlertCircle, CheckCircle2, RefreshCw, Smartphone } from "lucide-react"
import { useEffect, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useAppearance } from "@/features/appearance/context"
import { buttonSizeForDensity } from "@/features/appearance/model"
import {
  applyUpdate,
  checkForUpdate,
  usePwaStatus,
} from "@/pwa/register"

import {
  OFFLINE_SCOPE_NOTE,
  describePwaStatus,
  formatTimestamp,
  pwaUpdateBlockReason,
} from "./model"
import { countUnsyncedProgress } from "./pending-progress"

/**
 * PWA 服务状态、更新与安装说明。
 *
 * 状态来自真实 Service Worker 注册；没有可用的浏览器安装入口时不渲染
 * 自定义安装按钮，只给 iOS/Android 分开的系统安装步骤。
 */
export function PwaSettingsSection() {
  const pwa = usePwaStatus()
  const { value: appearance, status: appearanceStatus } = useAppearance()
  const buttonSize = buttonSizeForDensity(appearance.density)
  const appearancePending = appearanceStatus !== "saved"
  const [pendingProgress, setPendingProgress] = useState<number | null>(null)
  const [progressCheckFailed, setProgressCheckFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const loadPending = () => {
      countUnsyncedProgress()
        .then((count) => {
          if (cancelled) {
            return
          }
          setPendingProgress(count)
          setProgressCheckFailed(false)
        })
        .catch(() => {
          if (cancelled) {
            return
          }
          setPendingProgress(null)
          setProgressCheckFailed(true)
        })
    }
    loadPending()
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        loadPending()
      }
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
    }
  }, [])

  const status = describePwaStatus(pwa)
  const updateBlock = pwaUpdateBlockReason({
    appearancePending,
    pendingProgress,
  })
  const checkDisabled =
    !pwa.supported || pwa.checking || pwa.status === "registering"

  return (
    <section
      className="iread-settings-section iread-cache-section"
      aria-labelledby="pwa-status-title"
    >
      <div className="iread-cache-section__header">
        <div>
          <h2 className="iread-settings-section__title" id="pwa-status-title">
            应用与更新
          </h2>
          <p className="iread-settings-note">
            这里显示真实 Service Worker 注册状态；更新只会在你确认后重新加载应用外壳。
          </p>
        </div>
        <Badge variant={pwa.status === "error" ? "destructive" : "secondary"}>
          {status.label}
        </Badge>
      </div>

      <div className="iread-pwa-status" data-testid="pwa-status">
        <p className="iread-pwa-status__description">{status.description}</p>
        <dl className="iread-pwa-status__facts">
          <div>
            <dt>页面受 Service Worker 控制</dt>
            <dd>{pwa.controlled ? "是" : "否"}</dd>
          </div>
          <div>
            <dt>应用外壳已缓存</dt>
            <dd>{pwa.offlineReady ? "是" : "尚未完成"}</dd>
          </div>
          <div>
            <dt>最近检查</dt>
            <dd>{formatTimestamp(pwa.lastCheckedAt)}</dd>
          </div>
        </dl>
      </div>

      <p className="iread-cache-scope-note">{OFFLINE_SCOPE_NOTE}</p>

      {pwa.error !== null ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Service Worker 操作失败</AlertTitle>
          <AlertDescription>
            <p>{pwa.error}</p>
            {pwa.status === "error" ? (
              <div className="iread-cache-actions">
                <Button
                  type="button"
                  size={buttonSize}
                  variant="outline"
                  onClick={() => {
                    window.location.reload()
                  }}
                >
                  重新加载页面
                </Button>
              </div>
            ) : pwa.needRefresh ? (
              <div className="iread-cache-actions">
                <Button
                  type="button"
                  size={buttonSize}
                  variant="outline"
                  disabled={updateBlock !== null}
                  onClick={() => {
                    void applyUpdate()
                  }}
                >
                  重试立即更新
                </Button>
              </div>
            ) : (
              <div className="iread-cache-actions">
                <Button
                  type="button"
                  size={buttonSize}
                  variant="outline"
                  disabled={checkDisabled}
                  onClick={() => {
                    void checkForUpdate()
                  }}
                >
                  重新检查更新
                </Button>
              </div>
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {progressCheckFailed ? (
        <p className="iread-settings-note" role="status">
          无法读取本机待同步进度；应用更新仍受“外观保存完成”检查约束。可稍后切换到设置页重试。
        </p>
      ) : null}

      {pendingProgress !== null && pendingProgress > 0 ? (
        <Alert>
          <AlertCircle aria-hidden="true" />
          <AlertTitle>仍有阅读进度待同步</AlertTitle>
          <AlertDescription>
            本机有 {pendingProgress} 条阅读进度尚未同步或存在冲突。更新会重新加载页面，请先在阅读器完成同步，再回来立即更新。
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="iread-cache-actions">
        <Button
          type="button"
          size={buttonSize}
          variant="outline"
          disabled={checkDisabled}
          onClick={() => {
            void checkForUpdate()
          }}
        >
          <RefreshCw aria-hidden="true" />
          {pwa.checking ? "正在检查更新" : "检查更新"}
        </Button>
        {pwa.needRefresh ? (
          <Button
            type="button"
            size={buttonSize}
            data-testid="pwa-update"
            disabled={updateBlock !== null}
            onClick={() => {
              void applyUpdate()
            }}
          >
            立即更新
          </Button>
        ) : null}
      </div>

      {updateBlock !== null ? (
        <p className="iread-settings-note" role="status">
          {updateBlock}
        </p>
      ) : (
        <p className="iread-settings-note">
          设置页不会自动刷新；阅读页只提示“退出阅读后更新”，不会打断当前阅读。
        </p>
      )}

      <div className="iread-install-groups">
        <h3 className="iread-install-group__title">
          <Smartphone aria-hidden="true" />
          iPhone / iPad（Safari）
        </h3>
        <ol className="iread-install-list">
          <li>用 Safari 打开 iRead。</li>
          <li>点按工具栏的分享按钮。</li>
          <li>在列表中选择“添加到主屏幕”，确认名称后添加。</li>
        </ol>
        <p className="iread-settings-note">
          iOS 是否显示安装入口由 Safari 决定；这里不显示无法验证的自定义安装按钮。
        </p>
      </div>

      <div className="iread-install-groups">
        <h3 className="iread-install-group__title">
          <Smartphone aria-hidden="true" />
          Android（Chrome / Edge）
        </h3>
        <ol className="iread-install-list">
          <li>在浏览器中打开 iRead。</li>
          <li>打开浏览器菜单（通常是右上角三个点）。</li>
          <li>选择“安装应用”或“添加到主屏幕”，按提示确认。</li>
        </ol>
        <p className="iread-settings-note">
          Android 浏览器支持安装时会显示系统安装入口；不支持时不会出现可安装状态。
        </p>
      </div>

      {pwa.offlineReady && pwa.controlled ? (
        <p className="iread-pwa-status__ready" role="status">
          <CheckCircle2 aria-hidden="true" />
          应用外壳可用：离线可打开已访问的 /、/library、/settings 与阅读路由；未缓存的书页仍需联网。
        </p>
      ) : null}
    </section>
  )
}
