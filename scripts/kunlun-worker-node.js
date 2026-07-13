#!/usr/bin/env node
/**
 * kunlun-worker-node.js — 昆仑上架 worker（Node 版，替代鲸品云方案）
 *
 * 【为什么用 Node 而非浏览器注入】
 *   昆仑页面(boreas.kunlun.alibaba-inc.com)的 CSP 会阻止向 onrender.com 发 fetch，
 *   浏览器注入版无法直连 Render。Node 端无 CSP 限制，可同时：
 *     - 直连 Render claim/report（无跨域限制）
 *     - 本地用 md5 手动签名调用 mtop（h5api.m.alibaba-inc.com）
 *   凭证只需从浏览器 harvest 一次（_m_h5_tk cookie + SKYWORK_KUNLUN_SSOT），写入 token 文件。
 *
 * 【昆仑参数隔离优势】storeId/sellerId 是请求参数，服务端不靠会话隔离，
 *   → 单套登录态可并行操作所有门店/品牌，无鲸品云"切租户被登出"死结。
 *
 * 【凭证文件】默认 ../kunlun-token.json：
 *   { "h5tk": "<_m_h5_tk 完整值(含_时间戳)>", "ssot": "buc...", "enc": "<_m_h5_tk_enc(可选)>" }
 *   h5tk/ssot 从浏览器 harvest：
 *     h5tk = document.cookie 里 _m_h5_tk 的完整值
 *     ssot = localStorage['SKYWORK_KUNLUN_SSOT']
 *
 * 用法：
 *   node kunlun-worker-node.js                 # claim 全部并处理
 *   CREDENTIAL_KEY=txp-whale node kunlun-worker-node.js   # 只处理指定品牌
 *   DRY_RUN=1 node kunlun-worker-node.js        # 只 claim+查询，不实际上架/report
 */
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const RENDER = process.env.RENDER_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'worker-key-2026-prod';
const APP_KEY = '12574478';
const TARGET_STOCK = 20;
const STATUS_ON = 0, STATUS_OFF = -2;
const DRY_RUN = !!process.env.DRY_RUN;
const CREDENTIAL_KEY = process.env.CREDENTIAL_KEY || null;
// 当前昆仑登录态能触达的门店 wid 白名单（逗号分隔）。用于客户端过滤：
// Render 已部署版本的 claim credentialKey 过滤有 bug（传 credentialKey 返回 0），
// 故 worker 改为 claim 全部后按 ALLOWED_WIDS 只处理本登录态能操作的门店，
// 其它门店任务保持 EXECUTING 留给对应登录态的 worker。
const ALLOWED_WIDS = (process.env.ALLOWED_WIDS || '').split(',').map(s => s.trim()).filter(Boolean);
// 硬隔离：以下 credential_key 的任务本 worker 绝不处理（兴勤只走鲸品云 worker-api.js）
// 即使 ALLOWED_WIDS 配置失误或 claim 端点返回意外任务，此层兜底阻断
const BLOCKED_CREDENTIAL_KEYS = new Set(['xq-whale']);
const TOKEN_FILE = process.env.KUNLUN_TOKEN_FILE || path.join(__dirname, '..', 'kunlun-token.json');

// wid(=task.store_id) → 昆仑 {storeId, sellerId, name}
const STORE_MAP = {
  '1262004557': { storeId: '20031256003', sellerId: '1919957953830', name: '成山农场(龙湖天街店)' },
  '1265426893': { storeId: '20011619473', sellerId: '1919957953830', name: '成山农场(曲江京东MALL店)' },
  '1332074728': { storeId: '20037728100', sellerId: '1919957953830', name: '成山农场(凯德广场店)' },
  '541750676':  { storeId: '20037701170', sellerId: '1919957953830', name: '成山农场(星旋广场店)' },
  '542422914':  { storeId: '20043013476', sellerId: '1919957953830', name: '成山农场(凤城十路店)' },
  '541968633':  { storeId: '20043438259', sellerId: '1919957953830', name: '成山农场(凤城九路店)' },
  '1284510785': { storeId: '20015142365', sellerId: '1919996480451', name: '淘小胖超市(龙湖店)' },
  '1137486501': { storeId: '1069036428',  sellerId: '2215344798382', name: '兴勤超市(陈江店)' },
  '1328460101': { storeId: '20035008325', sellerId: '2215344798382', name: '兴勤超市(港惠店)' },
};

