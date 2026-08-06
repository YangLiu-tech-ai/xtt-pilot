#!/usr/bin/env node
/**
 * run-kunlun.js — 一键 harvest+worker 入口（harvest-before-run 编排）
 *
 * 用法：
 *   node run-kunlun.js                              # 跑当前 token 能覆盖的全部门店
 *   ALLOWED_WIDS=1284510785 node run-kunlun.js      # 只跑淘小胖龙湖
 *   DRY_RUN=1 node run-kunlun.js                    # 预演
 *   SKIP_HARVEST=1 node run-kunlun.js               # 明确跳过临期告警（复用文件里的 token）
 *
 * 【harvest-before-run 编排（P1 修复）】
 *   token 真实生死不看文件 mtime，而看 h5tk 内嵌时间戳（h5tk.split('_')[1]，约 2h 有效）；
 *   更可靠的是 worker 运行时的"探活"——worker 会对每个 sellerId 用一次极低成本 pageQuery 探活，
 *   token 失效的品牌整轮跳过（任务保持 EXECUTING，不误报失败），并以退出码 3 上报 TOKEN_STALE。
 *   本脚本据此分两种结果：
 *     - worker 退出码 0：全部处理完成。
 *     - worker 退出码 3：有品牌 token 失效 → 打印明确的 HARVEST_NEEDED 信号 + 待执行 JS snippet，
 *       agent 应 harvest 覆盖对应 token 文件后，SKIP_HARVEST=1 重跑本脚本。
 *
 * 说明：Node 进程无法直连浏览器，harvest 由 QoderWork agent 用 builtin_browser MCP 完成。
 *   本脚本只负责"凭证健康预检 + 调 worker + 把 harvest 需求明确抛给 agent"。
 */
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Windows schannel TLS 补丁：自定义 Agent 绕过证书吊销检查
const _insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

const TOKEN_FILE = path.resolve(__dirname, '..', 'kunlun-token.json');
const TOKEN_FILE_XQ = process.env.KUNLUN_TOKEN_FILE_XQ || path.resolve(__dirname, '..', 'kunlun-token-xq.json');
const WORKER = path.resolve(__dirname, 'kunlun-worker-node.js');

// h5tk 有效期阈值（分钟）。h5tk 官方约 2h，保守设 90min 视为临期。
const H5TK_STALE_MIN = Number(process.env.H5TK_STALE_MIN) || 90;
const APP_KEY = '12574478';

// ---- 钉钉告警通知（token 失效时推送，确保闭环）----
// 测试群 webhook（始终推送，用于统一监控）
const TEST_GROUP_WEBHOOK = process.env.DINGTALK_TEST_WEBHOOK || 'https://oapi.dingtalk.com/robot/send?access_token=b92c7d5f0c3a4447294f310afbaa99ce09ae3ce1b15a470e029dd8f38a60fa86';
const BRANDS_CONF_PATH = path.join(__dirname, 'brands-config.json');
let _brandsConf = null;
try { _brandsConf = JSON.parse(fs.readFileSync(BRANDS_CONF_PATH, 'utf8')); } catch {}

// token 文件 → 受影响的品牌列表
const TOKEN_TO_BRANDS = {};
if (_brandsConf && _brandsConf.brands) {
  for (const [bk, bc] of Object.entries(_brandsConf.brands)) {
    const tf = (bc.kunlunCredKey === 'xq-kunlun') ? TOKEN_FILE_XQ : TOKEN_FILE;
    if (!TOKEN_TO_BRANDS[tf]) TOKEN_TO_BRANDS[tf] = [];
    TOKEN_TO_BRANDS[tf].push({ key: bk, name: bc.brandName, webhook: bc.dingtalkWebhook });
  }
}

function postDing(webhook, body) {
  return new Promise((resolve) => {
    try {
      const u = new URL(webhook);
      const mod = u.protocol === 'https:' ? https : require('http');
      const data = JSON.stringify(body);
      const req = mod.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        agent: _insecureAgent,
      }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
      req.on('error', e => resolve('ERR:' + e.message));
      req.setTimeout(10000, () => { req.destroy(); resolve('TIMEOUT'); });
      req.write(data);
      req.end();
    } catch (e) { resolve('ERR:' + e.message); }
  });
}

