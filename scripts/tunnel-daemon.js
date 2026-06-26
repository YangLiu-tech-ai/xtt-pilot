/**
 * 新通途 MVP · Tunnel 守护进程 (增强版)
 *
 * 解决 localtunnel 免费服务 WebSocket 僵死问题:
 *   - 定时通过公网 URL 做外部健康检查 (不走本地 localhost)
 *   - Bad Gateway / 503 / 超时 → 强制杀旧 tunnel 重连
 *   - 指数退避 + 最大重试上限
 *   - 统一管理 server + tunnel 生命周期
 *
 * 用法:
 *   cd backend
 *   node ../scripts/tunnel-daemon.js
 *
 * 环境变量:
 *   TUNNEL_SUBDOMAIN  - localtunnel 子域名 (默认 xtt-pilot)
 *   PORT              - 本地 Express 端口 (默认 7788)
 *   HEALTH_INTERVAL   - 健康检查间隔 ms (默认 20000 = 20s)
 *   MAX_FAILURES      - 连续失败几次触发重连 (默认 2)
 */

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');

// ============ 配置 ============
const SUBDOMAIN = process.env.TUNNEL_SUBDOMAIN || 'xtt-pilot';
const PORT = parseInt(process.env.PORT || '7788', 10);
const HEALTH_INTERVAL = parseInt(process.env.HEALTH_INTERVAL || '20000', 10);
const MAX_FAILURES = parseInt(process.env.MAX_FAILURES || '2', 10);
const TUNNEL_URL = `https://${SUBDOMAIN}.loca.lt`;
const LOCAL_HEALTH = `http://localhost:${PORT}/v1/health`;

// ============ 状态 ============
let serverProc = null;
let tunnelInstance = null;
let healthTimer = null;
let consecutiveFailures = 0;
let restartCount = 0;
let isRestarting = false;
let startTime = Date.now();

