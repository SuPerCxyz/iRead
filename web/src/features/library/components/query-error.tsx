import { AlertCircle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useAppearance } from "@/features/appearance/context"
import { buttonSizeForDensity } from "@/features/appearance/model"

import { describeApiError } from "../errors"

interface QueryErrorProps {
  title: string
  error: unknown
  onRetry: () => void
  retryLabel?: string
}

export function QueryError({
  title,
  error,
  onRetry,
  retryLabel = "重试",
}: QueryErrorProps) {
  const { value } = useAppearance()
  const buttonSize = buttonSizeForDensity(value.density)

  return (
    <Alert variant="destructive" className="iread-query-error">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p className="iread-query-error__message">{describeApiError(error)}</p>
        <Button
          type="button"
          size={buttonSize}
          variant="outline"
          onClick={onRetry}
        >
          {retryLabel}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
