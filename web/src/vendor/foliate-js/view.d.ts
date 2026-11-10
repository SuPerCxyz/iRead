import type { Paginator } from "./paginator.js"

export interface FoliateTocItem {
  label: string
  href: string
  subitems?: FoliateTocItem[]
  id?: number
}

export interface FoliateSection {
  id: string | number
  load: () => Promise<string>
  unload: () => void
  createDocument: () => Promise<Document>
  size: number
  cfi: string
  linear: "yes" | "no"
  resolveHref: (href: string) => string
}

export interface FoliateBook {
  metadata?: {
    title?: string
    language?: string
  }
  sections: FoliateSection[]
  toc?: FoliateTocItem[]
  pageList?: FoliateTocItem[]
  landmarks?: Array<{ label?: string; href: string; type?: string[] }>
  rendition?: {
    layout?: string
    flow?: string
    spread?: string
    direction?: string
  }
  dir?: string
  resolveHref: (href: string) => {
    index: number
    anchor?: (doc: Document) => Range | Element | number
  } | null
  resolveCFI?: (cfi: string) => {
    index: number
    anchor: (doc: Document) => Range
  } | null
  splitTOCHref?: (href?: string) => [number, string] | []
  getTOCFragment?: (doc: Document, id: string) => Element | null
  isExternal?: (uri: string) => boolean
}

export interface FoliateRelocateDetail {
  reason: string
  range: Range
  index?: number
  fraction?: number
  size?: number
  cfi?: string
  section?: { current: number; total: number }
}

export interface FoliateLoadDetail {
  doc: Document
  index: number
}

export interface FoliateNavigationTarget {
  index: number
  anchor?: ((doc: Document) => Range | Element | number) | number
  select?: boolean
}

export class View extends HTMLElement {
  book: FoliateBook
  language: {
    canonical?: string
    isCJK?: boolean
    direction?: string
  }
  isFixedLayout: boolean
  lastLocation: {
    cfi?: string
    fraction?: number
    range?: Range
    section?: { current: number; total: number }
  } | null
  renderer: Paginator
  constructor()
  open(book: FoliateBook): Promise<void>
  close(): void
  init(options?: {
    lastLocation?: string
    showTextStart?: boolean
  }): Promise<void>
  goToTextStart(): Promise<unknown>
  goTo(
    target:
      | string
      | number
      | FoliateNavigationTarget
      | { fraction: number },
  ): Promise<FoliateNavigationTarget | undefined>
  next(distance?: number): Promise<void>
  prev(distance?: number): Promise<void>
  resolveNavigation(
    target: string | number | FoliateNavigationTarget | { fraction: number },
  ): FoliateNavigationTarget | undefined
  resolveCFI(cfi: string): {
    index: number
    anchor: (doc: Document) => Range
  }
  getCFI(index: number, range?: Range): string
  getSectionFractions(): number[]
  getTOCItemOf(target: string | number): Promise<FoliateTocItem | null>
}
