import { createContext, useContext } from "react"

import type { UploadRejection } from "./model"
import type { UploadItem } from "./types"

export interface UploadContextValue {
  items: UploadItem[]
  open: boolean
  setOpen: (open: boolean) => void
  openUpload: () => void
  addFiles: (files: FileList | File[]) => void
  cancelItem: (clientUploadId: string) => void
  retryItem: (clientUploadId: string) => void
  removeItem: (clientUploadId: string) => void
  rejections: UploadRejection[]
  clearRejections: () => void
}

export const UploadContext = createContext<UploadContextValue | null>(null)

export function useUploads(): UploadContextValue {
  const context = useContext(UploadContext)
  if (context === null) {
    throw new Error("useUploads 必须在 UploadProvider 内使用。")
  }
  return context
}
