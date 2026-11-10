import { useEffect, useRef, useState } from "react"

import { AlertCircle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Separator } from "@/components/ui/separator"

import {
  libraryFiltersKey,
  type LibraryFilters,
} from "../filters"
import { LibraryFilterFields } from "../components/library-filter-fields"
import { LibraryViewFields } from "../settings/library-view-fields"
import {
  librarySettingsStatusText,
  useLibraryViewSettings,
} from "../settings/use-library-view-settings"

interface LibraryFilterDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  filters: LibraryFilters
  onApply: (filters: LibraryFilters) => void
  onClear: () => void
}

export function LibraryFilterDrawer({
  open,
  onOpenChange,
  filters,
  onApply,
  onClear,
}: LibraryFilterDrawerProps) {
  const view = useLibraryViewSettings()
  const [draft, setDraft] = useState<LibraryFilters>(filters)
  const filterKey = libraryFiltersKey(filters)
  const filtersRef = useRef(filters)
  useEffect(() => {
    filtersRef.current = filters
  }, [filters])

  useEffect(() => {
    if (open) {
      setDraft(filtersRef.current)
    }
  }, [filterKey, open])

  const apply = () => {
    onApply(draft)
    onOpenChange(false)
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="iread-library-drawer">
        <DrawerHeader className="iread-library-drawer__header">
          <DrawerTitle>筛选与视图</DrawerTitle>
          <DrawerDescription>
            筛选和排序在点击“应用筛选”后生效；视图设置会立即预览并自动保存。
          </DrawerDescription>
        </DrawerHeader>

        <div className="iread-library-drawer__scroll">
          <section className="iread-library-drawer__section">
            <h2 className="iread-settings-section__title">筛选与排序</h2>
            <LibraryFilterFields
              value={draft}
              onChange={(patch) => {
                setDraft((current) => ({ ...current, ...patch }))
              }}
              idPrefix="drawer-library"
            />
          </section>

          <Separator />

          <section className="iread-library-drawer__section">
            <div className="iread-library-drawer__section-header">
              <h2 className="iread-settings-section__title">视图</h2>
              <p className="iread-settings-note" role="status">
                {librarySettingsStatusText(view.status)}
              </p>
            </div>
            <LibraryViewFields
              value={view.value}
              onChange={view.update}
              idPrefix="drawer-view"
              disabled={
                view.status === "loading" || view.loadError !== null
              }
            />
            {view.loadError !== null ? (
              <Alert variant="destructive">
                <AlertCircle aria-hidden="true" />
                <AlertTitle>无法读取视图设置</AlertTitle>
                <AlertDescription>
                  <p className="iread-query-error__message">
                    {view.loadError}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={view.retry}
                  >
                    重试
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {view.conflict !== null ? (
              <Alert>
                <AlertCircle aria-hidden="true" />
                <AlertTitle>设置已在另一处更新</AlertTitle>
                <AlertDescription>
                  <p>服务器当前版本为 {view.conflict.revision}。</p>
                  <div className="iread-settings-actions">
                    <Button
                      type="button"
                      onClick={view.loadServerSettings}
                    >
                      使用服务器设置
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={view.keepLocalAndResave}
                    >
                      保留本机并覆盖
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
            {view.saveError !== null ? (
              <Alert variant="destructive">
                <AlertCircle aria-hidden="true" />
                <AlertTitle>未能保存视图设置</AlertTitle>
                <AlertDescription>
                  <p className="iread-query-error__message">
                    {view.saveError}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={view.retry}
                  >
                    重试保存
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
          </section>
        </div>

        <DrawerFooter className="iread-library-drawer__footer">
          <Button type="button" onClick={apply}>
            应用筛选
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onClear()
              onOpenChange(false)
            }}
          >
            清除筛选
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
