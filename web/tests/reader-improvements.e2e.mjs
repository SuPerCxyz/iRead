#!/usr/bin/env node
/** 四项阅读修订的独立入口：全新DB/books/cache/账号/端口，无现有BASE_URL或DB_PATH回退。 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, request } from "playwright"
import { AuthedApi, createAuthenticatedStorageState } from "./auth-helpers.mjs"
import { buildReaderEpub } from "./reader-improvements-fixtures.mjs"

const webRoot=path.resolve(fileURLToPath(new URL("..",import.meta.url))),repoRoot=path.resolve(webRoot,"..")
const parent=process.env.IREAD_E2E_TMP ?? tmpdir()
mkdirSync(parent,{recursive:true})
const runtime=mkdtempSync(path.join(parent,"iread-reader-improvements-"))
for(const folder of ["books","db","cache","web","shots"])mkdirSync(path.join(runtime,folder),{mode:0o700})
writeFileSync(path.join(runtime,"web/index.html"),'<!doctype html><div id="root"></div>')
const children=[]
function start(command,args,cwd,env={}) {
  const child=spawn(command,args,{cwd,env:{...process.env,...env},detached:true,stdio:["ignore","pipe","pipe"]})
  let output="";child.stdout.on("data",b=>{output=(output+b).slice(-4000)});child.stderr.on("data",b=>{output=(output+b).slice(-4000)})
  children.push(child);return {child,output:()=>output}
}
function stop() { for(const child of children)if(child.exitCode===null)try{process.kill(-child.pid,"SIGTERM")}catch{} }
process.once("SIGINT",()=>{stop();process.exit(130)});process.once("SIGTERM",()=>{stop();process.exit(143)})
const port=()=>new Promise(resolve=>{const server=createServer();server.listen(0,"127.0.0.1",()=>{const number=server.address().port;server.close(()=>resolve(number))})})
async function ready(url,process) {
  const deadline=Date.now()+120000
  while(Date.now()<deadline) {
    if(process.child.exitCode!==null)throw Error("隔离服务退出："+process.output())
    try{if((await fetch(url)).ok)return}catch{}
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  throw Error("隔离服务未就绪")
}
async function run(file,connectionPath) {
  const child=spawn(process.execPath,[path.join(webRoot,"tests",file)],{cwd:repoRoot,env:{...process.env,IREAD_READER_FIX_CONNECTION:connectionPath},stdio:["ignore","pipe","pipe"]})
  const log=[];child.stdout.on("data",chunk=>{log.push(chunk);process.stdout.write(chunk)});child.stderr.on("data",chunk=>{log.push(chunk);process.stderr.write(chunk)})
  children.push(child)
  const timeout=setTimeout(()=>child.kill("SIGTERM"),180000)
  const code=await new Promise(resolve=>child.once("exit",code=>resolve(code)))
  clearTimeout(timeout);writeFileSync(path.join(runtime,file+".log"),Buffer.concat(log));assert.equal(code,0,file+" failed")
}
let browser,apiContext
try {
  const apiPort=await port(),webPort=await port(),webBase=`http://127.0.0.1:${webPort}`,serverBase=`http://127.0.0.1:${apiPort}`
  const server=start("go",["run","./cmd/iread"],path.join(repoRoot,"server"),{IREAD_ADDR:`127.0.0.1:${apiPort}`,IREAD_PUBLIC_ORIGIN:webBase,IREAD_BOOKS_DIR:path.join(runtime,"books"),IREAD_DB_DIR:path.join(runtime,"db"),IREAD_CACHE_DIR:path.join(runtime,"cache"),IREAD_WEB_DIR:path.join(runtime,"web"),IREAD_ENV:"development",IREAD_DEV_NO_AUTH:"0",IREAD_SETUP_TOKEN:"",IREAD_LOG_LEVEL:"warn"})
  await ready(serverBase+"/healthz",server)
  const vite=start("pnpm",["exec","vite","--host","127.0.0.1","--port",String(webPort),"--strictPort"],webRoot,{IREAD_DEV_API:serverBase})
  await ready(webBase,vite)
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined,args:["--no-sandbox"]})
  const state=await createAuthenticatedStorageState(browser,webBase,"Reader-"+randomUUID())
  const statePath=path.join(runtime,"auth-state.json");writeFileSync(statePath,JSON.stringify(state),{mode:0o600});await browser.close();browser=null
  apiContext=await request.newContext({baseURL:webBase,storageState:statePath})
  const api=new AuthedApi(apiContext,webBase);await api.fetchStatus()
  const source=process.env.IREAD_TEST_EPUB
  const data=source ? readFileSync(source) : buildReaderEpub()
  const intent=await api.post("/api/v1/uploads",{clientUploadId:randomUUID(),fileName:source?path.basename(source):"generated-reader.epub",byteSize:data.length})
  assert.equal(intent.status,201)
  const response=await apiContext.put(`${webBase}/api/v1/uploads/${intent.payload.data.uploadId}/content`,{headers:{Origin:webBase,"X-CSRF-Token":api.csrfToken,"Content-Type":"application/epub+zip"},data})
  const result=(await response.json()).data,bookId=result.bookId??result.duplicateOfBookId
  assert.ok(bookId)
  const deadline=Date.now()+90000;let status
  while(Date.now()<deadline){status=(await api.get(`/api/v1/books/${bookId}`)).payload.data.status;if(status==="ready")break;if(status==="error"||status==="unsupported")throw Error("EPUB测试样本无法索引");await new Promise(resolve=>setTimeout(resolve,100))}
  assert.equal(status,"ready")
  const connectionPath=path.join(runtime,"connection.json")
  writeFileSync(connectionPath,JSON.stringify({webBase,serverBase,bookId,runtime,statePath}),{mode:0o600})
  console.log("Isolated reader evidence:",runtime)
  for(const file of ["reader-viewport.e2e.mjs","reader-settings-save.e2e.mjs","reader-settings-race.e2e.mjs","reader-search-hits.e2e.mjs"])await run(file,connectionPath)
  await run("reader-search-navigation.e2e.mjs",path.join(runtime,"pdf-connection.json"))
  if(process.env.IREAD_TEST_PDFS)await run("reader-real-pdf.e2e.mjs",connectionPath)
  writeFileSync(path.join(runtime,"result.json"),JSON.stringify({passed:true,generated:!source,scope:["viewport-and-content-input","epub-settings","book-autosave","pdf-search"]},null,2))
  console.log("PASS isolated reader improvement suite; evidence:",runtime)
} finally {await browser?.close();await apiContext?.dispose();stop()}
