import { Upload } from "lucide-react"
import { Outlet } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { useAuth } from "@/features/auth/context"
import { useUploads } from "@/features/uploads/context"
import { UploadDialog } from "@/features/uploads/upload-dialog"
import { UploadProvider } from "@/features/uploads/upload-provider"

import { AppBreadcrumbs } from "./breadcrumbs"
import { AppSidebar } from "./app-sidebar"
import { MobileNav } from "./mobile-nav"

function AppShellFrame() {
  const { openUpload } = useUploads()
  const { devNoAuth } = useAuth()

  return (
    <SidebarProvider className="iread-shell">
      <AppSidebar />
      <SidebarInset className="iread-inset">
        <header className="iread-topbar">
          <div className="iread-topbar__start">
            <SidebarTrigger
              aria-label="切换导航"
              className="iread-sidebar-trigger"
            />
            <Separator
              orientation="vertical"
              className="iread-topbar__separator"
            />
            <AppBreadcrumbs />
          </div>
          <div className="iread-topbar__end">
            {devNoAuth ? (
              <Badge variant="secondary">开发模式 · 无密码</Badge>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="iread-topbar__upload"
              aria-label="上传图书"
              onClick={openUpload}
            >
              <Upload aria-hidden="true" />
              <span className="iread-topbar__upload-label">上传</span>
            </Button>
          </div>
        </header>
        <div className="iread-main">
          <Outlet />
        </div>
        <MobileNav />
      </SidebarInset>
      <UploadDialog />
    </SidebarProvider>
  )
}

export function AppShell() {
  return (
    <UploadProvider>
      <AppShellFrame />
    </UploadProvider>
  )
}
