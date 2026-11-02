// 一次性脚本：将 src 下所有 CSS 字号按 SCALE 放大（四舍五入到 0.5px），
// 并同步 PhysiologicalSignalFigure / ReviewSignalViewer 的 canvas ctx.font
// 与 ConditionComparison 的 echarts fontSize。
// 用法：node scripts/scale-fonts.mjs
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCALE = 1.2

function scalePx(value) {
  const scaled = Math.round(parseFloat(value) * SCALE * 2) / 2
  return String(scaled)
}

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.(vue|css)$/.test(entry.name)) yield full
  }
}

let touched = 0
for await (const file of walk(path.join(root, 'src'))) {
  let text = await fs.readFile(file, 'utf8')
  const original = text
  // CSS 声明：font-size: 12px / font-size:12.5px
  text = text.replace(/font-size:\s*(\d+(?:\.\d+)?)px/g, (_m, v) => `font-size: ${scalePx(v)}px`)
  // canvas ctx.font = '11px ...' / '600 11px ...'
  text = text.replace(/ctx\.font = '([^']*)'/g, (_m, spec) => {
    const scaled = spec.replace(/(\d+(?:\.\d+)?)px/g, (_x, v) => `${scalePx(v)}px`)
    return `ctx.font = '${scaled}'`
  })
  // echarts fontSize: 10
  text = text.replace(/fontSize: (\d+(?:\.\d+)?)/g, (_m, v) => `fontSize: ${scalePx(v)}`)
  if (text !== original) {
    await fs.writeFile(file, text, 'utf8')
    touched += 1
    console.log('scaled:', path.relative(root, file))
  }
}
console.log(`done, ${touched} files touched`)
