import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const server = await createServer({ configFile: false, root, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'localization-fixture', configureServer(vite) { vite.middlewares.use('/localization-fixture', (_req, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/artifacts/localization/browser-fixture.tsx"></script></body></html>') }) } }] })
let browser
const errors = []
try {
  await server.listen()
  const port = server.httpServer.address().port
  const executablePath = process.env.TTYPORA_CHROMIUM_EXECUTABLE ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const page = await browser.newPage()
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${port}/localization-fixture`)
  await page.getByLabel('界面语言', { exact: true }).waitFor()
  assert.equal(await page.getByRole('status').innerText(), '已保存：我的正文.md')
  const body = await page.getByLabel('Document body').inputValue()
  await page.getByLabel('界面语言', { exact: true }).selectOption('en')
  await page.getByLabel('Interface language', { exact: true }).waitFor()
  assert.equal(await page.getByRole('status').innerText(), 'Saved: 我的正文.md')
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).getAttribute('title'), 'Save document')
  assert.equal(await page.locator('html').getAttribute('lang'), 'en')
  assert.equal(await page.getByLabel('Document body').inputValue(), body)
  assert.equal(await page.getByTestId('filename').innerText(), 'G:/笔记/我的正文.md')
  assert.equal(await page.evaluate(() => window.fixtureMounts), 1)
  assert.equal(await page.evaluate(() => localStorage.getItem('ttypora.interface-language')), 'en')
  await page.reload()
  await page.getByLabel('Interface language', { exact: true }).waitFor()
  assert.equal(await page.getByRole('status').innerText(), 'Saved: 我的正文.md')
  await page.getByLabel('Interface language', { exact: true }).selectOption('zh-CN')
  await page.getByLabel('界面语言', { exact: true }).waitFor()
  assert.equal(await page.getByRole('status').innerText(), '已保存：我的正文.md')
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
  assert.equal(await page.getByLabel('Document body').inputValue(), body)
  await page.evaluate(() => { localStorage.setItem('ttypora.interface-language', 'en'); window.dispatchEvent(new StorageEvent('storage', { key: 'ttypora.interface-language', newValue: 'en' })) })
  await page.getByLabel('Interface language', { exact: true }).waitFor()
  assert.equal(await page.getByRole('status').innerText(), 'Saved: 我的正文.md')
  assert.equal(await page.evaluate(() => window.fixtureMounts), 1)
  assert.deepEqual(errors, [])
  const report = { verifiedAt: new Date().toISOString(), immediateSwitch: true, statusUpdates: true, persistedAfterReload: true, storageSynchronization: true, bodyAndPathUnchanged: true, componentMountsPerPage: 1, localeEvents: await page.evaluate(() => window.localeEvents), pageErrors: errors }
  await writeFile(path.join(root, 'artifacts/localization/realtime-verification.json'), JSON.stringify(report, null, 2))
  console.log('Interface language switches immediately, persists after reload and syncs storage without remounting content or changing document text/path.')
} finally { await browser?.close(); await server.close() }
