# 新通途 MVP · 稳定部署方案评估

> 背景：localtunnel 免费服务 WebSocket 频繁断连（每隔数分钟），导致钉钉推送的 H5 链接打不开（Bad Gateway / 503）。  
> 需求：课长在外地城市、不同网络环境下，点钉钉卡片能秒开 H5 页面、稳定操作。

---

## 方案对比总览

| 维度 | A. 增强守护进程 (已完成) | B. 阿里云 ECS | C. Cloudflare Workers |
|------|-------------------------|---------------|----------------------|
| 稳定性 | ⚠️ 中 (仍依赖 localtunnel) | ✅ 高 (独立公网 IP) | ✅ 高 (全球边缘节点) |
| 成本 | 免费 | ~50元/月 (突发性能 t6) | 免费 (每天10万请求内) |
| 部署难度 | 零 (本地运行) | 中 (需购买+配环境) | 低 (CLI 一键部署) |
| 数据库 | 本地 SQLite | 本地 SQLite | 需换 D1/Turso |
| 迁移代码量 | 0 | ~5行改动 | 需重写为 Worker 格式 |
| EDR 限制 | 有 (外部验证被拦) | 无 (服务器在云端) | 无 |
| MVP 推荐度 | 临时测试可用 | ⭐⭐⭐ 推荐 | ⭐⭐ 中期考虑 |

---

## 方案 A：增强版守护进程 (已写好)

**文件**: `scripts/tunnel-daemon.js`

**改进点**:
- 每 20s 通过公网 URL `https://xtt-pilot.loca.lt/v1/health` 做外部健康检查
- 连续 2 次失败 → 强制 close 旧 tunnel + 重建新连接
- 指数退避（2s → 3s → 4.5s ... 最大 30s）
- EDR 拦截外部验证时降级到进程存活检查
- 每分钟输出状态日志

**使用方法**:
```bash
cd C:\Users\eleme\.qoderwork\workspace\mqt347tluzy70qx9\outputs\xintongtu-mvp\backend
node ../scripts/tunnel-daemon.js
```

**局限**: localtunnel 服务器端仍可能丢失 WebSocket 连接且不通知客户端。守护进程只能缩短故障恢复时间（从"永久断开"变为"最多 40s 恢复"），但在重连期间仍有 ~5-10s 不可用窗口。

---

## 方案 B：阿里云 ECS 部署 ⭐推荐

### 为什么推荐

MVP 阶段最直接的方案。整套代码几乎零改动直接跑，SQLite 文件在 ECS 本地磁盘，无需改数据库。唯一的变化是"代码从本机搬到云上"。

### 具体步骤

#### 1. 购买 ECS

- 推荐配置: **ecs.t6-c1m1.large** (1核2G 突发性能)
- 系统: Ubuntu 22.04
- 地域: 华南1 (深圳) 或华东2 (上海)
- 带宽: 按流量计费 (MVP 流量极小)
- 安全组: 开放 80/443 端口入方向
- 预估费用: ~50元/月 (包年更便宜)

#### 2. 环境搭建 (SSH 上去后一次性执行)

```bash
# Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 项目部署
mkdir -p /opt/xtt-mvp && cd /opt/xtt-mvp
# 把整个 xintongtu-mvp 目录上传 (scp/git clone)

cd backend
npm install

# 环境变量
cat > .env << 'EOF'
PORT=7788
MVP_INTERNAL_KEY=worker-key-2026
NODE_ENV=production
EOF
```

#### 3. 用 Caddy 自动 HTTPS (免费 Let's Encrypt 证书)

```bash
# 安装 Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# 配置 (假设域名 xtt-pilot.your-domain.com)
sudo cat > /etc/caddy/Caddyfile << 'EOF'
xtt-pilot.your-domain.com {
    reverse_proxy localhost:7788
}
EOF
sudo systemctl restart caddy
```

如果没有域名，可以直接用 ECS 公网 IP + HTTP (钉钉 ActionCard 支持 HTTP 链接):
```
http://<ECS_PUBLIC_IP>:7788/h5/preview.html?token=xxx
```

#### 4. 用 PM2 做进程守护