// ============ 日志 ============
function log(tag, msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] [${tag}] ${msg}`);
}

// ============ 1. 启动 Express Server ============
function cleanStaleLock() {
  // sqlite3-wasm 会在异常退出时残留 mvp.db.lock 目录，导致下次启动 "database is locked"
  const fs = require('fs');
  const lockPath = path.resolve(__dirname, '..', 'backend', 'mvp.db.lock');
  try {
    if (fs.existsSync(lockPath)) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      log('server', `✅ 清理残留 db lock: ${lockPath}`);
    }
  } catch (e) {
    log('server', `⚠️  清理 db lock 失败: ${e.message}`);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    // 检查本地是否已有 server 在跑
    const check = http.get(LOCAL_HEALTH, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        log('server', `本地 ${PORT} 已有服务在运行，跳过启动`);
        resolve('existing');
      });
    });
    check.on('error', () => {
      // 没有现有服务，先清理残留 lock 再启动
      cleanStaleLock();
      log('server', `启动 Express on port ${PORT}...`);
      serverProc = spawn('node', ['server.js'], {
        cwd: path.resolve(__dirname, '..', 'backend'),
        env: { ...process.env, PORT: String(PORT), NODE_TLS_REJECT_UNAUTHORIZED: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      serverProc.stdout.on('data', d => {
        const line = d.toString().trim();
        if (line) log('server', line);
        if (line.includes('listening')) resolve('started');
      });
      serverProc.stderr.on('data', d => log('server:err', d.toString().trim()));
      serverProc.on('exit', code => {
        log('server', `进程退出 code=${code}`);
        if (code !== 0) process.exit(1);  // server 崩了整个退出
      });
      // 5s 超时
      setTimeout(() => resolve('timeout-but-continue'), 5000);
    });
    check.setTimeout(2000);
  });
}

// ============ 2. 启动 Tunnel ============
async function startTunnel() {
  if (isRestarting) return;
  isRestarting = true;

  // 清理旧 tunnel
  if (tunnelInstance) {
    try { tunnelInstance.close(); } catch {}
    tunnelInstance = null;
  }

  const backoff = Math.min(2000 * Math.pow(1.5, restartCount), 30000);
  if (restartCount > 0) {
    log('tunnel', `等待 ${(backoff / 1000).toFixed(1)}s 后重连 (第${restartCount}次)...`);
    await sleep(backoff);
  }

  try {
    log('tunnel', `正在连接 localtunnel subdomain=${SUBDOMAIN}...`);
    // 从 backend/node_modules 加载，避免相对路径找不到模块
    const backendDir = path.resolve(__dirname, '..', 'backend');
    const ltPath = require.resolve('localtunnel', { paths: [backendDir] });
    const lt = require(ltPath);
    tunnelInstance = await lt({
      port: PORT,
      subdomain: SUBDOMAIN,
      allow_invalid_cert: true,
    });

    log('tunnel', `✅ 连接成功: ${tunnelInstance.url}`);
    consecutiveFailures = 0;
    startTime = Date.now();

    tunnelInstance.on('close', () => {
      log('tunnel', '⚠️  close 事件触发，准备重连...');
      tunnelInstance = null;
      restartCount++;
      isRestarting = false;
      startTunnel();
    });

    tunnelInstance.on('error', (err) => {
      log('tunnel', `❌ error 事件: ${err.message}`);
    });

  } catch (err) {
    log('tunnel', `❌ 连接失败: ${err.message}`);
    restartCount++;
  }

  isRestarting = false;
}

// ============ 3. 外部健康检查 (核心防僵死逻辑) ============
function startHealthCheck() {
  healthTimer = setInterval(async () => {
    // 先检查本地是否正常
    const localOk = await checkLocal();
    if (!localOk) {
      log('health', '⚠️  本地 server 无响应，跳过外部检查');
      return;
    }

    // 通过公网 URL 检查 tunnel 是否真正通畅
    const externalOk = await checkExternal();
    if (externalOk) {
      if (consecutiveFailures > 0) {
        log('health', `✅ 恢复正常 (之前连续失败${consecutiveFailures}次)`);
      }
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      const uptime = ((Date.now() - startTime) / 1000).toFixed(0);
      log('health', `❌ 外部检查失败 (${consecutiveFailures}/${MAX_FAILURES}) uptime=${uptime}s`);

      if (consecutiveFailures >= MAX_FAILURES) {
        log('health', `🔄 连续${MAX_FAILURES}次失败，强制重建 tunnel...`);
        consecutiveFailures = 0;
        restartCount++;
        await startTunnel();
      }
    }
  }, HEALTH_INTERVAL);
}

function checkLocal() {
  return new Promise((resolve) => {
    const req = http.get(LOCAL_HEALTH, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

function checkExternal() {
  return new Promise((resolve) => {
    const url = `${TUNNEL_URL}/v1/health`;
    const req = https.get(url, {
      rejectUnauthorized: false,  // EDR 可能注入证书
      headers: { 'User-Agent': 'xtt-mvp-healthcheck/1.0' },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const j = JSON.parse(buf);
            resolve(j.ok === true);
          } catch { resolve(false); }
        } else if (res.statusCode === 403 && /防护记录|安全策略|安全卫士|办公安全/.test(buf)) {
          // EDR 把 loca.lt 加入黑名单，本机访问被拦截
          // 但钉钉手机端走外网，不受影响 — 降级判定
          log('health', '  (本机被 EDR 拦截 loca.lt，降级到进程存活检查)');
          resolve(tunnelInstance !== null && !tunnelInstance.closed);
        } else {
          log('health', `  外部返回 ${res.statusCode}: ${buf.slice(0, 100)}`);
          resolve(false);
        }
      });
    });
    req.on('error', (err) => {
      log('health', `  外部请求失败: ${err.message}`);
      // EDR 拦截 HTTPS → 连接被重置
      if (err.code === 'ECONNRESET' || err.code === 'EPROTO') {
        log('health', '  (EDR 拦截外部验证，降级到进程存活检查)');
        resolve(tunnelInstance !== null && !tunnelInstance.closed);
      } else {
        resolve(false);
      }
    });
    req.setTimeout(8000, () => {
      req.destroy();
      log('health', '  外部请求超时 (8s)');
      resolve(false);
    });
  });
}

// ============ 4. 状态打印 ============
function printStatus() {
  setInterval(() => {
    const uptime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const alive = tunnelInstance && !tunnelInstance.closed;
    log('status', `tunnel=${alive ? '✅' : '❌'}  uptime=${uptime}min  restarts=${restartCount}  url=${TUNNEL_URL}`);
  }, 60000);  // 每分钟打印
}

// ============ 工具 ============
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============ 入口 ============
async function main() {
  log('daemon', '=== 新通途 MVP Tunnel 守护进程 ===');
  log('daemon', `配置: subdomain=${SUBDOMAIN} port=${PORT} check_interval=${HEALTH_INTERVAL}ms max_failures=${MAX_FAILURES}`);
  log('daemon', `公网 URL: ${TUNNEL_URL}`);
  log('daemon', '');

  // Step 1: 确保本地 server 在跑
  await startServer();
  await sleep(1000);

  // Step 2: 建立 tunnel
  await startTunnel();

  // Step 3: 启动健康检查
  startHealthCheck();

  // Step 4: 状态输出
  printStatus();

  log('daemon', '');
  log('daemon', '守护进程就绪。按 Ctrl+C 退出。');
  log('daemon', `H5 公网入口: ${TUNNEL_URL}/h5/preview.html?token=<YOUR_TOKEN>`);
}

// 优雅退出
process.on('SIGINT', () => {
  log('daemon', '收到 SIGINT，正在清理...');
  if (healthTimer) clearInterval(healthTimer);
  if (tunnelInstance) try { tunnelInstance.close(); } catch {}
  if (serverProc) serverProc.kill();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log('daemon', `未捕获异常: ${err.message}`);
  log('daemon', err.stack);
});

main().catch(err => {
  log('daemon', `启动失败: ${err.message}`);
  process.exit(1);
});
