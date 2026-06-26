# D3 · OneDay 低代码搭建说明书

> 新通途生鲜出勤补品 H5 · 课长端
> 后端：`http://localhost:7788/v1`（D4 上 cloudflared 后替换为 HTTPS 公网域）
> 鉴权：URL token (`?token=xxx`) → 接口透传到 Header `X-Auth-Token` 或 query `token`

---

## 1. 应用骨架

```
应用名: xtt-shortage-h5
应用类型: H5 / 移动端
默认页: /pages/list?token={query.token}
全局变量:
  - token        (来源: URL query.token, 持久化到 localStorage 兜底)
  - apiBase      (来源: 配置, 默认 'http://localhost:7788/v1')
  - storeId      (来源: 接口返回, 不在 URL 暴露)
```

**URL 形态**：`https://xtt.oneday.alibaba.net/pages/list?token=eyJ...dapC0kWjFq...`
（72h 内有效，过期跳 `/pages/expired`）

---

## 2. 接口绑定（4 个面向 H5 的 v1 接口）

低代码搭建里把每个接口配成一个「数据源」。注意 worker 内部的 2 个 `/v1/internal/...` 接口 **不暴露给前端**，由 worker.js 独占。状态轮询接口 (`/tasks/:id/status`) 保留为内部监控用途，H5 不直接调用。

### 2.1 拉缺货清单
```
名称: ds_tasks
方法: GET
URL: {apiBase}/tasks
Query: token={token}
返回: { ok, store, tasks: [...] }
绑定: 列表页 主列表数据源
```

### 2.2 任务详情
```
名称: ds_task_detail
方法: GET
URL: {apiBase}/tasks/{taskId}
Query: token={token}
返回: { ok, task, substitutes: [...] }
绑定: 详情页 主数据源
触发: 列表项 click 跳详情页时携带 taskId
```

### 2.3 一键操作
```
名称: act_task
方法: POST
URL: {apiBase}/tasks/{taskId}/act
Query: token={token}
Body: { action: 'shelf' | 'shortage' | 'substitute', substituteSku? }
成功: { ok:true, taskId, status:'EXECUTING'|'SHORTAGE' }
冲突 409: { err:'STATE_CONFLICT', current } → 提示「已被处理，刷新列表」
绑定: 详情页 操作按钮；操作后直接 toast「操作已提交」返回列表
```

### 2.4 健康检查
```
名称: ds_health
方法: GET
URL: {apiBase}/health
绑定: 顶栏右上「服务状态」小圆点；红色=离线，绿色=在线+显示 PENDING 数
```

---

## 3. 三屏组件树

### 屏 1：缺货清单（`/pages/list`）

```
TopBar
  ├─ Title: "今日缺货补品 · {store}"
  ├─ HealthDot (绑 ds_health)
  └─ RefreshButton (重拉 ds_tasks)

EmptyState (条件: ds_tasks.tasks.length === 0)
  └─ "🎉 暂无缺货，做得不错！"

TaskList (绑 ds_tasks.tasks, key=id)
  └─ TaskCard
      ├─ Image (task.image_url, 圆角 80x80)
      ├─ Title (task.item_name)
      ├─ Subline: "条码 {task.barcode}"
      ├─ MetricRow:
      │     • 昨日销 {task.yesterday_sales} 单
      │     • 库存 {task.stock}
      │     • 建议售价 ¥{task.suggest_price}
      ├─ StatusBadge (按 task.status 着色)
      │     PENDING → "⏳ 待处理"
      │     EXECUTING → "🤖 系统上架中…"
      │     SHORTAGE → "🚫 已标缺货"
      │     DONE → "✅ 已上架"
      │     FAILED → "⚠️ 上架失败"
      │     MANUAL → "🔧 转人工"
      └─ onClick → navigate('/pages/detail', { taskId: task.id, token })
```

排序：服务端已按 `priority + created_at` 排，前端不需再排。

### 屏 2：任务详情（`/pages/detail`）

```
HeaderImage (task.image_url, 全宽)
TitleBlock: task.item_name + StatusBadge
MetaTable:
  ├─ 条码 / 类目
  ├─ 昨日销 / 库存
  └─ 建议售价 (只读展示，不可编辑)

PrimaryActionBar (三个按钮，固定底部)
  ├─ 🛒「一键上架」 → act_task({action:'shelf'}) → toast「操作已提交」→ 返回列表
  ├─ 🔁「换替代品」 → 展开 SubstituteSheet → 选中后 act_task({action:'substitute', substituteSku}) → toast → 返回
  └─ ❌「确认缺货」 → 二次确认 → act_task({action:'shortage'}) → toast「已标缺货」→ 返回

SubstituteSheet (绑 ds_task_detail.substitutes)
  └─ Card 列表 (每个含 sub_name / sub_price / sub_stock / score)
```