```bash
sudo npm install -g pm2

cd /opt/xtt-mvp/backend
pm2 start server.js --name xtt-mvp
pm2 save
pm2 startup  # 开机自启
```

#### 5. 钉钉推送链接改为

```
https://xtt-pilot.your-domain.com/h5/preview.html?token=xxx
# 或者无域名版:
http://<ECS_IP>:7788/h5/preview.html?token=xxx
```

#### 6. 本地开发 → ECS 同步 (日常更新)

```bash
# 方案一: scp 同步
scp -r backend/ h5/ root@<ECS_IP>:/opt/xtt-mvp/
ssh root@<ECS_IP> "cd /opt/xtt-mvp/backend && pm2 restart xtt-mvp"

# 方案二: git push + webhook 自动部署 (中期再做)
```

### ECS 方案代码改动

几乎为零。唯一建议改动:

```js
// server.js 第 192 行，去掉 localtunnel bypass 相关逻辑
// ECS 直接对外暴露，不需要 bypass IP 密码
app.get('/', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect('/h5/preview.html' + qs);
});
```

notifier.js 推送时不再传 `bypassIP` 参数即可。

---

## 方案 C：Cloudflare Workers 反向代理

### 思路

不改动本地代码，在 Cloudflare 边缘部署一个轻量 Worker 做"智能反代"：
- 请求到达 Worker → Worker fetch 到你本地 localtunnel (或 ECS)
- 好处: 即使 localtunnel 短暂断连，Worker 可以返回友好提示而非裸 Bad Gateway

### 限制

- 如果 localtunnel 断了，Worker 也连不到你的 backend → 仍然不可用
- 所以 Worker 更适合作为 ECS 的 CDN 加速层，而非替代 localtunnel
- 纯 Worker 要跑完整 Express 需要重写代码 + 换 D1 数据库，工作量偏大

### 如果将来做完整 Worker 化

```
架构:
  钉钉卡片 → Cloudflare Worker (edge) → D1 (SQLite兼容) → H5 (Pages)
  
优势: 全球加速、0 服务器维护、自动扩缩容
劣势: 需要重写为 Cloudflare Worker 格式 (Hono/itty-router)、数据库迁 D1
```

### Worker 作为 ECS 前置代理 (推荐搭配)

```js
// wrangler.toml
// name = "xtt-pilot-proxy"
// [vars]
// BACKEND_URL = "https://xtt-pilot.your-domain.com"

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = env.BACKEND_URL + url.pathname + url.search;
    
    try {
      const resp = await fetch(target, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return resp;
    } catch (e) {
      return new Response('服务暂时不可用，请稍后重试', { status: 503 });
    }
  }
};
```

这样钉钉链接指向 `https://xtt-pilot.<your>.workers.dev`，即使 ECS 短暂重启，Worker 会返回友好 503 而非裸错误。

---

## 我的建议

**MVP 阶段（现在 → 7月中旬）**: 方案 B (ECS) 最省心。

理由:
1. 代码零改动，直接 `scp` 上去 `pm2 start` 就跑
2. 彻底摆脱 localtunnel 的不稳定 + EDR 拦截
3. 50元/月对于 pilot 验证来说完全可以接受
4. 有公网 IP 后，课长手机任何网络都能稳定访问
5. 后续扩展到多门店只需加内存/升配，架构不变

**中期（规模化后）**: ECS + Cloudflare Worker 前置 + 域名，提升体验。

**长期（产品化）**: 考虑 Cloudflare Workers 全栈或阿里云 FC (函数计算)，降低运维成本。

---

## 明天测试计划

1. **先用守护进程版试一轮**（如果 localtunnel 恢复了就能直接验证端到端流程）:
   ```bash
   cd backend
   node ../scripts/tunnel-daemon.js
   ```
   然后我推送钉钉卡片，你点击测试。

2. **如果仍然不稳定 → 切 ECS**:
   - 你有阿里云账号吗？如果有，我可以帮你出一个一键部署脚本
   - 如果没有，注册后买最便宜的 t6 实例即可

3. **验证端到端**: 推送 → 点击打开 → 一键上架 → 状态回写 → 日报汇总
