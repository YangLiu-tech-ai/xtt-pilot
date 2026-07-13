/**
 * worker-trigger.js — 本地触发服务
 *
 * 接收 Render 后端 webhook，立即 spawn 对应 worker 脚本执行上架。
 * 配合 30 分钟 cron 兜底，替代原 5 分钟高频轮询。
 *
 * 启动：node scripts/worker-trigger.js
 * 端口：TRIGGER_PORT (默认 9876)
 * 鉴权：TRIGGER_KEY header 校验
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

// ── 配置 ──
const PORT = Number(process.env.TRIGGER_PORT) || 9876;
const TRIGGER_KEY = process.env.TRIGGER_KEY || 'local-trigger-secret';
const RENDER_API = process.env.RENDER_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'worker-key-2026-prod';

const SCRIPTS_DIR = __dirname;
const MVP_DIR = path.resolve(SCRIPTS_DIR, '..');

// ── 执行锁（每个 credentialKey 最多一个 worker 实例） ──
const locks = new Map();

/**
 * spawn 对应 worker 脚本
 * @param {string} credentialKey - 品牌凭证标识
 * @param {object} meta - 日志用元信息 { taskId, storeName }
 */
function runWorker(credentialKey, meta) {
  meta = meta || {};
  if (locks.get(credentialKey)) {
    log('[' + credentialKey + '] worker already running, skip (task#' + (meta.taskId || '?') + ')');
    return { spawned: false, reason: 'locked' };
  }
  locks.set(credentialKey, Date.now());

  var isXqWhale = credentialKey === 'xq-whale';
  var script = isXqWhale ? 'worker-api.js' : path.join('scripts', 'run-kunlun.js');
  var cwd = isXqWhale ? SCRIPTS_DIR : MVP_DIR;

  var env = Object.assign({}, process.env, { RENDER_API: RENDER_API, INTERNAL_KEY: INTERNAL_KEY });
  if (isXqWhale) {
    env.ONLY_CREDENTIAL_KEY = 'xq-whale';
  } else {
    env.ALLOWED_WIDS = '1262004557,1265426893,1332074728,541750676,542422914,541968633,1284510785';
  }

  log('spawning worker [' + credentialKey + '] task#' + (meta.taskId || '?') + ' store=' + (meta.storeName || '?'));
  log('  cmd: node ' + script + '  cwd: ' + cwd);

  var child = spawn('node', [script], { cwd: cwd, env: env, stdio: 'inherit' });

  child.on('close', function (code) {
    log('[' + credentialKey + '] worker exited with code ' + code);
    locks.delete(credentialKey);
  });
  child.on('error', function (err) {
    log('[' + credentialKey + '] spawn error: ' + err.message);
    locks.delete(credentialKey);
  });

  return { spawned: true, pid: child.pid };
}

// ── HTTP 服务 ──
var server = http.createServer(function (req, res) {
  // POST /trigger — 核心触发端点
  if (req.method === 'POST' && req.url === '/trigger') {
    var key = req.headers['x-trigger-key'];
    if (key !== TRIGGER_KEY) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    var body = '';
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () {
      var payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (e) {
        res.writeHead(400);
        res.end('bad json');
        return;
      }

      var credentialKey = payload.credentialKey;
      var taskId = payload.taskId;
      var storeName = payload.storeName;
      if (!credentialKey) {
        res.writeHead(400);
        res.end('missing credentialKey');
        return;
      }

      var result = runWorker(credentialKey, { taskId: taskId, storeName: storeName });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, spawned: result.spawned, reason: result.reason, pid: result.pid }));
    });
    return;
  }

  // GET /health — 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    var lockInfo = {};
    locks.forEach(function (startedAt, k) {
      lockInfo[k] = { running: true, since: new Date(startedAt).toISOString() };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), locks: lockInfo }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, function () {
  log('worker-trigger listening on :' + PORT);
  log('  TRIGGER_KEY=' + (TRIGGER_KEY ? '***' : '(empty!)'));
  log('  RENDER_API=' + RENDER_API);
});

// ── 优雅退出 ──
process.on('SIGINT', function () {
  log('SIGINT received, shutting down...');
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(1); }, 5000);
});

process.on('SIGTERM', function () {
  log('SIGTERM received, shutting down...');
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(1); }, 5000);
});

// ── 日志 ──
function log(msg) {
  var ts = new Date().toISOString().slice(11, 19);
  console.log('[' + ts + '] ' + msg);
}