**异步操作模型**：操作提交后不等待 agent 执行结果，直接提示「操作已提交」返回列表。
Agent 在后台异步执行，若上架失败则推送至平台运营/商家运营端处理，减少课长二次操作。

### 屏 3：已处理记录（`/pages/done`，可选 P1）

只显示 `status IN (DONE, SHORTAGE, FAILED, MANUAL)` 的卡片，按 `updated_at` 倒序。
低代码里用同一个 ds_tasks 数据源 + 客户端过滤即可。

---

## 4. 状态机 ↔ UI 一览

| 后端 status | UI 上的体现 | 用户能做什么 |
|---|---|---|
| PENDING | 列表「⏳待处理」/ 详情三按钮可点 | 上架 / 换品 / 缺货 |
| EXECUTING | 列表「🤖系统上架中」/ 不阻塞用户 | 无需操作，等后台结果 |
| DONE | 列表「✅已上架」 | 看看 |
| SHORTAGE | 列表「🚫缺货已标」 | 看看 |
| FAILED | 列表「⚠️失败」(已推送平台运营) | 课长无需二次操作 |
| MANUAL | 列表「🔧转人工」 | 不操作 |

> **注**：优先级标签（核心引流品 / 爆好价品 / 常规品）仅在平台小二 & 商家运营的监控端展示，课长操作端不透出。

---

## 5. Token 处理

```js
// OneDay 全局初始化钩子（在 App.onLaunch 等位置）
const token = query.token || localStorage.getItem('xtt_token');
if (!token) { navigate('/pages/expired'); return; }
localStorage.setItem('xtt_token', token);
globalState.token = token;

// 所有请求拦截器
beforeRequest(req) {
  req.params = { ...req.params, token: globalState.token };
  return req;
}
afterResponse(res) {
  if (res.status === 401 || res.data?.err === 'BAD_TOKEN' || res.data?.err === 'EXPIRED') {
    navigate('/pages/expired');
  }
  return res;
}
```

---

## 6. 视觉规范（建议）

- 主色：饿了么蓝 #0073FF（按钮/链接）
- 强调色：果绿 #00C271（上架按钮）
- 警告色：橙 #FF8800（替代品）
- 危险色：红 #F5483B（缺货按钮）
- 字体：苹方/PingFang，正文 14px，标题 17px
- 圆角 8px，卡片间距 12px，移动端 padding 16px

---

## 7. 验收清单

```
[ ] 扫码进入 list 页能看到 5 个 PENDING 任务（D1 seed 数据）
[ ] 列表不显示优先级标签，只显示状态 badge
[ ] 点击任意一项 → 跳详情，能看到 3 个替代品
[ ] 详情页售价为只读展示（不可编辑）
[ ] 点「一键上架」→ toast「操作已提交」→ 自动返回列表
[ ] 标缺货 → toast「已标缺货」→ 返回列表
[ ] token 过期 → 跳 expired 页
[ ] 不传 token → 跳 expired 页
[ ] 切到无网络 → HealthDot 变红
```

---

## 8. 部署提示

OneDay 低代码不需要 `npm install` / `oneday create --wait`，搭好直接发布即可。
但要注意：
- 接口 `apiBase` 必须是 OneDay 能访问的域。本地 `localhost:7788` 在 OneDay 服务器上访问不到，所以 **D3 验证只能在本机调试预览**；
- 正式跑通需要 D4 cloudflared 把 7788 暴露出 HTTPS 域名，再把 `apiBase` 改成那个域名。

---

## 9. 后续接入点（D3 之后）

- 用户头像 / 课长姓名：当前 token 只携带 dingId，后续可加 `/v1/me` 接口返回 manager_name
- 推送回执：钉钉 ActionCard 点击 singleURL 直跳 H5 详情页，URL 形态：
  `{apiBase宿主}/pages/detail?token={token}&taskId={task.id}`
  （后端 notifier.js 已为 D5 留好 singleURL，pushShortageCard h5Url 参数）
