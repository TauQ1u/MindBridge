# MindBridge

小鼠 mPFC 多模态神经数据分析与可视化演示站，使用预计算数据和浏览器本地状态。

## 结构

- `src/`：Vue 前端、页面、状态和 3D 可视化。
- `server/`：Express API、数据与测试。
- `public/`：静态资源；`scripts/`：辅助工具。

## 启动

需要 Node.js 20+。项目根目录执行：

```bash
npm ci
npm run dev:full
```

前端：`http://localhost:5173`；后端检查：`http://localhost:3001/api/health`。先用 `node scripts/hash-password.mjs <密码>` 生成唯一管理员口令哈希并写入 `.env`；未设置时后端不会启动。

GitHub Pages 自动发布静态演示版，无需服务器。登录、复核和报告只保存在浏览器会话中；本地完整后端运行：`npm run build && npm start`。
