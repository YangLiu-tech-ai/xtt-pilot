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
const fs = require('fs');

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

// ── 多机隔离：DAEMON_CRED_KEY ──
// 设了 DAEMON_CRED_KEY 的 daemon 只认领指定 credentialKey 的任务（用于新机跑新品牌时防误抢本机任务）。
// 不设置 = 认领全部（本机老逻辑，向后兼容；本机跑 csnc/txp/xq 三品牌时不设）。
// 多品牌用逗号分隔，如 DAEMON_CRED_KEY=new-A-whale,new-B-whale。
var DAEMON_CRED_KEYS = (process.env.DAEMON_CRED_KEY || '')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean);

var SCRIPTS_DIR = __dirname;
var MVP_DIR = path.resolve(SCRIPTS_DIR, '..');

// brands-config.json 路径：支持环境变量覆盖，默认在 scripts/ 目录
var BRANDS_CONFIG_PATH = process.env.BRANDS_CONFIG_PATH
  || path.join(SCRIPTS_DIR, 'brands-config.json');

// ── 动态加载 ALLOWED_WIDS ──
// 从 brands-config.json 收集所有昆仑链路品牌的门店 WID。
// 鲸品云链路品牌（xq-whale 硬编码 + 任意配置了 shelfChannel="whale-api" 的品牌）
// 走 worker-api.js，不经过昆仑 worker 的 ALLOWED_WIDS 过滤。
// 每次调用都重新读文件，支持热更新：改 brands-config.json 后无需重启 daemon。
function loadAllowedWids() {
  try {
    var raw = fs.readFileSync(BRANDS_CONFIG_PATH, 'utf8');
    var config = JSON.parse(raw);
    var wids = [];
    var brands = config.brands || {};
    Object.keys(brands).forEach(function (key) {
      var brand = brands[key];
      // 鲸品云链路品牌走独立 worker-api.js 路径，不经过 ALLOWED_WIDS
      if (isWhaleApiBrand(brand)) return;
      (brand.stores || []).forEach(function (store) {
        if (store.wid) wids.push(store.wid);
      });
    });
    return wids.join(',');
  } catch (e) {
    log('brands-config 读取失败: ' + e.message + '，ALLOWED_WIDS 将为空（worker 处理全部任务）');
    return '';
  }
}

// ── 上架链道路由（昆仑 mtop vs 鲸品云 REST API）──
// 默认：只有 xq-whale 走 worker-api.js（历史行为不变）；其余品牌走 run-kunlun.js（昆仑 mtop）。
// 扩展：brands-config.json 品牌段加 "shelfChannel": "whale-api"，该品牌即改走鲸品云 worker-api.js
// （用于成山/淘小胖迁移新机后从昆仑链路切换到鲸品云链路；热更新，改完配置下个轮询周期生效）。
function isWhaleApiBrand(brand) {
  if (!brand) return false;
  if (brand.credentialKey === 'xq-whale') return true;
  return brand.shelfChannel === 'whale-api';
}

function isWhaleApiRoute(credentialKey) {
  if (credentialKey === 'xq-whale') return true;
  try {
    var config = JSON.parse(fs.readFileSync(BRANDS_CONFIG_PATH, 'utf8'));
    var brands = config.brands || {};
    var keys = Object.keys(brands);
    for (var i = 0; i < keys.length; i++) {
      if (brands[keys[i]].credentialKey === credentialKey) return isWhaleApiBrand(brands[keys[i]]);
    }
  } catch (e) { /* 读失败按昆仑链路兜底 */ }
  return false;
}

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

// ── 钉钉 webhook 通用发送（fire-and-forget，失败不阻塞）──
function postWebhook(content) {
  try {
    var url = new URL(ALERT_WEBHOOK);
    var body = JSON.stringify({ msgtype: 'text', text: { content: content } });
    var req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000
    }, function () {});
    req.on('error', function (e) { log('webhook error (non-fatal): ' + e.message); });
    req.write(body);
    req.end();
  } catch (e) {
    log('postWebhook error (non-fatal): ' + e.message);
  }
}

