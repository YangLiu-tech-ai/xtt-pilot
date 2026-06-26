# D5 Pilot 运行手册 · 淘小胖龙湖天街

> 端到端操作流程，从环境就绪到首次真实推送

---

## 0. 环境依赖确认

| 组件 | 路径/地址 | 状态确认方式 |
|------|-----------|--------------|
| Node.js | `node -v` ≥ 18 | 命令行验证 |
| MVP 后端 | `backend/server.js` | `curl localhost:7788/v1/health` |
| SQLite DB | `backend/mvp.db` | 文件存在 |
| cloudflared | 项目根/cloudflared.exe | `cloudflared --version` |
| 门店群 Webhook | DING_WEBHOOK_STORE | 环境变量已设 |
| 运营群 Webhook | DING_WEBHOOK_OPS | 环境变量已设 |

---

## 1. Pre-flight 检查清单

```batch
cd outputs\xintongtu-mvp

:: 1.1 清理可能残留的 DB 锁
rmdir backend\mvp.db.lock 2>nul

:: 1.2 确认无残留进程
netstat -ano | findstr :7788
:: 如有输出 → taskkill /PID <PID> /F

:: 1.3 启动后端
cd backend
node server.js > ..\srv.log 2>&1
:: 另开终端验证
curl http://localhost:7788/v1/health
:: 期望: {"ok":true,"db":"connected","tasks":...}
```

---

## 2. 灌入 Pilot 数据

```batch
:: 停后端(避免 DB locked)  → 灌数据 → 重启
:: 方式 A: 使用内置示例
node scripts\seed-pilot.js

:: 方式 B: 导入真实缺货 JSON
:: JSON 格式: [{barcode, item_name, category, yesterday_sales, stock, suggest_price}]
node scripts\seed-pilot.js pilot-data.json
```

输出结果包含:
- 任务数量 + 替代品数量
- Token(用于 H5 鉴权)
- 本地 H5 地址
- 公网 H5 地址(待填 tunnel domain)

---

## 3. 启动 cloudflared 隧道

```batch
:: 3.1 确保后端在跑
curl -s http://localhost:7788/v1/health

:: 3.2 启动隧道
scripts\start-tunnel.bat
:: 或手动:
cloudflared.exe tunnel --url http://localhost:7788
```

控制台输出示例:
```
Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):
https://xxx-yyy-zzz.trycloudflare.com
```

**记录此域名**，后续步骤需要用到。

验证公网可访问:
```bash
curl https://xxx-yyy-zzz.trycloudflare.com/v1/health
curl https://xxx-yyy-zzz.trycloudflare.com/h5/preview.html
```

---

## 4. 配置钉钉推送

### 4.1 设置环境变量

```batch
set DING_WEBHOOK_STORE=https://oapi.dingtalk.com/robot/send?access_token=<门店群token>
set DING_WEBHOOK_OPS=https://oapi.dingtalk.com/robot/send?access_token=<运营群token>
```

### 4.2 Dry-run 测试推送

```batch
cd backend
node notifier.js test-shortage %DING_WEBHOOK_STORE% "https://xxx-yyy-zzz.trycloudflare.com/h5/preview.html?token=<TOKEN>"
```

期望:
- 门店群收到 ActionCard 卡片
- 点击「打开补品清单」能跳转 H5 页
- H5 能正常展示缺货列表

---

## 5. 正式 Pilot 推送流程

### 5.1 数据流

```
[缺货数据] → seed-pilot.js → SQLite
                                  ↓
[cloudflared]  ←— server.js ←— 课长 H5 操作
      ↓                           ↑
[钉钉群]  →  ActionCard  →  点击链接 → H5 处理页
```

### 5.2 推送给课长

```batch
:: notifier 从 DB 读取 PENDING 任务并推送
:: (当前版本是手动触发，后续接 cron)
node notifier.js test-shortage %DING_WEBHOOK_STORE% "https://xxx-yyy-zzz.trycloudflare.com/h5/preview.html?token=<TOKEN>"
```

### 5.3 课长操作后观察

监控 DB 状态变化:
```batch
:: 在 backend 目录下
node -e "const db=require('./db'); const r=db.prepare('SELECT status, COUNT(*) c FROM tasks GROUP BY status').all(); console.table(r);"
```

监控 whale-batches 输出:
```batch
dir whale-batches\%date:~0,4%-%date:~5,2%-%date:~8,2%\
:: 应出现 .shelf.jsonl / .substitute.jsonl
```

---

## 6. 异常处理

| 场景 | 症状 | 处置 |
|------|------|------|
| DB locked | 启动报错 `SQLITE_BUSY` | `rmdir backend\mvp.db.lock` |
| tunnel 断连 | H5 无法访问 | 重跑 `start-tunnel.bat`（域名会变） |
| webhook 403 | 推送返回 errcode≠0 | 检查 token 是否过期/IP白名单 |
| 课长 H5 白屏 | Token 无效/过期 | 重新 `seed-pilot.js` 生成新 token |
| whale 执行失败 | status=FAILED | 查 `whale-batches/_review/` CSV |
| 推送无反应 | notifier 输出 errcode=0 但群没卡片 | 确认机器人未被禁言/未过安全设置 |

---

## 7. 收尾 & 数据保全

```batch
:: 7.1 导出 Pilot 结果
node -e "const db=require('./db'); const r=db.prepare('SELECT id,sku,item_name,status,updated_at FROM tasks ORDER BY id').all(); console.log(JSON.stringify(r,null,2));" > ..\pilot-result.json

:: 7.2 停止服务
:: Ctrl+C 关闭 server.js
:: Ctrl+C 关闭 cloudflared

:: 7.3 whale dry-mode 批次留存
:: whale-batches/ 目录下 JSONL 文件自动按日期归档
```

---

## 8. Pilot 清单 (TODO)

- [ ] 填写 `seed-pilot.js` 中 STORE.manager_name / manager_dingtalk_id
- [ ] 获取 门店群 webhook token → DING_WEBHOOK_STORE
- [ ] 获取 运营群 webhook token → DING_WEBHOOK_OPS
- [ ] cloudflared.exe 就位
- [ ] 首次 dry-run: webhook 推送成功
- [ ] 首次 dry-run: H5 可通过公网访问
- [ ] 首次 dry-run: 课长操作一条任务 → status 变更
- [ ] 正式推: 与课长约定时间窗口 (建议 10:00 AM)
- [ ] 正式推: 观察全量任务流转 → 导出 pilot-result.json

---

## 附录 A: 关键环境变量

```env
# .env 示例 (放 backend/ 目录, 不含等号前后空格)
PORT=7788
JWT_SECRET=xintongtu-mvp-secret
WHALE_MODE=dry
DING_WEBHOOK_STORE=https://oapi.dingtalk.com/robot/send?access_token=xxx
DING_WEBHOOK_OPS=https://oapi.dingtalk.com/robot/send?access_token=yyy
```

## 附录 B: H5 URL 构造

```
https://<tunnel-domain>/h5/preview.html?token=<JWT>
```

Token 有效期: 7 天 (seed-pilot.js 签发时设置)。到期后重新运行 seed 即可刷新。

## 附录 C: Whale Adapter 模式

| 模式 | 环境变量 WHALE_MODE | 行为 |
|------|---------------------|------|
| dry | `dry` (默认) | 只写 JSONL 文件，不调真实接口 |
| simulate | `simulate` | 模拟调用，随机 80% 成功 |
| real | `real` | 真实调用鲸品云 API (需配置 cookie) |

Pilot 阶段保持 `dry` 模式，验证完整流程后再切 `real`。
