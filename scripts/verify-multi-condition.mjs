import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--use-angle=swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
page.on('pageerror', error => errors.push(`page: ${error.message}`))

await page.goto('http://127.0.0.1:5173/mpfc', { waitUntil: 'networkidle' })
await page.evaluate(() => {
  localStorage.setItem('mindbridge.importedConditions', JSON.stringify(['healthy', 'cort_like', 'ketamine_like_recovery']))
  localStorage.setItem('mindbridge.activeCondition', 'cort_like')
})
await page.reload({ waitUntil: 'networkidle' })
await page.locator('.video-stage video').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('.viewer__stage canvas').waitFor({ state: 'visible', timeout: 30000 })
const restored = await page.locator('.mode-bar strong').innerText()
await page.locator('.rail-add').click()
const reopen = await page.getByRole('button', { name: '打开' }).count()
await page.getByRole('button', { name: '关闭' }).click()
await page.locator('.modal-overlay').waitFor({ state: 'hidden' })
await page.getByRole('button', { name: '多状态对比' }).click()
await page.waitForURL('**/analysis')
await page.getByRole('heading', { name: 'Multi-Condition Analysis' }).waitFor()
for (const label of ['Overview', 'Behavior', 'Neural & Module', 'Network', 'State Space', 'Transition', 'Report']) {
  await page.locator('.analysis-tabs button', { hasText: label }).click()
  await page.waitForTimeout(80)
}
await page.locator('.analysis-tabs button', { hasText: 'Overview' }).click()
await page.screenshot({ path: 'verify-shots/10-multi-condition-analysis.png', fullPage: true })
console.log(JSON.stringify({
  restored,
  reopen,
  conditions: await page.locator('.condition-selector button.active').count(),
  tabs: await page.locator('.analysis-tabs button').count(),
  errors,
}))
await browser.close()
if (errors.length) process.exit(1)
