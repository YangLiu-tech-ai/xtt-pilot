/**
 * worker-daemon.js — 本地常驻守护进程，轮询 Render claim API 并派发上架任务
 *
 * 架构：worker 主动向外连（普通 HTTPS 出站），无需 tunnel / 公网 URL / 入站端口，
 * 天然穿透企业代理。课长点击确认后 5-15 秒内自动 claim 并执行上架。
 *
 * 稳定性设计：
 *  - 熔断（circuit breaker）：昆仑 worker 退出码 3（token stale）时，
 *    暂停该 credentialKey 轮询 CIRCUIT_COOLDOWN 分钟，避免 token 失效期间空转死循环。
 *    冷却期结束自动恢复（此时昆仑凭证续期 cron 大概率已 harvest 新 token）。
 *  - 兴勤（鲸品云）token 7 天自刷新，连续失败 ALERT_THRESHOLD 次时钉钉告警。
 *  - QoderWork 30 分钟兜底 cron 保留，daemon 挂了也不丢任务。
 *
 * 启动：node scripts/worker-daemon.js  或  start-worker-daemon.bat（开机自启）
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
// 昆仑 token stale 熔断冷却时长（分钟）。默认 15 分钟，续期 cron 每 90 分钟 harvest。
var CIRCUIT_COOLDOWN = parseInt(process.env.CIRCUIT_COOLDOWN || '15', 10) * 60 * 1000;
// 兴勤连续失败告警阈值
var ALERT_THRESHOLD = parseInt(process.env.ALERT_THRESHOLD || '3', 10);
// 钉钉告警 webhook（测试群，关键词"推送"）
var ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || 'https://oapi.dingtalk.com/robot/send?access_token=b92c7d5f0c3a4447294f310afbaa99ce09ae3ce1b15a470e029dd8f38a60fa86';
var ALERT_KEYWORD = process.env.ALERT_KEYWORD || '推送';

var SCRIPTS_DIR = __dirname;
var MVP_DIR = path.resolve(SCRIPTS_DIR, '..');

// ── 状态 ──
var locks = new Map();          // credentialKey → pid（正在运行的 worker）
var circuits = new Map();       // credentialKey → resumeAt(ms)（熔断到期时间戳）
var failCounts = new Map();     // credentialKey → 连续失败次数
var alertedAt = new Map();      // credentialKey → 上次告警时间戳（防刷屏，1小时内不重复）
var stats = { polls: 0, claims: 0, spawned: 0, errors: 0, circuitTrips: 0, alerts: 0, startedAt: new Date().toISOString() };
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

// ── 钉钉告警（fire-and-forget，失败不阻塞）──
function sendAlert(credentialKey, text) {
  // 同一 credentialKey 1 小时内不重复告警，防刷屏
  var last = alertedAt.get(credentialKey) || 0;
  if (Date.now() - last < 3600 * 1000) return;
  alertedAt.set(credentialKey, Date.now());
  stats.alerts++;

  try {
    var url = new URL(ALERT_WEBHOOK);
    var body = JSON.stringify({
      msgtype: 'text',
      text: { content: '[' + ALERT_KEYWORD + '] xtt worker告警\n' + text }
    });
    var req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000
    }, function () {});
    req.on('error', function (e) { log('alert webhook error (non-fatal): ' + e.message); });
    req.write(body);
    req.end();
    log('[' + credentialKey + '] 钉钉告警已发送: ' + text);
  } catch (e) {
    log('sendAlert error (non-fatal): ' + e.message);
  }
}

// ── 熔断判断 ──
function isCircuitOpen(credentialKey) {
  var resumeAt = circuits.get(credentialKey);
  if (!resumeAt) return false;
  if (Date.now() >= resumeAt) {
    circuits.delete(credentialKey);
    log('[' + credentialKey + '] 熔断冷却结束，恢复轮询');
    return false;
  }
  return true;
}

function tripCircuit(credentialKey) {
  var resumeAt = Date.now() + CIRCUIT_COOLDOWN;
  circuits.set(credentialKey, resumeAt);
  stats.circuitTrips++;
  var mins = Math.round(CIRCUIT_COOLDOWN / 60000);
  log('[' + credentialKey + '] ⚡ 熔断触发（token stale），暂停轮询 ' + mins + ' 分钟至 ' + new Date(resumeAt).toISOString().slice(11, 19));
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

    // 按 credential_key 分组
    var groups = {};
    tasks.forEach(function (t) {
      var key = t.credential_key || 'unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    });

    // 对每个 credentialKey：熔断中则跳过，否则 spawn worker
    var keys = Object.keys(groups);
    var dispatched = 0;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (isCircuitOpen(key)) {
        log('[' + key + '] 熔断中，跳过 ' + groups[key].length + ' 个任务（等 token 刷新）');
        continue;
      }
      dispatched += groups[key].length;
      await runWorker(key, groups[key].length);
    }

    if (dispatched > 0) {
      stats.claims += dispatched;
      lastClaimAt = new Date().toISOString();
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
      // 跳过 run-kunlun 启动前的 token 粗筛预检（该预检检查两份 token 文件，
      // 任一过期即整体退出码3，会让健康品牌被过期品牌连累熔断）。
      // 改由 worker 内部 per-seller 探活精准判活：成山/淘小胖/兴勤昆仑各自独立，
      // 某 seller token 失效只 defer 该 seller，不影响其他 seller 上架。
      env.SKIP_HARVEST = '1';
    }

    log('spawning worker [' + credentialKey + '] for ' + taskCount + ' task(s)');

    var child = spawn('node', [script], { cwd: cwd, env: env, stdio: 'inherit' });
    locks.set(credentialKey, child.pid);
    stats.spawned++;

    child.on('close', function (code) {
      log('[' + credentialKey + '] worker exited with code ' + code);
      locks.delete(credentialKey);
      handleExitCode(credentialKey, code);
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

// ── 退出码语义处理 ──
// 0 = 成功（可能含 skip）；1 = 通用失败；3 = TOKEN_STALE（昆仑需要 harvest）
function handleExitCode(credentialKey, code) {
  if (code === 0) {
    failCounts.set(credentialKey, 0);  // 成功清零失败计数
    return;
  }

  if (code === 3) {
    // 昆仑 token stale：熔断，等续期 cron harvest，不空转
    tripCircuit(credentialKey);
    // 昆仑 token 失效不告警（续期 cron 会自动 harvest 恢复），仅熔断
    return;
  }

  // code === 1 或其它：通用失败，累计计数
  var n = (failCounts.get(credentialKey) || 0) + 1;
  failCounts.set(credentialKey, n);
  log('[' + credentialKey + '] 连续失败 ' + n + '/' + ALERT_THRESHOLD);

  if (n >= ALERT_THRESHOLD) {
    if (credentialKey === 'xq-whale') {
      sendAlert(credentialKey, '兴勤鲸品云 worker 连续失败 ' + n + ' 次，可能 refresh_token 失效（账号18201062873），需重登 harvest。');
    } else {
      sendAlert(credentialKey, '昆仑 worker（' + credentialKey + '）连续失败 ' + n + ' 次，请检查。');
    }
    failCounts.set(credentialKey, 0);  // 告警后清零，避免每轮都告警
  }
}

// ── Health HTTP ──
var healthServer = http.createServer(function (req, res) {
  if (req.url === '/health') {
    var lockInfo = {};
    locks.forEach(function (pid, key) { lockInfo[key] = pid; });
    var circuitInfo = {};
    circuits.forEach(function (resumeAt, key) {
      circuitInfo[key] = { openUntil: new Date(resumeAt).toISOString(), remainingSec: Math.max(0, Math.round((resumeAt - Date.now()) / 1000)) };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      uptime: Math.round(process.uptime()),
      polls: stats.polls,
      claims: stats.claims,
      spawned: stats.spawned,
      errors: stats.errors,
      circuitTrips: stats.circuitTrips,
      alerts: stats.alerts,
      locks: lockInfo,
      circuits: circuitInfo,
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
  log('circuit cooldown = ' + Math.round(CIRCUIT_COOLDOWN / 60000) + ' min, alert threshold = ' + ALERT_THRESHOLD);
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
