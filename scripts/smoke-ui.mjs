// Exercise the public UI after the 0.12 chrome simplification.
export async function showFormattingToolbar(application, page) {
  await page.locator('.ProseMirror, .source-editor .cm-content').waitFor()
  await page.locator('.editor-loading').waitFor({ state: 'detached' })
  if (await page.locator('.editor-toolbar').count()) return
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', 'toggle-formatting-toolbar'))
  await page.locator('.editor-toolbar').waitFor()
}

export async function cycleAppearance(page) {
  await page.locator('.command-trigger').click()
  const english = await page.evaluate(() => document.documentElement.lang === 'en')
  await page.locator('.command-search input').fill(english ? 'Switch light / dark appearance' : '切换明亮 / 暗色主题')
  await page.locator('.command-search input').press('Enter')
  await page.locator('.command-search').waitFor({ state: 'detached' })
}