async function notifyTokenExpired(failedFiles) {
  // 所有品牌 token 过期告警统一只推测试群，不推品牌群
  const allAffectedBrands = new Set();
  for (const f of failedFiles) {
    const brands = TOKEN_TO_BRANDS[f] || [];
    for (const b of brands) {
      allAffectedBrands.add(b.name);
    }
  }
  if (!TEST_GROUP_WEBHOOK) {
    log('钉钉通知：无可用 webhook，跳过');
    return;
  }
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const timeStr = now.toISOString().slice(0, 16).replace('T', ' ');
  const affectedStr = allAffectedBrands.size > 0 ? [...allAffectedBrands].join('、') : '未知品牌';
  const body = {
    msgtype: 'markdown',
    markdown: {
      title: '推送：昆仑 token 过期告警',
      text: `### ⚠️ 昆仑 token 过期告警\n\n` +
        `**时间**: ${timeStr}\n\n` +
        `**问题**: 昆仑 API 凭证已过期，自动上架 worker 已中止\n\n` +
        `**影响品牌**: ${affectedStr}\n\n` +
        `**处理**: 请在 QoderWork 中重新 harvest 昆仑 token 后重跑任务\n\n` +
        `---\n\n*新通途自动上架系统*`,
    },
  };
  // 只推送到测试群（统一监控）
  const r = await postDing(TEST_GROUP_WEBHOOK, body);
  log(`钉钉通知[测试群] 发送结果: ${typeof r === 'string' ? r.slice(0, 60) : JSON.stringify(r).slice(0, 60)}`);
}

