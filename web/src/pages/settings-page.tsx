import { useState } from "react"
import { useSearchParams } from "react-router-dom"

import {
  Field,
  FieldLabel,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { AppearanceSettings } from "@/features/appearance/appearance-settings"
import { LibraryBookshelfSettings } from "@/features/library/settings/library-bookshelf-settings"
import { GlobalReaderDefaults } from "@/features/reader/settings/global-reader-defaults"
import { CachePwaSettings } from "@/features/settings/cache"

type SettingsGroup = "appearance" | "bookshelf" | "reading" | "cache"

const SETTINGS_GROUPS: Array<{ value: SettingsGroup; label: string }> = [
  { value: "appearance", label: "外观" },
  { value: "bookshelf", label: "书架" },
  { value: "reading", label: "阅读默认" },
  { value: "cache", label: "缓存与 PWA" },
]

function initialSettingsGroup(value: string | null): SettingsGroup {
  const match = SETTINGS_GROUPS.find((item) => item.value === value)
  return match?.value ?? "appearance"
}

export function SettingsPage() {
  const [searchParams] = useSearchParams()
  const [group, setGroup] = useState<SettingsGroup>(() =>
    initialSettingsGroup(searchParams.get("group")),
  )

  return (
    <div className="iread-page">
      <h1 className="iread-sr-only" data-route-heading tabIndex={-1}>
        设置
      </h1>

      <div className="iread-page__content">
        <Tabs
          value={group}
          onValueChange={(value) => {
            setGroup(value as SettingsGroup)
          }}
        >
          <TabsList
            className="iread-settings__tabs-list"
            aria-label="设置分组"
          >
            {SETTINGS_GROUPS.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="iread-settings__switcher">
            <Field>
              <FieldLabel htmlFor="settings-group">设置分组</FieldLabel>
              <Select
                value={group}
                onValueChange={(value) => {
                  setGroup(value as SettingsGroup)
                }}
              >
                <SelectTrigger
                  id="settings-group"
                  className="iread-select-trigger"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SETTINGS_GROUPS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <TabsContent className="iread-settings__panel" value="appearance">
            <AppearanceSettings />
          </TabsContent>

          <TabsContent className="iread-settings__panel" value="bookshelf">
            <LibraryBookshelfSettings />
          </TabsContent>

          <TabsContent className="iread-settings__panel" value="reading">
            <GlobalReaderDefaults />
          </TabsContent>

          <TabsContent className="iread-settings__panel" value="cache">
            <CachePwaSettings />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