// ── 钉钉告警（fire-and-forget，失败不阻塞）──
function sendAlert(credentialKey, text) {
  // 同一 credentialKey 1 小时内不重复告警，防刷屏
  var last = alertedAt.get(credentialKey) || 0;
  if (Date.now() - last < 3600 * 1000) return;
  alertedAt.set(credentialKey, Date.now());
  stats.alerts++;
  postWebhook('[' + ALERT_KEYWORD + '] xtt worker告警\n' + text);
  log('[' + credentialKey + '] 钉钉告警已发送: ' + text);
}

// ── 上架成功通知（每批汇总一条，仅统计真实上架 operated，跳过 already_on_sale）──
function notifyShelfSuccess(credentialKey, batchTasks) {
  if (!batchTasks || !batchTasks.length) return;
  var taskIds = batchTasks.map(function (t) { return t.id; });
  // worker 退出后回查这批 task 的最终状态，区分 operated / already_on_sale
  apiRequest('POST', '/v1/internal/tasks-status', { taskIds: taskIds })
    .then(function (r) {
      var rows = (r && r.rows) || [];
      // 只统计本轮真实上架成功（DONE 且 operation_type=operated）的
      var operated = rows.filter(function (t) { return t.status === 'DONE' && t.operation_type === 'operated'; });
      if (operated.length === 0) return;  // 全是已在架/跳过，不打扰
      // 按门店分组
      var byStore = {};
      operated.forEach(function (t) {
        var s = t.store_name || '未知门店';
        if (!byStore[s]) byStore[s] = [];
        byStore[s].push(t.item_name || t.barcode);
      });
      var lines = ['[' + ALERT_KEYWORD + '] 缺货补品·上架成功'];
      Object.keys(byStore).forEach(function (s) {
        lines.push('\n' + s + ' · ' + byStore[s].length + ' 件已上架');
        byStore[s].forEach(function (name) { lines.push('• ' + name); });
      });
      postWebhook(lines.join('\n'));
      log('[' + credentialKey + '] 上架成功通知已发送: ' + operated.length + ' 件');
    })
    .catch(function (e) { log('notifyShelfSuccess 回查失败(non-fatal): ' + e.message); });
}

