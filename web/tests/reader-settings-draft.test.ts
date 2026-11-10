import { describe, it, expect, vi, afterEach } from "vitest"
import { ReaderSettingsDraft } from "../src/features/reader/shell/settings-draft"
import type { BookReaderOverrides } from "../src/features/reader/types"
const record = (revision: string, overrides: BookReaderOverrides["overrides"] = {}) => ({ schemaVersion: 1, bookId: "book", fileVersion: "f".repeat(64), revision, overrides, effectiveValues: {}, fieldSources: {}, globalRevision: "0", builtInVersion: 1, updatedAt: null } as unknown as BookReaderOverrides)
function memory() { const data = new Map<string,string>(); return { getItem: (k:string) => data.get(k) ?? null, setItem: (k:string,v:string) => { data.set(k,v) } } }
const factory = (save: (base:string,value:BookReaderOverrides["overrides"]) => Promise<BookReaderOverrides>, storage = memory()) => new ReaderSettingsDraft({ key: "draft", storage, save, onSaved: () => {} })
afterEach(() => vi.useRealTimers())
describe("本书自动保存状态机", () => {
  it("自动仅提交本书；dirty确认后保留显式global字段", async () => {
    vi.useFakeTimers(); const save=vi.fn(async (_base:string,v:BookReaderOverrides["overrides"])=>record("1",v)); const c=factory(save)
    c.configure(record("0")); c.activate(); c.change({"reflow.fontSize":18}); await vi.advanceTimersByTimeAsync(400)
    expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0][0]).toBe("0"); expect(c.snapshot().values).toEqual({}); expect(c.snapshot().promotion).toEqual({"reflow.fontSize":18})
    c.acknowledgePromotion({"reflow.fontSize":18}); expect(c.snapshot().promotion).toEqual({}); c.dispose()
  })
  it("串行合并在途后的新编辑，旧确认不清除新值", async () => {
    let done!:(r:BookReaderOverrides)=>void; const first=new Promise<BookReaderOverrides>(r=>{done=r}); const calls:Array<[string,BookReaderOverrides["overrides"]]>=[]
    const c=factory(async (base,v)=>{ calls.push([base,v]); return calls.length===1 ? first : record("2",v) }); c.configure(record("0")); c.activate()
    c.change({"reflow.fontSize":18}); const p=c.flush(); c.change({"reflow.fontSize":22}); done(record("1",{reflow:{fontSize:18}})); await p; await c.flush()
    expect(calls.map(c=>c[0])).toEqual(["0","1"]); expect((calls[1][1].reflow as Record<string, unknown>).fontSize).toBe(22); expect(c.snapshot().values).toEqual({}); c.dispose()
  })
  it("迟到旧ACK不能使已确认新版本的baseRevision回退", async () => {
    let done!:(r:BookReaderOverrides)=>void; const first=new Promise<BookReaderOverrides>(r=>{done=r}); const calls:string[]=[]
    const c=factory(async (base,v)=>{calls.push(base);return calls.length===1?first:record("3",v)});c.configure(record("0"));c.activate();c.change({"reflow.fontSize":18});const p=c.flush()
    c.configure(record("2",{reflow:{fontSize:18}}));expect(c.snapshot().values).toEqual({});c.change({"reflow.lineHeight":1.8});done(record("1",{reflow:{fontSize:18}}));await p
    expect(c.snapshot().baseRevision).toBe("2");await c.flush();expect(calls).toEqual(["0","2"]);c.dispose()
  })
  it("reset排在旧请求之后且旧结果不复活已清覆盖", async () => {
    let done!:(r:BookReaderOverrides)=>void; const first=new Promise<BookReaderOverrides>(r=>{done=r}); const calls:Array<[string,BookReaderOverrides["overrides"]]>=[]
    const c=factory(async (base,v)=>{calls.push([base,v]);return calls.length===1?first:record("2",v)}); c.configure(record("0")); c.activate(); c.change({"reflow.fontSize":18}); const p=c.flush(); const reset=c.reset(); done(record("1",{reflow:{fontSize:18}})); await p; await reset
    expect(calls[1]).toEqual(["1",{}]); expect(c.snapshot().reset).toBe(false); expect(c.snapshot().promotion).toEqual({}); c.dispose()
  })
  it("离线和409保留本机草稿，重开不自动强改服务器revision", async () => {
    const storage=memory(); const save=vi.fn(async ()=>{throw Object.assign(Error("conflict"),{status:409})}); const c=factory(save,storage); c.configure(record("7")); c.activate(); c.change({"reflow.fontSize":20}); await expect(c.flush()).rejects.toThrow(); c.dispose()
    const reopened=factory(save,storage); reopened.configure(record("8")); reopened.activate(); expect(reopened.snapshot().status).toBe("conflict"); expect(reopened.snapshot().values).toEqual({"reflow.fontSize":20}); expect(reopened.snapshot().baseRevision).toBe("7"); reopened.dispose()
  })
  it("StrictMode式setup-cleanup-setup仍能自动保存", async () => {
    vi.useFakeTimers();const save=vi.fn(async (_b:string,v:BookReaderOverrides["overrides"])=>record("1",v));const c=factory(save);c.configure(record("0"));c.activate();c.dispose();c.activate();c.change({"reflow.fontSize":19});await vi.advanceTimersByTimeAsync(400);expect(save).toHaveBeenCalledTimes(1);c.dispose()
  })
  it("旧实例不能覆盖重新打开实例已写的新草稿", async () => {
    const storage=memory();let done!:(r:BookReaderOverrides)=>void;const p=new Promise<BookReaderOverrides>(r=>{done=r});const old=factory(async()=>p,storage);old.configure(record("0"));old.activate();old.change({"reflow.fontSize":18});const flight=old.flush();old.dispose();const next=factory(async (_b,v)=>record("2",v),storage);next.configure(record("0"));next.activate();next.change({"reflow.fontSize":24});done(record("1",{reflow:{fontSize:18}}));await flight;next.dispose();const check=factory(async (_b,v)=>record("3",v),storage);expect(check.snapshot().values).toEqual({"reflow.fontSize":24});check.dispose()
  })
  it("重开已确认草稿不误报仍等待同步，promotion保持可显式设全局", async () => {
    const storage=memory();const c=factory(async (_b,v)=>record("1",v),storage);c.configure(record("0"));c.activate();c.change({"reflow.fontSize":18});await c.flush();c.dispose()
    const next=factory(async (_b,v)=>record("2",v),storage);next.configure(record("1",{reflow:{fontSize:18}}));next.activate();expect(next.snapshot().status).toBe("saved");expect(next.snapshot().promotion).toEqual({"reflow.fontSize":18});next.dispose()
  })
  it("本机存储不可写不伪报本机保存", () => { const c=new ReaderSettingsDraft({key:"x",storage:{getItem:()=>null,setItem:()=>{throw Error("quota")}},save:async()=>record("1"),onSaved:()=>{}});c.configure(record("0"));c.activate();c.change({"reflow.fontSize":18});expect(c.snapshot().localSaved).toBe(false);c.dispose() })
})
