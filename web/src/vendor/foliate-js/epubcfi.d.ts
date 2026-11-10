/**
 * Minimal type declarations for the vendored foliate-js modules used by the
 * iRead EPUB engine. Runtime behavior lives in the upstream JavaScript.
 */

export interface EpubCfiStep {
  index: number
  id?: string
  offset?: number
  temporal?: string
  spatial?: string[]
  text?: string[]
  side?: string
}

export type EpubCfiIndirection = EpubCfiStep[]

export type EpubCfiParts =
  | EpubCfiIndirection[]
  | {
      parent: EpubCfiIndirection[]
      start: EpubCfiIndirection[]
      end: EpubCfiIndirection[]
    }

export const isCFI: RegExp
export function parse(cfi: string): EpubCfiParts
export function collapse(cfi: EpubCfiParts, toEnd?: boolean): EpubCfiParts
export function toRange(doc: Document, parts: EpubCfiParts): Range
export function fromRange(range: Range): string
export function fromElements(elements: Element[]): string[]
export function toElement(doc: Document, parts: EpubCfiIndirection): Element
export const fake: {
  fromIndex: (index: number) => string
  toIndex: (parts: EpubCfiIndirection) => number
}