// sellerId → token 文件（兴勤用独立 BUC，token 单独 harvest；其他品牌共享主 token）
const TOKEN_BY_SELLER = {
  '1919957953830': TOKEN_FILE,                                                 // 成山
  '1919996480451': TOKEN_FILE,                                                 // 淘小胖（与成山同 BUC）
  '2215344798382': process.env.KUNLUN_TOKEN_FILE_XQ
                   || path.join(__dirname, '..', 'kunlun-token-xq.json'),     // 兴勤独立 BUC
};

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// ---- 凭证（按 sellerId 懒加载并缓存）----
const _credsCache = new Map(); // key: tokenFilePath, value: creds object
function loadCredsFromFile(file) {
  if (_credsCache.has(file)) return _credsCache.get(file);
  if (!fs.existsSync(file)) throw new Error('token 文件不存在：' + file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!raw.h5tk || !raw.ssot) throw new Error('token 文件缺字段：' + file);
  _credsCache.set(file, raw);
  return raw;
}
function getCreds(sellerId) {
  // 环境变量覆盖（单 sellerId 场景）
  if (process.env.KUNLUN_H5TK && process.env.KUNLUN_SSOT) {
    return { h5tk: process.env.KUNLUN_H5TK, ssot: process.env.KUNLUN_SSOT, enc: process.env.KUNLUN_ENC || '' };
  }
  const file = TOKEN_BY_SELLER[sellerId] || TOKEN_FILE;
  return loadCredsFromFile(file);
}

// ---- HTTP ----
function httpJson(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers,
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d.replace(/^\uFEFF/, ''))); } catch (pe) { resolve({ raw: d, _parseErr: pe.message }); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout ' + urlStr)); });
    if (body) req.write(body);
    req.end();
  });
}

