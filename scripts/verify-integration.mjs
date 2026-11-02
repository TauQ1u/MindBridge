import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

mkdirSync('verify-shots', { recursive: true })
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
page.on('pageerror', (e) => errors.push(`page: ${e.message}`))

// 复核页：裁决全部冲突直到门禁放行
async function completeReviewFlow() {
  await page.waitForURL('**/review')
  const reviewVideo = page.locator('.player video')
  await reviewVideo.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const v = document.querySelector('.player video')
    return v && v.readyState >= 1 && v.duration > 300
  })
  for (let i = 0; i < 12; i++) {
    if (await page.locator('.rev__progress.done').count()) break
    await page.getByRole('button', { name: '采用视频' }).click()
    await page.getByText('✓ 已保存至后端并持久化').waitFor()
    await page.waitForTimeout(250)
  }
  if (!(await page.locator('.rev__progress.done').count())) throw new Error('review gate never opened')
  await page.getByRole('button', { name: /完成复核并返回/ }).click()
  await page.waitForURL('**/mpfc')
}

// 1. 全鼠脑首页：大脑 + 右侧脑区介绍栏
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
await page.locator('.brain-viewer canvas').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('.info-card h2').getByText('内侧前额叶皮层').waitFor({ timeout: 30000 })
await page.locator('.info-image img').waitFor({ state: 'visible', timeout: 30000 })
await page.screenshot({ path: 'verify-shots/01-home.png' })

// 2. 进入 mPFC：真实空状态
await page.getByRole('button', { name: /进入 mPFC 工作区/ }).click()
await page.waitForURL('**/mpfc')
await page.locator('.viewer__empty').getByText('尚未导入实验数据', { exact: true }).waitFor()
await page.screenshot({ path: 'verify-shots/02-mpfc-empty.png' })

// 3. 数据中心弹窗 → 导入第一组
await page.locator('.viewer__empty').getByRole('button', { name: '选择实验数据' }).click()
await page.getByText('服务器已发现 3 组小鼠实验数据').waitFor()
await page.screenshot({ path: 'verify-shots/03-modal.png' })
await page.getByRole('button', { name: '导入' }).first().click()
await page.waitForURL('**/processing')

// 4. 数据处理：四阶段流程，逐步动画后不再出现可视化分析模块
for (const title of ['数据接入', '智能分析', '时间轴对齐', '一致性复核']) {
  await page.locator('.stage__head h3', { hasText: title }).waitFor()
}
if (await page.getByText('可视化分析', { exact: true }).count()) throw new Error('visualization stage should be removed')
await page.waitForTimeout(700)
await page.screenshot({ path: 'verify-shots/04-processing.png' })
await page.getByRole('button', { name: /进入一致性复核/ }).click()

// 5. 一致性复核（含门禁：必须裁决全部冲突）
await page.getByText(/冲突 \d+ \/ \d+/).waitFor()
await page.screenshot({ path: 'verify-shots/05-review.png' })
await completeReviewFlow()

// 6. mPFC 工作区：3D + 真实视频 + 复合时间轴
await page.locator('.viewer__stage canvas').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('.video-stage video').waitFor({ state: 'visible' })
await page.waitForFunction(() => {
  const v = document.querySelector('.video-stage video')
  return v && v.readyState >= 1 && v.duration > 300
})
await page.locator('.tl-time').getByText(/\d{2}:\d{2}\.\d{3} \/ \d{2}:\d{2}\.\d{3}/).waitFor()
await page.locator('.tl-activity svg polyline').waitFor({ state: 'visible' })
await page.screenshot({ path: 'verify-shots/06-mpfc-loaded.png' })

// 7. 播放联动 + 自由滑动
const timeBefore = await page.locator('.tl-time').innerText()
await page.locator('.tl-btn--main').click()
await page.waitForTimeout(1500)
const timeAfter = await page.locator('.tl-time').innerText()
if (timeBefore === timeAfter) throw new Error('playback did not advance timestamp')
const videoPlaying = await page.evaluate(() => { const v = document.querySelector('.video-stage video'); return v && !v.paused })
if (!videoPlaying) throw new Error('video did not follow playback state')
await page.locator('.tl-btn--main').click()
// 视频式拖动：按下拖到 60% 处，时间应跳转到约 60% 时长
const box = await page.locator('.tl-tracks').boundingBox()
const duration = await page.evaluate(() => document.querySelector('.tl-time').textContent)
await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(300)
const scrubbed = await page.locator('.tl-time').innerText()
console.log('scrub check:', duration, '→', scrubbed)
if (scrubbed === timeAfter) throw new Error('free scrub did not move timestamp')

// 8. 神经元搜索 → 详情抽屉
await page.locator('.viewer__search input').fill('n1')
await page.locator('.search-pop button').first().click()
await page.locator('.detail-drawer .neuron__badge .neuron__id').waitFor({ state: 'visible' })
await page.waitForTimeout(500)
await page.screenshot({ path: 'verify-shots/07-neuron-detail.png' })
await page.locator('.drawer-head button').click()

// 9. 第二条件：导入 → 处理 → 复核（门禁）→ 返回
await page.locator('.rail-add').click()
await page.getByRole('button', { name: '导入' }).first().click()
await page.waitForURL('**/processing')
await page.getByRole('button', { name: /进入一致性复核/ }).click()
await completeReviewFlow()
await page.locator('.rail-head b').getByText('2', { exact: true }).waitFor()

// 10. 条件对比抽屉
await page.getByRole('button', { name: '条件对比' }).click()
await page.locator('.compare__chart canvas').waitFor({ state: 'visible' })
await page.waitForTimeout(800)
await page.screenshot({ path: 'verify-shots/08-compare.png' })
await page.locator('.drawer-head button').click()

// 11. 报告生成与下载
await page.getByRole('button', { name: '生成报告' }).click()
await page.locator('.detail-drawer').getByRole('button', { name: '生成分析报告' }).click()
const download = page.getByRole('link', { name: '下载报告' })
await download.waitFor()
if ((await download.getAttribute('href')) !== '/data/reports/compare_2.md') throw new Error('two-condition report URL mismatch')
await page.screenshot({ path: 'verify-shots/09-report.png' })

if (errors.length) throw new Error(errors.join('\n'))
console.log(JSON.stringify({ route: new URL(page.url()).pathname, loadedConditions: 2, reviewGate: 'enforced', scrub: 'live', report: 'compare_2.md', runtimeErrors: errors.length }))
await browser.close()