function log(msg) { console.log('[run-kunlun]', msg); }
function err(msg, code = 1) { console.error('[run-kunlun] FAIL:', msg); process.exit(code); }
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// ---- 轻量 mtop 探活（复用 kunlun-worker-node.js 的签名逻辑）----
function httpJson(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers,
      agent: _insecureAgent,
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d.replace(/^\uFEFF/, ''))); } catch (pe) { resolve({ raw: d, _parseErr: pe.message }); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout ' + urlStr)); });
    if (body) req.write(body);
    req.end();
  });
}
function mtopProbe(api, dataObj, creds) {
  const tk = creds.h5tk.split('_')[0];
  const t = Date.now();
  const dataStr = JSON.stringify(dataObj);
  const sign = md5(tk + '&' + t + '&' + APP_KEY + '&' + dataStr);
  const qs = new URLSearchParams({
    jsv: '2.7.2', appKey: APP_KEY, t: String(t), sign, api,
    v: '1.0', type: 'json', dataType: 'json', valueType: 'string', data: dataStr
  });
  const cookie = '_m_h5_tk=' + creds.h5tk + (creds.enc ? '; _m_h5_tk_enc=' + creds.enc : '');
  const url = 'https://h5api.m.alibaba-inc.com/h5/' + api.toLowerCase() + '/1.0/?' + qs.toString();
  return httpJson(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'x-ele-platform': 'new_kunlun', 'x-ele-newkunlun-token': creds.ssot, 'Cookie': cookie }
  });
}
function isTokenError(res) {
  const ret = (res && Array.isArray(res.ret)) ? res.ret.join(',') : JSON.stringify(res && res.ret || '');
  return /TOKEN[_ ]?EX(P|O)IRED|令牌过期|FAIL_SYS_SESSION_EXPIRED|未登录|无权限|ILLEGAL_ACCESS|FAIL_SYS_ACCESS_TOKEN/i.test(ret);
}
// 探活：对指定 sellerId+storeId 做一次极轻 pageQuery，返回 { ok:true } 或 { ok:false, token:true } 或 { ok:false, err }
async function probeToken(tokenFile, label, sellerId, storeId) {
  if (!fs.existsSync(tokenFile)) return { ok: false, err: 'token文件不存在' };
  let creds;
  try { creds = JSON.parse(fs.readFileSync(tokenFile, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return { ok: false, err: 'JSON解析失败: ' + e.message }; }
  if (!creds.h5tk || !creds.ssot) return { ok: false, err: 'token缺h5tk/ssot字段' };
  try {
    const res = await mtopProbe('mtop.ele.newretail.item.pageQuery', {
      pageSize: 1, pageNum: 1, sellerId: String(sellerId),
      storeIds: JSON.stringify([String(storeId)]), titleWithoutSplitting: true
    }, creds);
    if (Array.isArray(res.ret) && String(res.ret[0]).indexOf('SUCCESS') >= 0) return { ok: true };
    if (isTokenError(res)) return { ok: false, token: true, ret: res.ret };
    return { ok: false, err: JSON.stringify(res.ret) };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

// agent 在浏览器昆仑 tab 上执行的 harvest JS（返回对象供 agent 写入 token 文件）
const HARVEST_SNIPPET = `(function(){
  var c = document.cookie || '';
  var m = c.match(/_m_h5_tk=([^;]+)/g) || [];
  var h5tk = m.length ? m[m.length-1].split('=')[1] : null;
  var me = c.match(/_m_h5_tk_enc=([^;]+)/g) || [];
  var enc = me.length ? me[me.length-1].split('=')[1] : '';
  var ssot = (typeof localStorage !== 'undefined' && localStorage.getItem('SKYWORK_KUNLUN_SSOT')) || null;
  return { h5tk: h5tk, ssot: ssot, enc: enc, url: location.href, ts: Date.now() };
})()`;

// 读取 token 文件并按 h5tk 内嵌时间戳判活（不用文件 mtime——文件新 ≠ token 活）
function inspectToken(file, label) {
  if (!fs.existsSync(file)) return { file, label, exists: false, stale: true, reason: 'missing' };
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return { file, label, exists: true, stale: true, reason: 'bad-json' }; }
  if (!obj.h5tk || !obj.ssot) return { file, label, exists: true, stale: true, reason: 'missing-field' };
  const h5tkTs = Number((obj.h5tk.split('_')[1] || '0')) || 0;
  const h5tkAgeMin = h5tkTs ? Math.round((Date.now() - h5tkTs) / 60000) : null;
  const stale = h5tkAgeMin == null ? false : h5tkAgeMin > H5TK_STALE_MIN;
  return { file, label, exists: true, stale, reason: stale ? `h5tk ${h5tkAgeMin}min(>${H5TK_STALE_MIN})` : 'ok', h5tkAgeMin };
}

// 打印需要 harvest 的明确信号（agent 消费）
function emitHarvestNeeded(reasonLabel, files) {
  log('==================== HARVEST_NEEDED ====================');
  log(`原因：${reasonLabel}`);
  log(`需要重新 harvest 的 token 文件：${files.join(', ')}`);
  log('agent 操作：在对应品牌的 boreas.kunlun.alibaba-inc.com tab 上执行以下 JS，把返回的 {h5tk,ssot,enc} 写入该 token 文件，再 SKIP_HARVEST=1 重跑本脚本：');
  log(HARVEST_SNIPPET);
  log('  - 成山/淘小胖 → ' + TOKEN_FILE);
  log('  - 兴勤       → ' + TOKEN_FILE_XQ);
  log('========================================================');
}

// 1) 运行前 token 健康预检（基于 h5tk 时间戳；真正判活以 worker 探活为准）
const inspections = [inspectToken(TOKEN_FILE, '成山/淘小胖'), inspectToken(TOKEN_FILE_XQ, '兴勤')];
for (const ins of inspections) {
  log(`token[${ins.label}] ${path.basename(ins.file)}: ${ins.exists ? ins.reason : '不存在'}`);
}
const staleFiles = inspections.filter(i => i.stale).map(i => i.file);
if (staleFiles.length && !process.env.SKIP_HARVEST) {
  emitHarvestNeeded('预检发现 token 临期/缺失（h5tk 时间戳判定）', staleFiles);
  if (!process.env.DRY_RUN) err('token 临期且未 SKIP_HARVEST，中止（agent 应 harvest 后重跑）', 3);
}

// ---- cookie 文件自动同步（从 token JSON 合成，确保 Python 取数脚本读到最新 h5tk）----
// 根因：harvest 只更新 token JSON，但 Python 取数脚本读的是 cookie_fresh.txt / cookie_fresh_xq.txt。
// 此步骤保证每次 run-kunlun 都会把 cookie 文件与 token JSON 对齐。
const COOKIE_FILE = path.resolve(__dirname, '..', 'cookie_fresh.txt');
const COOKIE_FILE_XQ = path.resolve(__dirname, '..', 'cookie_fresh_xq.txt');

function syncCookieFromToken(tokenFile, cookieFile, label) {
  if (!fs.existsSync(tokenFile)) { log(`cookie[${label}] 跳过：token 文件不存在`); return; }
  let obj;
  try { obj = JSON.parse(fs.readFileSync(tokenFile, 'utf8').replace(/^\uFEFF/, '')); }
  catch { log(`cookie[${label}] 跳过：token JSON 解析失败`); return; }
  if (!obj.h5tk) { log(`cookie[${label}] 跳过：token 缺 h5tk`); return; }
  const cookie = '_m_h5_tk=' + obj.h5tk
    + (obj.enc ? '; _m_h5_tk_enc=' + obj.enc : '')
    + '; mtop_partitioned_detect=1';
  fs.writeFileSync(cookieFile, cookie, 'utf8');
  log(`cookie[${label}] 已同步 ← ${path.basename(tokenFile)}  h5tk=${obj.h5tk.slice(0, 14)}...`);
}

syncCookieFromToken(TOKEN_FILE, COOKIE_FILE, '成山/淘小胖');
syncCookieFromToken(TOKEN_FILE_XQ, COOKIE_FILE_XQ, '兴勤');

// 2) 服务端探活 + 调 worker（async IIFE：probeToken 是 async）
(async () => {
  // ---- 服务端探活（P1 修复：客户端年龄检查通过 ≠ token 真的活着）----
  // 根因：h5tk 内嵌时间戳可能晚于实际签发时间（服务端设置的过期时间），
  //   导致客户端算出的"年龄"偏小甚至为负，永远不触发临期告警。
  //   必须用一次真实的 mtop 请求验证服务端是否接受该 token。
  log('--- 服务端 token 探活 ---');
  const probeTargets = [
    { file: TOKEN_FILE,    label: '成山/淘小胖', sellerId: '1919957953830', storeId: '20031256003' },
    { file: TOKEN_FILE_XQ, label: '兴勤',        sellerId: '2215344798382', storeId: '1069036428'  },
  ];
  const failedFiles = [];
  for (const tgt of probeTargets) {
    if (!fs.existsSync(tgt.file)) {
      log(`token[${tgt.label}] 文件不存在，跳过探活（worker 会处理）`);
      continue;
    }
    const p = await probeToken(tgt.file, tgt.label, tgt.sellerId, tgt.storeId);
    if (p.ok) {
      log(`token[${tgt.label}] ✓ 服务端探活通过`);
    } else if (p.token) {
      log(`token[${tgt.label}] ✗ 服务端确认已过期: ${JSON.stringify(p.ret)}`);
      failedFiles.push(tgt.file);
    } else {
      log(`token[${tgt.label}] ⚠ 探活出错(非token问题，不阻断): ${p.err}`);
    }
  }
  if (failedFiles.length) {
    emitHarvestNeeded('服务端探活发现 token 已过期（客户端年龄检查通过但昆仑API拒绝）', failedFiles);
    await notifyTokenExpired(failedFiles);
    if (!process.env.DRY_RUN) {
      err('服务端探活失败，中止（agent 应 harvest 后 SKIP_HARVEST=1 重跑）', 3);
    }
    return; // DRY_RUN 模式不退出，但也不继续 spawn worker
  }
  log('--- 所有品牌服务端探活通过，继续执行 worker ---');

  // 调 worker（worker 会自行探活，token 失效的品牌跳过并以退出码 3 上报）
  log(`调用 worker：${WORKER}`);
  const env = Object.assign({}, process.env, {
    KUNLUN_TOKEN_FILE: TOKEN_FILE,
    KUNLUN_TOKEN_FILE_XQ: TOKEN_FILE_XQ,
  });
  const r = spawnSync('node', [WORKER], { stdio: 'inherit', env });

  // 结果分流
  if (r.status === 3) {
    // worker 探活/中途发现 token 失效 → 明确要求 harvest 后重跑
    emitHarvestNeeded('worker 探活发现有品牌 token 失效（相关任务已保持 EXECUTING，未误报失败）', [TOKEN_FILE, TOKEN_FILE_XQ]);
    await notifyTokenExpired([TOKEN_FILE, TOKEN_FILE_XQ]);
    err('worker 上报 TOKEN_STALE（退出码3）：harvest 后 SKIP_HARVEST=1 重跑本脚本即可消化剩余任务', 3);
  }
  if (r.status !== 0) err(`worker 退出 ${r.status}`, r.status || 1);
  log('完成');
})().catch(e => { console.error('[run-kunlun] async fatal:', e.message); process.exit(1); });
