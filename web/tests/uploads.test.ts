import { describe, expect, it } from "vitest"

import {
  applyTaskToItem,
  applyUploadDTO,
  canCancelUpload,
  canRemoveUpload,
  canRetryUpload,
  createUploadItem,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  parseUploadSnapshot,
  phaseFromUploadState,
  prepareUploadSelection,
  restorePhaseForMissingFile,
  selectQueuedItems,
  serializeUploadSnapshot,
  taskProgressPercent,
  uploadProgressPercent,
  uploadStatusText,
} from "../src/features/uploads/model"
import type { UploadDTO, UploadItem } from "../src/features/uploads/types"
import type { BackgroundTask } from "../src/features/library/types"

function file(name: string, size = 100, lastModified = 1) {
  return { name, size, lastModified }
}

function item(overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    clientUploadId: "client-1",
    uploadId: "upload-1",
    fileName: "book.epub",
    byteSize: 1000,
    bytesSent: 0,
    phase: "uploading",
    state: "uploading",
    bookId: null,
    duplicateOfBookId: null,
    taskId: null,
    task: null,
    taskUnavailable: false,
    error: null,
    ...overrides,
  }
}

function dto(overrides: Partial<UploadDTO> = {}): UploadDTO {
  return {
    schemaVersion: 1,
    uploadId: "upload-1",
    clientUploadId: "client-1",
    fileName: "book.epub",
    expectedSize: 1000,
    bytesReceived: 0,
    state: "awaiting-upload",
    bookId: null,
    duplicateOfBookId: null,
    taskId: null,
    error: null,
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
    ...overrides,
  }
}

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    kind: "book.index",
    bookId: "book-1",
    state: "running",
    attempt: 1,
    revision: "3",
    cancellationRequested: false,
    progress: { phase: "metadata", completedUnits: 2, totalUnits: 4 },
    error: null,
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
    ...overrides,
  }
}

describe("upload selection", () => {
  it("accepts supported files and rejects empty, oversized and unknown types", () => {
    const result = prepareUploadSelection(
      [
        file("a.epub"),
        file("b.PDF", 20),
        file("c.txt"),
        file("empty.cbz", 0),
        file("huge.cbr", MAX_UPLOAD_BYTES + 1),
      ],
      [],
      { idFactory: () => `id-${Math.random()}` },
    )
    expect(result.selections.map((selection) => selection.fileName)).toEqual([
      "a.epub",
      "b.PDF",
    ])
    expect(result.rejections.map((rejection) => rejection.message)).toEqual(
      expect.arrayContaining([
        "仅支持 EPUB、PDF、CBZ、CBR 文件。",
        "文件为空，无法上传。",
        "文件超过 1 GiB，无法上传。",
      ]),
    )
  })

  it("caps the batch at 50 and reports overflow", () => {
    const files = Array.from({ length: 55 }, (_, index) =>
      file(`book-${index}.epub`),
    )
    let nextId = 0
    const result = prepareUploadSelection(files, [], {
      idFactory: () => `id-${(nextId += 1)}`,
    })
    expect(result.selections).toHaveLength(MAX_UPLOAD_FILES)
    expect(result.overflow).toBe(5)
  })

  it("rejects duplicate files already in the active queue", () => {
    const existing = createUploadItem({
      clientUploadId: "existing",
      fileName: "a.epub",
      byteSize: 100,
      lastModified: 1,
      file: file("a.epub"),
    })
    const result = prepareUploadSelection([file("a.epub")], [existing], {
      idFactory: () => "new",
    })
    expect(result.selections).toHaveLength(0)
    expect(result.rejections[0]?.message).toBe("这个文件已在待上传列表中。")
  })

  it("allows selecting the same file again after it is stored", () => {
    const stored = applyUploadDTO(item(), dto({ state: "stored" }))
    const result = prepareUploadSelection([file("book.epub")], [stored], {
      idFactory: () => "new",
    })
    expect(result.selections).toHaveLength(1)
  })
})

