import { useRef } from "react"
import type { ReactNode, RefObject } from "react"
import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

import type { ReaderPanelId } from "../session/reader-session"

interface ReaderPanelFrameProps {
  kind: Exclude<ReaderPanelId, null> | "search"
  open: boolean
  mobile: boolean
  title: string
  description: string
  restoreFocusRef: RefObject<HTMLElement | null>
  onOpenChange: (open: boolean) => void
  children: ReactNode
}

/**
 * 桌面 Sheet / 手机 Drawer 的共享面板框架。
 * 标题、说明、初始焦点、焦点约束、Esc 与关闭后回到触发点由官方组件承担。
 */
export function ReaderPanelFrame({
  kind,
  open,
  mobile,
  title,
  description,
  restoreFocusRef,
  onOpenChange,
  children,
}: ReaderPanelFrameProps) {
  const contentRef = useRef<HTMLDivElement | null>(null)

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next)
  }

  const handleCloseAutoFocus = (event: Event) => {
    event.preventDefault()
    const target = restoreFocusRef.current
    if (target?.isConnected) target.focus({ preventScroll: true })
  }

  const handleOpenAutoFocus = (event: Event) => {
    event.preventDefault()
    window.requestAnimationFrame(() => {
      const target = contentRef.current?.querySelector<HTMLElement>(
        "[data-reader-panel-focus]",
      )
      target?.focus()
    })
  }

  const header = (
    <>
      <div className="iread-reader-panel__heading">
        <div className="iread-reader-panel__heading-text">
          {mobile ? (
            <>
              <DrawerTitle>{title}</DrawerTitle>
              <DrawerDescription>{description}</DrawerDescription>
            </>
          ) : (
            <>
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="关闭面板"
          onClick={() => handleOpenChange(false)}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </>
  )

  if (mobile) {
    return (
      <Drawer open={open} onOpenChange={handleOpenChange} direction="bottom">
        <DrawerContent
          ref={contentRef}
          className="iread-reader-panel iread-reader-panel--drawer"
          data-reader-panel={kind}
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          <DrawerHeader className="iread-reader-panel__header">
            {header}
          </DrawerHeader>
          <div className="iread-reader-panel__body">{children}</div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        ref={contentRef}
        side="right"
        showCloseButton={false}
        className="iread-reader-panel iread-reader-panel--sheet"
        data-reader-panel={kind}
        onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={handleCloseAutoFocus}
      >
        <SheetHeader className="iread-reader-panel__header">{header}</SheetHeader>
        <div className="iread-reader-panel__body">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
