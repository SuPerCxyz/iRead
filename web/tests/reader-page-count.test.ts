import { describe, expect, it } from "vitest"
import { readerPageCount, pageLocationForManifest } from "../src/features/reader/shell/reader-shell-model"
import type { ReaderManifest } from "../src/features/reader/types"
const pdf = (pageCount: number, bookId = "b", fileVersion = "f") => ({ format: "pdf", bookId, fileVersion, formatData: { pageCount } }) as unknown as ReaderManifest
const document = { bookId: "b", fileVersion: "f", pageCount: 256 }
describe("PDF 未知页数仅使用当前已就绪文档元数据", () => {
  it("未知页数等待engine，ready后提供跳页及真实百分比", () => {
    expect(readerPageCount(pdf(0))).toBeNull(); expect(pageLocationForManifest(pdf(0), 2, null)).toBeNull()
    expect(readerPageCount(pdf(0), document)).toBe(256)
    const target=pageLocationForManifest(pdf(0), 2, null, document)
    expect(target?.locatorPayload).toMatchObject({ page: 2, pageOffset: 0 }); expect(target?.progressPercent).toBeCloseTo(100/255)
    expect(pageLocationForManifest(pdf(0), 256, null, document)?.progressPercent).toBe(100)
  })
  it("已知manifest保持权威，换书/版本不能借旧metadata", () => {
    expect(readerPageCount(pdf(12),document)).toBe(12)
    expect(readerPageCount(pdf(0,"other"),document)).toBeNull();expect(readerPageCount(pdf(0,"b","new"),document)).toBeNull()
  })
  it("拒绝零/非法总数与越界或非整数页码", () => {
    for (const count of [0,-1,Number.NaN,Infinity,1.5]) expect(readerPageCount(pdf(0),{...document,pageCount:count})).toBeNull()
    for (const page of [0,257,1.5,Number.NaN]) expect(pageLocationForManifest(pdf(0),page,null,document)).toBeNull()
  })
})
