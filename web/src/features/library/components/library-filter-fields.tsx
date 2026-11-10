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
import {
  LIBRARY_FORMAT_LABELS,
  LIBRARY_READING_STATE_LABELS,
  LIBRARY_READING_STATES,
  LIBRARY_SORT_LABELS,
  LIBRARY_SORTS,
  type LibraryFilters,
} from "../filters"
import { BOOK_FORMATS } from "../types"

interface LibraryFilterFieldsProps {
  value: LibraryFilters
  onChange: (patch: Partial<LibraryFilters>) => void
  idPrefix: string
}

export function LibraryFilterFields({
  value,
  onChange,
  idPrefix,
}: LibraryFilterFieldsProps) {
  const formatId = `${idPrefix}-format`
  const stateId = `${idPrefix}-reading-state`
  const sortId = `${idPrefix}-sort`

  return (
    <div className="iread-library-filters">
      <Field>
        <FieldLabel htmlFor={formatId}>格式</FieldLabel>
        <Select
          value={value.format ?? "all"}
          onValueChange={(next) => {
            onChange({
              format:
                next === "all"
                  ? null
                  : (next as LibraryFilters["format"]),
            })
          }}
        >
          <SelectTrigger id={formatId} className="iread-select-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部格式</SelectItem>
            {BOOK_FORMATS.map((format) => (
              <SelectItem key={format} value={format}>
                {LIBRARY_FORMAT_LABELS[format]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel htmlFor={stateId}>阅读状态</FieldLabel>
        <Select
          value={value.readingState ?? "all"}
          onValueChange={(next) => {
            onChange({
              readingState:
                next === "all"
                  ? null
                  : (next as LibraryFilters["readingState"]),
            })
          }}
        >
          <SelectTrigger id={stateId} className="iread-select-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {LIBRARY_READING_STATES.map((state) => (
              <SelectItem key={state} value={state}>
                {LIBRARY_READING_STATE_LABELS[state]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel htmlFor={sortId}>排序</FieldLabel>
        <Select
          value={value.sort}
          onValueChange={(next) => {
            onChange({ sort: next as LibraryFilters["sort"] })
          }}
        >
          <SelectTrigger id={sortId} className="iread-select-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIBRARY_SORTS.map((sort) => (
              <SelectItem key={sort} value={sort}>
                {LIBRARY_SORT_LABELS[sort]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  )
}