describe("upload queue", () => {
  it("selects at most the configured concurrency and skips finished rows", () => {
    const items = [
      item({ clientUploadId: "a", phase: "queued" }),
      item({ clientUploadId: "b", phase: "queued" }),
      item({ clientUploadId: "c", phase: "queued" }),
      item({ clientUploadId: "d", phase: "saved" }),
    ]
    expect(
      selectQueuedItems(items, 0, 2).map((entry) => entry.clientUploadId),
    ).toEqual(["a", "b"])
    expect(
      selectQueuedItems(items, 1, 2).map((entry) => entry.clientUploadId),
    ).toEqual(["a"])
    expect(selectQueuedItems(items, 2, 2)).toEqual([])
  })

  it("maps server states to local phases and terminal displays", () => {
    expect(phaseFromUploadState("awaiting-upload")).toBe("queued")
    expect(phaseFromUploadState("stored")).toBe("saved")
    expect(phaseFromUploadState("duplicate")).toBe("duplicate")
    expect(phaseFromUploadState("failed")).toBe("failed")
    expect(phaseFromUploadState("cancelled")).toBe("cancelled")
    expect(phaseFromUploadState("expired")).toBe("expired")
  })

  it("keeps 100% network progress separate from readability", () => {
    const uploading = item({ phase: "uploading", bytesSent: 500 })
    expect(uploadProgressPercent(uploading)).toBe(50)
    expect(uploadStatusText(uploading)).toBe("上传中")

    const verifying = item({ phase: "verifying", bytesSent: 1000 })
    expect(uploadProgressPercent(verifying)).toBe(100)
    expect(uploadStatusText(verifying)).toBe("验证 / 整理中")

    const saved = applyUploadDTO(item(), {
      ...dto({ state: "stored", bytesReceived: 1000, taskId: "task-1" }),
    })
    expect(saved.phase).toBe("saved")
    expect(saved.bytesSent).toBe(1000)
    expect(uploadStatusText(saved)).toBe("已保存，等待整理")
    expect(uploadStatusText(saved)).not.toContain("可读")
  })

  it("cancels only unfinished uploads and retries only failed retryable rows", () => {
    expect(canCancelUpload(item({ phase: "uploading" }))).toBe(true)
    expect(
      canCancelUpload(
        item({ phase: "saved", state: "stored", uploadId: "upload-1" }),
      ),
    ).toBe(false)
    expect(
      canRetryUpload(
        item({
          phase: "failed",
          error: { code: "storage_unavailable", message: "", retryable: true },
        }),
      ),
    ).toBe(true)
    expect(
      canRetryUpload(
        item({
          phase: "failed",
          error: { code: "invalid_file", message: "", retryable: false },
        }),
      ),
    ).toBe(false)
    expect(canRemoveUpload(item({ phase: "saved", task: null }))).toBe(true)
    expect(
      canRemoveUpload(
        item({
          phase: "saved",
          task: {
            state: "running",
            phase: "metadata",
            completedUnits: 1,
            totalUnits: null,
            error: null,
            cancellationRequested: false,
          },
        }),
      ),
    ).toBe(false)
  })

  it("marks restored in-flight rows as needing a new file", () => {
    expect(restorePhaseForMissingFile(item({ phase: "uploading" })).phase).toBe(
      "needs-file",
    )
    expect(restorePhaseForMissingFile(item({ phase: "failed" })).phase).toBe(
      "needs-file",
    )
    expect(
      restorePhaseForMissingFile(
        item({ phase: "saved", state: "stored" }),
      ).phase,
    ).toBe("saved")
  })

  it("does not draw a fake percentage when task total is unknown", () => {
    const saved = applyUploadDTO(item(), dto({ state: "stored" }))
    const withTask = applyTaskToItem(saved, task({ progress: { phase: "metadata", completedUnits: 3, totalUnits: null } }))
    expect(taskProgressPercent(withTask.task!)).toBeNull()
    expect(uploadStatusText(withTask)).toBe("已保存，正在整理")
    expect(
      uploadStatusText({ ...withTask, taskUnavailable: true }),
    ).toBe("已保存，整理状态暂不可用")
  })

  it("serializes only queue metadata and restores it with a schema bound", () => {
    const saved = applyUploadDTO(item(), dto({ state: "stored" }))
    const raw = serializeUploadSnapshot([saved])
    expect(raw).not.toContain("csrf")
    expect(raw).not.toContain("token")
    const parsed = parseUploadSnapshot(JSON.parse(raw))
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]?.phase).toBe("saved")
    expect(parseUploadSnapshot({ schemaVersion: 2, items: [{}] }).items).toEqual(
      [],
    )
  })
})
