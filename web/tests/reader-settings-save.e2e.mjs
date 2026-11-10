import assert from 'node:assert/strict'
import { readFileSync,writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
const connectionPath = process.env.IREAD_READER_FIX_CONNECTION
assert.ok(connectionPath?.startsWith("/tmp/"), "需要任务隔离环境")
const c=JSON.parse(readFileSync(connectionPath,'utf8'))
assert.ok(c.webBase.startsWith("http://127.0.0.1:"))
assert.ok(c.statePath.startsWith(connectionPath.slice(0, connectionPath.lastIndexOf("/"))))
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || undefined,args:['--no-sandbox']})
const context=await browser.newContext({viewport:{width:1440,height:900},storageState:c.statePath,serviceWorkers:'block'})
const page=await context.newPage();const writes=[];page.on('request',r=>{if(r.method()==='PUT' && r.url().includes('/api/v1/'))writes.push({url:new URL(r.url()).pathname,body:r.postDataJSON()})})
const bookPath=`/api/v1/books/${c.bookId}/reader-overrides`
const get=async p=>page.evaluate(async p=>(await(await fetch(p)).json()).data,p)
const waitBody=(property,value)=>page.waitForFunction(([property,value])=>{const doc=document.querySelector("foliate-view")?.renderer?.getContents()[0]?.doc;return doc && getComputedStyle(doc.body)[property]===value},[property,value],{timeout:10000})
const waitSaved=()=>page.locator('[data-reader-autosave="saved"]').waitFor({timeout:10000})
const open=async()=>{await page.goto(`${c.webBase}/read/${c.bookId}`);await page.waitForSelector('[data-reader-engine-ready]');await page.getByRole('button',{name:'阅读设置',exact:true}).click();await page.waitForSelector('[data-reader-panel="settings"]')}
const body=()=>page.evaluate(()=>{const v=document.querySelector('foliate-view');const d=v.renderer.getContents()[0].doc;const s=getComputedStyle(d.body);return {fontSize:s.fontSize,fontWeight:s.fontWeight,background:s.backgroundColor,color:s.color,css:v.renderer.getContents()[0].doc.documentElement.outerHTML.includes('font-weight: 700')}})
try {
 await open();const initialGlobal=await get('/api/v1/settings/reader');const current=await get(bookPath)
 console.log('STEP controls and actual preview')
 await page.locator('.iread-reader-settings__field').filter({has:page.getByText('字重',{exact:true})}).getByRole('slider').press('End');await page.locator('.iread-reader-settings__field').filter({has:page.getByText('字重',{exact:true})}).getByRole('slider').press('ArrowLeft');await page.locator('.iread-reader-settings__field').filter({has:page.getByText('字重',{exact:true})}).getByRole('slider').press('ArrowLeft');await waitSaved();await waitBody('fontWeight','700');assert.equal((await body()).fontWeight,'700')
 await page.locator('#reader-setting-reflow-theme').click();await page.getByRole('option',{name:'深蓝黑',exact:true}).click();await waitSaved();const dark=await body();assert.notEqual(dark.background,'rgb(255, 255, 255)')
 await page.locator('#reader-setting-reflow-theme').click();await page.getByRole('option',{name:'纯白',exact:true}).click();await waitSaved()
 for(const [label,value]of[['正文背景','#f0f0f0'],['正文文字','#222222'],['正文链接','#123456'],['选区背景','#cccccc']]){await page.getByRole('textbox',{name:`${label}自定义颜色`,exact:true}).fill(value);await waitSaved()}
 await waitBody('backgroundColor','rgb(240, 240, 240)');await waitBody('color','rgb(34, 34, 34)');assert.equal((await body()).background,'rgb(240, 240, 240)');assert.equal((await body()).color,'rgb(34, 34, 34)')
 const saved=await get(bookPath);assert.equal(saved.overrides.reflow.fontWeight,700);assert.equal(saved.overrides.reflow.selection,'#cccccc');assert.equal(writes.filter(w=>w.url==='/api/v1/settings/reader').length,0)
 await page.getByRole('textbox',{name:'正文文字自定义颜色',exact:true}).fill('#f0f0f0');await page.getByRole('alert').filter({hasText:'文字与背景对比度不足'}).waitFor();assert.equal((await body()).color,'rgb(34, 34, 34)')
 await page.reload();await page.waitForSelector('[data-reader-engine-ready]');assert.equal((await body()).fontWeight,'700');assert.equal((await body()).background,'rgb(240, 240, 240)');await page.getByRole('button',{name:'阅读设置',exact:true}).click()
 console.log('STEP explicit global after auto acknowledgement')
 await page.getByRole('button',{name:'设为全局默认',exact:true}).click();await page.getByText('已设为全局默认值；未删除其他书籍的本书覆盖。',{exact:true}).waitFor();assert.equal(writes.filter(w=>w.url==='/api/v1/settings/reader').length,1)
 const global=await get('/api/v1/settings/reader');assert.equal(global.value.reflow.fontWeight,700);assert.deepEqual(global.value.pdf,initialGlobal.value.pdf)
 console.log('STEP offline draft then reopen')
 await context.setOffline(true);await page.locator('.iread-reader-settings__field').filter({has:page.getByText('字号',{exact:true})}).getByRole('slider').press('ArrowRight');await page.locator('[data-reader-autosave="error"]').waitFor({timeout:10000});const offline=await body();assert.notEqual(offline.fontSize,`${saved.effectiveValues.reflow.fontSize}px`)
 const local=await page.evaluate(()=>Object.entries(localStorage).find(([k])=>k.startsWith('iread.reader-settings-draft.v1:') && !k.endsWith(':pending'))?.[1]);assert.ok(JSON.parse(local).values['reflow.fontSize'])
 await context.setOffline(false);await page.reload();await page.waitForSelector('[data-reader-engine-ready]');await page.getByRole('button',{name:'阅读设置',exact:true}).click();await waitSaved();assert.equal((await body()).fontSize,offline.fontSize)
 console.log('STEP real stale revision and explicit conflict resolution')
 await page.evaluate(async ({bookPath})=>{const s=(await(await fetch('/api/v1/auth/status')).json()).data;const r=(await(await fetch(bookPath)).json()).data;await fetch(bookPath,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrfToken},body:JSON.stringify({schemaVersion:1,fileVersion:r.fileVersion,baseRevision:r.revision,overrides:{...r.overrides,reflow:{...r.overrides.reflow,lineHeight:1.9}}})})},{bookPath})
 await page.locator('.iread-reader-settings__field').filter({has:page.getByText('字号',{exact:true})}).getByRole('slider').press('ArrowRight');await page.locator('[data-reader-autosave="conflict"]').waitFor();assert.ok((await get(bookPath)).effectiveValues.reflow.lineHeight===1.9)
 await page.getByRole('button',{name:'保留本机选择并重新保存',exact:true}).click();await waitSaved();assert.equal((await get(bookPath)).effectiveValues.reflow.lineHeight,1.9)
 console.log('STEP reset')
 await page.getByRole('button',{name:'恢复本书默认',exact:true}).click();await waitSaved();assert.deepEqual((await get(bookPath)).overrides,{})
 await page.screenshot({path:`${c.runtime}/shots/settings-verified.png`});writeFileSync(`${c.runtime}/settings-regression.json`,JSON.stringify({passed:true,bookWrites:writes.filter(w=>w.url===bookPath).length,globalWrites:writes.filter(w=>w.url==='/api/v1/settings/reader').length,initialRevision:current.revision,finalRevision:(await get(bookPath)).revision,body:await body()},null,2));console.log('PASS settings actual controls / server / reopen / offline / 409 / reset')
} finally {await browser.close()}
