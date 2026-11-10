import type { FoliateBook, FoliateSection } from "./view.js"

/** Minimal Paginator surface used by the engine. */
export class Paginator extends HTMLElement {
  static observedAttributes: string[]
  bookDir: string
  sections: FoliateSection[]
  scrolled: boolean
  page: number
  pages: number
  viewSize: number
  start: number
  end: number
  atStart: boolean
  atEnd: boolean
  open(book: FoliateBook): void
  goTo(
    target:
      | {
          index: number
          anchor?:
            | ((doc: Document) => Range | Element | number)
            | number
          select?: boolean
        }
      | Promise<{
          index: number
          anchor?:
            | ((doc: Document) => Range | Element | number)
            | number
          select?: boolean
        }>,
  ): Promise<void>
  next(distance?: number): Promise<void>
  prev(distance?: number): Promise<void>
  render(): void
  setStyles(styles: string | [string, string]): void
  getContents(): Array<{
    index: number
    doc: Document
    overlayer?: unknown
  }>
  focusView(): void
  destroy(): void
}
