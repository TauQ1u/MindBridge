#!/usr/bin/env node
/**
 * 生成 MINDBRIDGE_ADMIN_PASSWORD_HASH（scrypt）。
 * 用法: node scripts/hash-password.mjs <密码>
 * 将输出写入 .env，勿把明文密码提交进仓库。
 */
import crypto from 'node:crypto'

const password = process.argv[2]

if (!password) {
  console.error('用法: node scripts/hash-password.mjs <密码>')
  process.exit(1)
}
if (password.length < 8) {
  console.error('密码长度至少 8 位')
  process.exit(1)
}

const params = { N: 16384, r: 8, p: 1 }
const salt = crypto.randomBytes(16).toString('hex')
const hash = crypto.scryptSync(password, salt, 64, params).toString('hex')

console.log(`MINDBRIDGE_ADMIN_PASSWORD_HASH=scrypt$${params.N}$${params.r}$${params.p}$${salt}$${hash}`)
