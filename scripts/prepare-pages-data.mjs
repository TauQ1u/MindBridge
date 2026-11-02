import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distData = path.join(root, 'dist', 'data')
const sourceData = path.join(root, 'server', 'data')

await mkdir(path.join(distData, 'analyses'), { recursive: true })
await cp(path.join(sourceData, 'analyses'), path.join(distData, 'analyses'), { recursive: true })

for (const condition of ['healthy', 'cort_like', 'ketamine_like_recovery']) {
  const source = path.join(sourceData, 'experiments', condition, 'versions', 'demo-v1', 'model_output')
  const destination = path.join(distData, 'model_output', condition)
  await mkdir(destination, { recursive: true })
  await cp(source, destination, { recursive: true })
}

console.log('Prepared static analysis and module demo data.')
