import { AlertCircle, Info } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useAppearance } from "@/features/appearance/context"
import { buttonSizeForDensity } from "@/features/appearance/model"

import { LibraryViewFields } from "./library-view-fields"
import {
  librarySettingsStatusText,
  useLibraryViewSettings,
} from "./use-library-view-settings"

const FIELD_LABELS: Record<string, string> = {
  viewMode: "视图模式",
  density: "卡片密度",
  columns: "网格列数",
  showAuthors: "显示作者",
  showProgress: "显示阅读进度",
  showFormat: "显示格式",
  showSubtitle: "显示副标题",
  coverRatio: "封面比例",
  coverRadius: "封面圆角",
  cardGap: "卡片间距",
  value: "设置值",
}

export function LibraryBookshelfSettings() {
  const {
    value,
    record,
    status,
    conflict,
    saveError,
    loadError,
    fieldError,
    update,
    retry,
    loadServerSettings,
    keepLocalAndResave,
  } = useLibraryViewSettings()
  const { value: appearance } = useAppearance()
  const buttonSize = buttonSizeForDensity(appearance.density)
  const controlsDisabled = status === "loading" || loadError !== null
  const statusText = librarySettingsStatusText(status)

  return (
    <section className="iread-library-settings">
      <div className="iread-library-settings__header">
        <div>
          <h2 className="iread-settings-section__title">书库视图</h2>
          <p className="iread-settings-note">
            书库视图设置是全局单层设置，不继承其它设置分组。
          </p>
        </div>
        <p className="iread-library-settings__status" role="status">
          {statusText}
          {record !== null ? ` · 版本 ${record.revision}` : ""}
        </p>
      </div>

      {loadError !== null ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>无法读取书库视图设置</AlertTitle>
          <AlertDescription>
            <p className="iread-query-error__message">{loadError}</p>
            <Button
              type="button"
              size={buttonSize}
              variant="outline"
              onClick={retry}
            >
              重试读取
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {conflict !== null ? (
        <Alert>
          <Info aria-hidden="true" />
          <AlertTitle>设置已在另一处更新</AlertTitle>
          <AlertDescription>
            <p>
              服务器当前版本为 {conflict.revision}
              。可以载入服务器设置，或用本机当前值覆盖并重新保存。
            </p>
            <div className="iread-settings-actions">
              <Button type="button" size={buttonSize} onClick={loadServerSettings}>
                使用服务器设置
              </Button>
              <Button
                type="button"
                size={buttonSize}
                variant="outline"
                onClick={keepLocalAndResave}
              >
                保留本机并覆盖
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {saveError !== null ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>未能保存书库视图设置</AlertTitle>
          <AlertDescription>
            <p className="iread-query-error__message">
              {fieldError !== null
                ? `${FIELD_LABELS[fieldError.field] ?? fieldError.field}：`
                : ""}
              {saveError}
            </p>
            <Button
              type="button"
              size={buttonSize}
              variant="outline"
              onClick={retry}
            >
              重试保存
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <LibraryViewFields
        value={value}
        onChange={update}
        idPrefix="settings-library"
        disabled={controlsDisabled}
      />
    </section>
  )
}
