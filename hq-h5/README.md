# hq-h5 · 商家总部运营监控 H5（三品牌）

## 设计要点

- 同一份 Vite + React 工程，通过 `--base=/csnc/` 或 `/xq/` 或 `/txp/` 构建出三套静态产物；运行时由 `detectBrand()` 从 URL 前缀拿到品牌 → 注入 CSS 变量（`--brand-color` 等）。
- 无品牌切换 UI：每个品牌的 H5 入口只属于该品牌钉钉群，token 内 `brand` 字段决定一切数据访问。
- 单一 Render service：Express 后端通过 `app.use('/csnc', express.static('dist/csnc'))` 等三条挂载，把同一份产物的不同 base 分发给三品牌；API `/api/hq/*` 共享。

## 目录

```
hq-h5/
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── tsconfig.json
├── index.html
└── src/
    ├── main.tsx          # 入口
    ├── App.tsx           # 路由（基于 import.meta.env.BASE_URL）
    ├── index.css         # tailwind + brand 变量
    ├── theme/brand.ts    # 三品牌主题 + detectBrand/applyTheme
    ├── api/hq.ts         # 同源 fetch + Bearer token
    ├── components/
    │   ├── AppShell.tsx  # 顶栏 + 底部 tab
    │   └── Ui.tsx        # Card/Badge/StatusDot/Empty
    └── pages/
        ├── MagicLogin.tsx  # /login?mt=xxx  Magic Link 消费
        ├── Dashboard.tsx   # 大盘 + 门店排行
        ├── ShopDetail.tsx  # 门店缺货明细 + 多选派单
        ├── SkuCrossShop.tsx# 条码跨店在架矩阵
        ├── TasksPage.tsx   # 派单流水 + SLA
        └── MePage.tsx      # 个人信息 + 退出
```

## 本地开发

```bash
cd hq-h5
npm install
npm run dev:csnc        # 模拟成山农场，访问 http://localhost:5183/csnc/
npm run dev:xq          # 兴勤
npm run dev:txp         # 淘小胖
```

后端默认 `http://localhost:7788`（与店长端 MVP 共用），Vite dev 代理 `/api` 到那里。

## 生产构建

```bash
npm run build:all       # 输出 dist/csnc, dist/xq, dist/txp
```

Express 端按品牌 mount 静态目录（参考 `../backend/server.js` 改造说明）：

```js
app.use('/csnc', express.static(path.join(__dirname, '../hq-h5/dist/csnc')));
app.use('/xq',   express.static(path.join(__dirname, '../hq-h5/dist/xq')));
app.use('/txp',  express.static(path.join(__dirname, '../hq-h5/dist/txp')));
// SPA fallback (避免 react-router 刷新 404)
['/csnc', '/xq', '/txp'].forEach((p) => {
  app.get(`${p}/*`, (req, res) => {
    res.sendFile(path.join(__dirname, `../hq-h5/dist${p}/index.html`));
  });
});
```

## 与店长端 MVP 的关系

- 复用同一个 SQLite (`mvp.db`) 与 `/v1/*` 服务；HQ 端只新增 `/api/hq/*`。
- 派单后 INSERT 进同一张 `tasks` 表，`source='hq_assigned'`，店长端 H5 自动看到，且通过钉钉群 @ 通知到课长。
- 三品牌完全数据隔离：HQ 中间件 `hqAuth()` 解出 `req.hqUser.brand`，所有 SQL 都带 `WHERE shop.brand = ?` 过滤。

## 上线 Checklist

- [ ] `npm run build:all` 在 CI 通过
- [ ] Render 启动命令含 `node backend/server.js` 且静态目录正确
- [ ] 三品牌钉钉群 webhook 配置：`HQ_WEBHOOK_CSNC` / `HQ_WEBHOOK_XQ` / `HQ_WEBHOOK_TXP`
- [ ] 群机器人关键词包含「推送」
- [ ] HQ 早报 cron（9:00 / 14:00）能成功发出带 Magic Link 的卡片
- [ ] HQ 派单后能 @ 到对应门店课长手机号