// ── 上架失败通知（每批汇总一条，回查 FAILED 任务并推送明细）──
function notifyShelfFailure(credentialKey, batchTasks) {
  if (!batchTasks || !batchTasks.length) return;
  var taskIds = batchTasks.map(function (t) { return t.id; });
  apiRequest('POST', '/v1/internal/tasks-status', { taskIds: taskIds })
    .then(function (r) {
      var rows = (r && r.rows) || [];
      var failed = rows.filter(function (t) { return t.status === 'FAILED'; });
      if (failed.length === 0) return;  // 无失败，不推送
      // 按门店分组
      var byStore = {};
      failed.forEach(function (t) {
        var s = t.store_name || '未知门店';
        if (!byStore[s]) byStore[s] = [];
        byStore[s].push(t.item_name || t.barcode);
      });
      var lines = ['[' + ALERT_KEYWORD + '] 缺货补品·上架失败（需人工关注）'];
      Object.keys(byStore).forEach(function (s) {
        lines.push('\n' + s + ' · ' + byStore[s].length + ' 件上架失败');
        byStore[s].forEach(function (name) { lines.push('• ' + name); });
      });
      lines.push('\n请登录鲸品云后台检查对应渠道商品是否存在');
      postWebhook(lines.join('\n'));
      log('[' + credentialKey + '] 上架失败通知已发送: ' + failed.length + ' 件');
    })
    .catch(function (e) { log('notifyShelfFailure 回查失败(non-fatal): ' + e.message); });
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
    // 多机隔离：DAEMON_CRED_KEYS 非空时，依次 claim 每个 credentialKey 的任务（后端 claim 端点支持单 credentialKey 过滤）。
    // DAEMON_CRED_KEYS 为空 → claim body 为 {} → 认领全部（本机老逻辑，向后兼容）。
    var targets = DAEMON_CRED_KEYS.length ? DAEMON_CRED_KEYS : [''];
    var allTasks = [];
    for (var i = 0; i < targets.length; i++) {
      var claimBody = targets[i] ? { credentialKey: targets[i] } : {};
      var result;
      try {
        result = await apiRequest('POST', '/v1/internal/worker/claim', claimBody);
      } catch (e) {
        log('claim request error (cred=' + (targets[i] || 'ALL') + '): ' + e.message);
        stats.errors++;
        continue;
      }
      if (!result.ok) {
        log('claim API error (cred=' + (targets[i] || 'ALL') + '): ' + (result.err || 'unknown'));
        stats.errors++;
        continue;
      }
      var tasks = result.tasks || [];
      for (var j = 0; j < tasks.length; j++) allTasks.push(tasks[j]);
    }
    if (allTasks.length === 0) return;

    // 按 credential_key 分组
    var groups = {};
    allTasks.forEach(function (t) {
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
      await runWorker(key, groups[key]);
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

function runWorker(credentialKey, batchTasks) {
  return new Promise(function (resolve) {
    var taskCount = batchTasks.length;
    if (locks.get(credentialKey)) {
      log('[' + credentialKey + '] worker already running (pid ' + locks.get(credentialKey) + '), skip ' + taskCount + ' task(s)');
      resolve();
      return;
    }

    var whaleApi = isWhaleApiRoute(credentialKey);
    var script = whaleApi ? 'worker-api.js' : path.join('scripts', 'run-kunlun.js');
    var cwd = whaleApi ? SCRIPTS_DIR : MVP_DIR;

    var env = Object.assign({}, process.env, { RENDER_API: RENDER_API, INTERNAL_KEY: INTERNAL_KEY });
    if (whaleApi) {
      env.ONLY_CREDENTIAL_KEY = credentialKey;
    } else {
      env.ALLOWED_WIDS = loadAllowedWids();
      log('ALLOWED_WIDS loaded from brands-config: ' + env.ALLOWED_WIDS);
      // 跳过 run-kunlun 启动前的 token 粗筛预检（该预检检查两份 token 文件，
      // 任一过期即整体退出码3，会让健康品牌被过期品牌连累熔断）。
      // 改由 worker 内部 per-seller 探活精准判活：成山/淘小胖/兴勤昆仑各自独立，
      // 某 seller token 失效只 defer 该 seller，不影响其他 seller 上架。
      env.SKIP_HARVEST = '1';
    }

    log('spawning worker [' + credentialKey + '] via ' + (whaleApi ? '鲸品云(worker-api.js)' : '昆仑(run-kunlun.js)') + ' for ' + taskCount + ' task(s)');

    var child = spawn('node', [script], { cwd: cwd, env: env, stdio: 'inherit' });
    locks.set(credentialKey, child.pid);
    stats.spawned++;

    child.on('close', function (code) {
      log('[' + credentialKey + '] worker exited with code ' + code);
      locks.delete(credentialKey);
      handleExitCode(credentialKey, code);
      // 回查这批任务的最终状态：成功→推送上架成功通知，失败→推送上架失败通知
      notifyShelfSuccess(credentialKey, batchTasks);
      notifyShelfFailure(credentialKey, batchTasks);
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
    } else if (isWhaleApiRoute(credentialKey)) {
      sendAlert(credentialKey, '鲸品云 worker（' + credentialKey + '）连续失败 ' + n + ' 次，可能 refresh_token 失效，需重登鲸品云重新提取凭证。');
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
log('  DAEMON_CRED_KEY=' + (DAEMON_CRED_KEYS.length ? '[' + DAEMON_CRED_KEYS.join(',') + ']（多机隔离：只认领这些 credentialKey 的任务）' : 'ALL（认领全部，本机老模式）'));
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
  var now = new Date();
  var ts = [now.getHours(), now.getMinutes(), now.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
  console.log('[' + ts + '] [daemon] ' + msg);
}
