import type { LucideIcon } from "lucide-react"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useAppearance } from "@/features/appearance/context"
import { buttonSizeForDensity } from "@/features/appearance/model"

export interface EmptyAction {
  label: string
  to?: string
  onClick?: () => void
  variant?: "default" | "outline"
}

interface PageEmptyProps {
  icon: LucideIcon
  title: string
  description: string
  actions?: EmptyAction[]
  titleAsHeading?: boolean
}

export function PageEmpty({
  icon: Icon,
  title,
  description,
  actions = [],
  titleAsHeading = false,
}: PageEmptyProps) {
  const { value } = useAppearance()
  const buttonSize = buttonSizeForDensity(value.density)

  return (
    <Empty className="iread-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          {titleAsHeading ? (
            <h1 className="iread-empty-heading" data-route-heading tabIndex={-1}>
              {title}
            </h1>
          ) : (
            title
          )}
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {actions.length > 0 ? (
        <EmptyContent>
          <div className="iread-empty__actions">
            {actions.map((action) =>
              action.to === undefined ? (
                <Button
                  key={action.label}
                  type="button"
                  size={buttonSize}
                  variant={action.variant}
                  onClick={action.onClick}
                >
                  {action.label}
                </Button>
              ) : (
                <Button
                  asChild
                  key={action.label}
                  size={buttonSize}
                  variant={action.variant}
                >
                  <Link to={action.to}>{action.label}</Link>
                </Button>
              ),
            )}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}
