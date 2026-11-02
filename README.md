# MindBridge

小鼠 mPFC 多模态神经数据分析与可视化工作站，默认使用预计算演示数据。

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

前端：`http://localhost:5173`；后端检查：`http://localhost:3001/api/health`。本地默认账号 `admin / MindBridge@2026`，仅供开发。

生产运行：`npm run build && npm start`。Pages 静态产物发布在 `MindBridge-site`；登录和数据功能需另行部署后端，并设置 `VITE_API_BASE_URL`、`MINDBRIDGE_ALLOWED_ORIGINS` 与 HTTPS 安全选项。
