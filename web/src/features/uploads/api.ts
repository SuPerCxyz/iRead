import { apiGet, apiPost } from "@/lib/api"

import { parseUploadDTO, type UploadDTO } from "./types"

export const UPLOADS_ENDPOINT = "/api/v1/uploads"

export async function createUploadIntent(
  clientUploadId: string,
  fileName: string,
  byteSize: number,
): Promise<UploadDTO> {
  const data = await apiPost<unknown>(UPLOADS_ENDPOINT, {
    clientUploadId,
    fileName,
    byteSize,
  })
  return parseUploadDTO(data)
}

export async function getUpload(uploadId: string): Promise<UploadDTO> {
  const data = await apiGet<unknown>(
    `${UPLOADS_ENDPOINT}/${encodeURIComponent(uploadId)}`,
  )
  return parseUploadDTO(data)
}

export async function cancelUpload(uploadId: string): Promise<UploadDTO> {
  const data = await apiPost<unknown>(
    `${UPLOADS_ENDPOINT}/${encodeURIComponent(uploadId)}/cancel`,
  )
  return parseUploadDTO(data)
}
