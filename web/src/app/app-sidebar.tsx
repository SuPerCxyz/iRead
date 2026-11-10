import { BookOpen, LogOut, ShieldOff, Upload, User, X } from "lucide-react"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { useAuth } from "@/features/auth/context"
import { useUploads } from "@/features/uploads/context"

import { AppNav } from "./app-nav"
import { useSidebarFocusReturn } from "./use-sidebar-focus-return"

export function AppSidebar() {
  useSidebarFocusReturn()
  const { isMobile, setOpenMobile } = useSidebar()
  const { busy, logout, devNoAuth } = useAuth()
  const { openUpload } = useUploads()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="iread-sidebar-header">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="iRead">
              <Link
                to="/"
                onClick={() => {
                  if (isMobile) {
                    setOpenMobile(false)
                  }
                }}
              >
                <BookOpen aria-hidden="true" />
                <span className="iread-sidebar-brand-label">iRead</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="iread-sidebar-close"
          aria-label="关闭导航"
          onClick={() => {
            setOpenMobile(false)
          }}
        >
          <X aria-hidden="true" />
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <AppNav />
        <SidebarGroup>
          <SidebarGroupLabel>操作</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                tooltip="上传图书"
                onClick={() => {
                  if (isMobile) {
                    setOpenMobile(false)
                  }
                  openUpload()
                }}
              >
                <Upload aria-hidden="true" />
                <span>上传图书</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {devNoAuth ? (
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="开发模式 · 无密码">
                <span
                  className="iread-sidebar-admin"
                  aria-label="开发模式：无密码，无需登录"
                >
                  <ShieldOff aria-hidden="true" />
                  <span>开发模式 · 无密码</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : (
            <>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="管理员">
                  <span
                    className="iread-sidebar-admin"
                    aria-label="当前登录：管理员"
                  >
                    <User aria-hidden="true" />
                    <span>管理员</span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  type="button"
                  disabled={busy}
                  tooltip="退出登录"
                  onClick={() => {
                    void logout()
                  }}
                >
                  <LogOut aria-hidden="true" />
                  <span>{busy ? "正在退出" : "退出登录"}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </>
          )}
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail
        aria-label="折叠或展开侧栏"
        title="折叠或展开侧栏"
      />
    </Sidebar>
  )
}