// ---- mtop（本地签名，按 sellerId 切凭证）----
async function mtop(api, dataObj) {
  const sellerId = String(dataObj.sellerId || '');
  const creds = getCreds(sellerId);
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
const isSuccess = (res) => Array.isArray(res.ret) && String(res.ret[0]).indexOf('SUCCESS') >= 0;

// ---- token 过期/失效识别（昆仑 mtop 各种写法：TOKEN_EXPIRED / TOKEN_EXOIRED(服务端typo) / 令牌过期 / 无权限 / 未登录）----
function isTokenError(res) {
  const ret = (res && Array.isArray(res.ret)) ? res.ret.join(',') : JSON.stringify(res && res.ret || '');
  return /TOKEN[_ ]?EX(P|O)IRED|令牌过期|FAIL_SYS_SESSION_EXPIRED|未登录|无权限|ILLEGAL_ACCESS|FAIL_SYS_ACCESS_TOKEN/i.test(ret);
}
// 抛出带类型的 token 错误，供上层判定"环境失败，不计入挂起"
function throwTyped(res, ctx) {
  const msg = ctx + ':' + JSON.stringify(res && res.ret);
  const e = new Error(msg);
  if (isTokenError(res)) e.code = 'TOKEN_EXPIRED';
  return e;
}

// ---- 昆仑操作 ----
async function findItem(barcode, storeId, sellerId) {
  const res = await mtop('mtop.ele.newretail.item.pageQuery', {
    pageSize: 20, pageNum: 1, sellerId: String(sellerId),
    storeIds: JSON.stringify([String(storeId)]),
    mixedBarCodeOrId: String(barcode), titleWithoutSplitting: true
  });
  if (!isSuccess(res)) throw throwTyped(res, '查询失败');
  const arr = (res.data && res.data.data) || [];
  const hit = arr.find(it => String(it.barCode) === String(barcode)) || arr[0];
  if (!hit) return null;
  return { itemId: hit.itemId, status: hit.status, quantity: Number(hit.quantity) || 0, title: hit.title };
}
async function setInventory(itemId, storeId, sellerId, quantity) {
  const list = JSON.stringify([JSON.stringify({ itemId, storeId: Number(storeId), sellerId: Number(sellerId), quantity: String(quantity) })]);
  const res = await mtop('mtop.ele.newretail.item.batchInventory', { sellerId: String(sellerId), list });
  if (!isSuccess(res)) throw throwTyped(res, '补库存失败');
  return true;
}
async function setShelf(itemId, storeId, sellerId, status) {
  const list = JSON.stringify([JSON.stringify({ itemId, storeId: Number(storeId), status })]);
  const res = await mtop('mtop.ele.newretail.item.batchShelf', { sellerId: String(sellerId), list });
  if (!isSuccess(res)) throw throwTyped(res, (status === STATUS_ON ? '上架' : '下架') + '失败');
  return true;
}

// ---- 处理单个任务 ----
async function processTask(task) {
  const action = task.action || 'shelf';
  const map = STORE_MAP[String(task.store_id)];
  if (!map) return { ok: false, error: `未知门店 store_id=${task.store_id}（STORE_MAP 未配置）` };
  const { storeId, sellerId } = map;
  const item = await findItem(task.barcode, storeId, sellerId);
  if (!item) return { ok: false, error: `商品未找到 barcode=${task.barcode} @ ${map.name}` };

  if (action === 'shelf') {
    if (item.status === STATUS_ON && item.quantity > 0) return { ok: true, skipped: true, reason: 'already_on_sale', itemId: item.itemId };
    if (DRY_RUN) return { ok: true, dryRun: true, itemId: item.itemId, wouldSetStock: item.quantity < TARGET_STOCK, curStatus: item.status, curQty: item.quantity };
    if (item.quantity < TARGET_STOCK) await setInventory(item.itemId, storeId, sellerId, TARGET_STOCK);
    await setShelf(item.itemId, storeId, sellerId, STATUS_ON);
    return { ok: true, operated: true, itemId: item.itemId, prevStatus: item.status, prevQty: item.quantity };
  }
  if (action === 'unshelf') {
    if (item.status === STATUS_OFF) return { ok: true, skipped: true, reason: 'already_off', itemId: item.itemId };
    if (DRY_RUN) return { ok: true, dryRun: true, itemId: item.itemId, curStatus: item.status };
    await setShelf(item.itemId, storeId, sellerId, STATUS_OFF);
    return { ok: true, operated: true, itemId: item.itemId };
  }
  return { ok: false, error: `不支持的 action: ${action}` };
}

// ---- Render ----
const rHeaders = { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY };
const claim = (credentialKey) => httpJson(RENDER + '/v1/internal/worker/claim', { method: 'POST', headers: rHeaders, body: JSON.stringify(credentialKey ? { credentialKey } : {}) });
const report = (taskId, success, errorMsg, opType) => httpJson(RENDER + '/v1/internal/worker/report', { method: 'POST', headers: rHeaders, body: JSON.stringify({ taskId, success, errorMsg: errorMsg || undefined, operationType: opType || undefined }) }).catch(() => {});

// ---- token 探活：对某 sellerId 用最低成本 pageQuery 探一下凭证是否活着 ----
// 返回 { ok:true } 活着 / { ok:false, token:true } token 失效 / { ok:false, err } 其它错误
async function probeSeller(sellerId, storeId) {
  try {
    const res = await mtop('mtop.ele.newretail.item.pageQuery', {
      pageSize: 1, pageNum: 1, sellerId: String(sellerId),
      storeIds: JSON.stringify([String(storeId)]), titleWithoutSplitting: true
    });
    if (isSuccess(res)) return { ok: true };
    if (isTokenError(res)) return { ok: false, token: true, ret: res.ret };
    return { ok: false, err: JSON.stringify(res.ret) };
  } catch (e) {
    // 网络/超时也算探活失败，但不是 token 问题
    return { ok: false, err: e.message };
  }
}

async function main() {
  console.log(`[kunlun-worker] RENDER=${RENDER} credKey=${CREDENTIAL_KEY || 'ALL'} allowedWids=${ALLOWED_WIDS.join(',') || 'ALL'} DRY_RUN=${DRY_RUN}`);
  const claimed = await claim(CREDENTIAL_KEY);
  const all = claimed.tasks || [];
  // 客户端按 ALLOWED_WIDS 过滤（Render credentialKey 过滤有 bug 的兜底）
  let mine = ALLOWED_WIDS.length ? all.filter(t => ALLOWED_WIDS.includes(String(t.store_id))) : all;
  // 第二层硬隔离：credential_key 黑名单（兴勤只走鲸品云，绝不经过昆仑 worker）
  const blockedByCred = mine.filter(t => BLOCKED_CREDENTIAL_KEYS.has(t.credential_key || ''));
  if (blockedByCred.length) {
    console.log(`[kunlun-worker] ⛔ BLOCKED ${blockedByCred.length} task(s) by credential_key=[${[...BLOCKED_CREDENTIAL_KEYS].join(',')}]（这些品牌有独立 worker，本 worker 不处理）`);
    mine = mine.filter(t => !BLOCKED_CREDENTIAL_KEYS.has(t.credential_key || ''));
  }
  const others = all.filter(t => !mine.includes(t));
  console.log(`[kunlun-worker] claimed=${all.length} mine=${mine.length} others(left)=${others.length}`);
  if (others.length) {
    const byStore = {};
    others.forEach(t => { const n = (STORE_MAP[String(t.store_id)] || {}).name || t.store_id; byStore[n] = (byStore[n] || 0) + 1; });
    console.log(`[kunlun-worker] 其它登录态门店任务(保持EXECUTING): ${JSON.stringify(byStore)}`);
  }

  // ---- 运行前按 sellerId 探活；token 失效的品牌整体跳过（不 touch 任务，保持 EXECUTING 等 harvest 后重跑）----
  // deadSellers 记录探活失败的 sellerId，退出时用退出码 3 通知 run-kunlun 需要 harvest
  const deadSellers = new Set();          // token 失效
  const okSellers = new Set();            // 探活通过
  if (!DRY_RUN) {
    const sellersInPlay = new Map();      // sellerId -> 一个样本 storeId
    for (const t of mine) {
      const map = STORE_MAP[String(t.store_id)];
      if (map && !sellersInPlay.has(map.sellerId)) sellersInPlay.set(map.sellerId, map.storeId);
    }
    for (const [sellerId, storeId] of sellersInPlay) {
      const p = await probeSeller(sellerId, storeId);
      if (p.ok) { okSellers.add(sellerId); }
      else if (p.token) { deadSellers.add(sellerId); console.log(`[kunlun-worker] ⚠ seller=${sellerId} token 失效(${JSON.stringify(p.ret)})，本轮跳过该品牌，任务保持 EXECUTING 等 harvest`); }
      else { deadSellers.add(sellerId); console.log(`[kunlun-worker] ⚠ seller=${sellerId} 探活失败(${p.err})，本轮跳过`); }
    }
  }

  let ok = 0, skip = 0, fail = 0, deferred = 0; const errs = [];
  for (const t of mine) {
    const map = STORE_MAP[String(t.store_id)];
    const sellerId = map && map.sellerId;
    const store = (map || {}).name || t.store_id;
    // token 失效的品牌：跳过，不 report（任务保持 EXECUTING，下轮 harvest 后重跑）
    if (!DRY_RUN && sellerId && deadSellers.has(sellerId)) {
      deferred++;
      console.log(`  ⏸ #${t.id} ${store} ${t.barcode} → 跳过(seller ${sellerId} token失效，保持EXECUTING)`);
      continue;
    }
    try {
      const r = await processTask(t);
      if (r.ok) {
        if (!DRY_RUN) await report(t.id, true, null, r.skipped ? 'already_on_sale' : (t.action === 'unshelf' ? 'unshelf' : 'operated'));
        r.skipped ? skip++ : ok++;
        console.log(`  ✓ #${t.id} ${store} ${t.barcode} → ${r.skipped ? r.reason : (r.dryRun ? 'DRY:' + JSON.stringify(r) : 'operated')}`);
      } else {
        if (!DRY_RUN) await report(t.id, false, r.error);
        fail++; errs.push(`#${t.id} ${r.error}`);
        console.log(`  ✗ #${t.id} ${store} ${t.barcode} → ${r.error}`);
      }
    } catch (e) {
      // 运行中途 token 过期：不 report(false)（不计入挂起），把该 seller 标记为 dead，
      // 后续同品牌任务一并跳过，等 harvest 后重跑
      if (e.code === 'TOKEN_EXPIRED') {
        if (sellerId) deadSellers.add(sellerId);
        deferred++;
        console.log(`  ⏸ #${t.id} ${store} ${t.barcode} → 中途token过期，保持EXECUTING 等 harvest（不计失败）`);
        continue;
      }
      if (!DRY_RUN) await report(t.id, false, e.message);
      fail++; errs.push(`#${t.id} ${e.message}`);
      console.log(`  ✗ #${t.id} EXC ${e.message}`);
    }
  }
  console.log(`[kunlun-worker] done ok=${ok} skip=${skip} fail=${fail} deferred=${deferred}(token失效跳过)`);
  if (errs.length) console.log('[kunlun-worker] errors:\n' + errs.join('\n'));
  // 退出码语义（供 daemon 熔断判断）：
  //  - 有 token 失效的 seller 且本轮完全没干成活(ok===0) → 退出码3，触发 daemon 熔断 + harvest
  //  - 有 token 失效但本轮有成功上架(ok>0) → 退出码0，不熔断（健康 seller 不被失效 seller 连累），
  //    被 defer 的任务保持 EXECUTING，下轮自然重试
  if (deadSellers.size) {
    console.log(`[kunlun-worker] TOKEN_STALE sellers=${[...deadSellers].join(',')} (ok=${ok})`);
    if (ok === 0) process.exit(3);
    console.log('[kunlun-worker] 本轮有成功上架，不触发熔断，defer 任务下轮重试');
  }
}
main().catch(e => { console.error('[kunlun-worker] fatal:', e.message); process.exit(1); });
