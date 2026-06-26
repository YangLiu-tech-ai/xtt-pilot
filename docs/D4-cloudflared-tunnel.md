# D4 · cloudflared HTTPS 隧道

> 将 localhost:7788 暴露为公网 HTTPS，让手机端（钉钉内）能直接访问 H5

---

## 前置条件

1. server.js 在 localhost:7788 运行中
2. cloudflared.exe 已下载到项目根目录

## 下载 cloudflared

```bash
# Windows
curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
```

或直接浏览器下载：https://github.com/cloudflare/cloudflared/releases/latest

## 启动隧道

```bash
# 方式 1: 使用启动脚本
scripts\start-tunnel.bat

# 方式 2: 手动执行
.\cloudflared.exe tunnel --url http://localhost:7788
```

启动后终端会输出类似：
```
+-------------------------------------------+
|  Your quick Tunnel has been created!       |
|  https://verb-noun-word.trycloudflare.com  |
+-------------------------------------------+
```

这个 `https://xxx.trycloudflare.com` 就是你的公网域名。

## 使用公网域名

### H5 课长端

钉钉 ActionCard 的 singleURL 拼法：
```
https://xxx.trycloudflare.com/h5/preview.html?api=https://xxx.trycloudflare.com&token={token}
```

或者本地浏览器测试：
```
file:///path/to/h5/preview.html?api=https://xxx.trycloudflare.com&token=eyJ...
```

### 直接测试 API
```bash
curl https://xxx.trycloudflare.com/v1/health
```

## Quick Tunnel 特点

- **无需注册**：不用 Cloudflare 账号，直接 `tunnel --url` 即可
- **自动 HTTPS**：Cloudflare 自动签发证书
- **随机域名**：每次重启域名会变（pilot 阶段够用）
- **单连接**：如果需要稳定域名，后续可配置 Named Tunnel（需登录 CF Dashboard）

## CORS 配置

server.js 已经开启了 CORS（允许所有来源），所以 H5 从任何域名访问 API 都没问题。

## 注意事项

1. Quick Tunnel 每次重启域名会变，需要重新拼 URL
2. 隧道窗口关闭即断开，建议 pilot 期间保持开着
3. 内网限制：如果公司网络封了 Cloudflare 的 WebSocket，可能需要切到手机热点
4. 如需固定域名，后续升级到 Named Tunnel（需要 Cloudflare 免费账号 + `cloudflared login`）

## 后续（D5 pilot 时）

1. 启动 server + worker
2. 启动 cloudflared tunnel
3. 用 `/v1/auth/issue` 生成课长的 token
4. 拼好带公网域名 + token 的 H5 URL
5. 通过钉钉 webhook 发 ActionCard 推送给门店课长
6. 课长点击 ActionCard → 打开 H5 → 操作补品
