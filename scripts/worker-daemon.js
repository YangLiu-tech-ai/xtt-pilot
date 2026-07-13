/**
 * worker-daemon.js — 本地常驻守护进程，10 秒轮询 Render claim API
 *
 * 替代原 tunnel + webhook 方案。worker 主动向外连（普通 HTTPS 出站），
 * 无需 cloudflared / localtunnel / 公网 URL / 入站端口。
 * 课长点击确认后 5-15 秒内 worker 自动 claim 并执行上架。
 *
 * 启动：node scripts/worker-daemon.js
 * 或：  start-worker-daemon.bat（Windows 开机自启）
 *
 * 兜底：QoderWork 30 分钟 cron 保留，daemon 挂了也不丢任务。
 */

const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

// ── 配置 ──
var POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '10', 10) * 1000;
var RENDER_API = process.env.RENDER_API || 'https://xtt-pilot.onrender.com';
var INTERNAL_KEY = process.env.INTERNAL_KEY || 'worker-key-2026-prod';
var HEALTH_PORT = parseInt(process.env.DAEMON_HEALTH_PORT || '9877', 10);

var SCRIPTS_DIR = __dirname;
var MVP_DIR = path.resolve(SCRIPTS_DIR, '..');

// ── 状态 ──
var locks = new Map();     // credentialKey → pid
var stats = { polls: 0, claims: 0, spawned: 0, errors: 0, startedAt: new Date().toISOString() };
var lastPollAt = null;
var lastClaimAt = null;

// ── HTTP 工具 ──
function apiRequest(method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    var url = new URL(RENDER_API + urlPath);
    var isHttps = url.protocol === 'https:';
    var lib = isHttps ? https : http;
    var opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': INTERNAL_KEY
      },
      timeout: 15000
    };
    var req = lib.request(opts, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── 轮询 + 派发 ──
async function pollCycle() {
  stats.polls++;
  lastPollAt = new Date().toISOString();

  try {
    var result = await apiRequest('POST', '/v1/internal/worker/claim', {});
    if (!result.ok) {
      log('claim API error: ' + (result.err || 'unknown'));
      stats.errors++;
      return;
    }

    var tasks = result.tasks || [];
    if (tasks.length === 0) return;

    stats.claims += tasks.length;
    lastClaimAt = new Date().toISOString();
    log('claimed ' + tasks.length + ' task(s)');

    // 按 credential_key 分组
    var groups = {};
    tasks.forEach(function (t) {
      var key = t.credential_key || 'unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    });

    // 对每个 credentialKey，spawn 对应 worker（同一时刻每 key 只跑一个）
    var keys = Object.keys(groups);
    for (var i = 0; i < keys.length; i++) {
      await runWorker(keys[i], groups[keys[i]].length);
    }

  } catch (e) {
    stats.errors++;
    log('poll error: ' + e.message);
  }
}

function runWorker(credentialKey, taskCount) {
  return new Promise(function (resolve) {
    if (locks.get(credentialKey)) {
      log('[' + credentialKey + '] worker already running (pid ' + locks.get(credentialKey) + '), skip ' + taskCount + ' task(s)');
      resolve();
      return;
    }

    var isXqWhale = credentialKey === 'xq-whale';
    var script = isXqWhale ? 'worker-api.js' : path.join('scripts', 'run-kunlun.js');
    var cwd = isXqWhale ? SCRIPTS_DIR : MVP_DIR;

    var env = Object.assign({}, process.env, { RENDER_API: RENDER_API, INTERNAL_KEY: INTERNAL_KEY });
    if (isXqWhale) {
      env.ONLY_CREDENTIAL_KEY = 'xq-whale';
    } else {
      env.ALLOWED_WIDS = '1262004557,1265426893,1332074728,541750676,542422914,541968633,1284510785';
    }

    log('spawning worker [' + credentialKey + '] for ' + taskCount + ' task(s)');

    var child = spawn('node', [script], { cwd: cwd, env: env, stdio: 'inherit' });
    locks.set(credentialKey, child.pid);
    stats.spawned++;

    child.on('close', function (code) {
      log('[' + credentialKey + '] worker exited with code ' + code);
      locks.delete(credentialKey);
      resolve();
    });

    child.on('error', function (err) {
      log('[' + credentialKey + '] spawn error: ' + err.message);
      locks.delete(credentialKey);
      stats.errors++;
      resolve();
    });
  });
}

// ── Health HTTP ──
var healthServer = http.createServer(function (req, res) {
  if (req.url === '/health') {
    var lockInfo = {};
    locks.forEach(function (pid, key) { lockInfo[key] = pid; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      uptime: Math.round(process.uptime()),
      polls: stats.polls,
      claims: stats.claims,
      spawned: stats.spawned,
      errors: stats.errors,
      locks: lockInfo,
      lastPollAt: lastPollAt,
      lastClaimAt: lastClaimAt,
      startedAt: stats.startedAt
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

healthServer.listen(HEALTH_PORT, function () {
  log('health endpoint on :' + HEALTH_PORT + '/health');
});

// ── 主循环 ──
var pollTimer = null;

function startPolling() {
  log('polling ' + RENDER_API + ' every ' + (POLL_INTERVAL / 1000) + 's');
  pollCycle();  // 立即跑一次
  pollTimer = setInterval(pollCycle, POLL_INTERVAL);
}

// ── 启动 ──
log('worker-daemon starting...');
log('  RENDER_API=' + RENDER_API);
log('  POLL_INTERVAL=' + (POLL_INTERVAL / 1000) + 's');
log('  SCRIPTS_DIR=' + SCRIPTS_DIR);
startPolling();

// ── 优雅退出 ──
function shutdown(signal) {
  log(signal + ' received, stopping...');
  if (pollTimer) clearInterval(pollTimer);
  healthServer.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(1); }, 5000);
}
process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });

// ── 日志 ──
function log(msg) {
  var ts = new Date().toISOString().slice(11, 19);
  console.log('[' + ts + '] [daemon] ' + msg);
}
