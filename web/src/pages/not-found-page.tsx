import { SearchX } from "lucide-react"

import { PageEmpty } from "@/components/app/page-empty"

export function NotFoundPage() {
  return (
    <div className="iread-page">
      <div className="iread-page__content">
        <PageEmpty
          icon={SearchX}
          title="页面不存在"
          description="当前地址没有对应的页面。你可以返回首页，或前往书库继续浏览。"
          titleAsHeading
          actions={[
            { label: "返回首页", to: "/" },
            { label: "前往书库", to: "/library", variant: "outline" },
          ]}
        />
      </div>
    </div>
  )
}
