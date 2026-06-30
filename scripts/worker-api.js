/**
 * Worker 自动执行脚本
 * 
 * 流程: claim EXECUTING 任务 → 调鲸品云 API 上架 → report 结果回 Render
 * 
 * 部署方式: 
 *   1. 本地 cron (QoderWork 定时任务，每 5 分钟)
 *   2. 或 Render cron job
 * 
 * 环境变量:
 *   RENDER_API=https://xtt-pilot.onrender.com  (Render 后端地址)
 *   INTERNAL_KEY=worker-key-2026-prod           (内部 API 密钥)
 *   WHALE_REFRESH_TOKEN=xxx                     (鲸品云 refresh_token)
 *   WHALE_SHOP_ID=1579337942525061              (龙湖天街门店 ID)
 *   WHALE_BASE_URL=https://whale.zwztf.net      (鲸品云后台地址)
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const RENDER_API = process.env.RENDER_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'worker-key-2026-prod';
const WHALE_BASE_URL = process.env.WHALE_BASE_URL || 'https://whale.zwztf.net';
let WHALE_REFRESH_TOKEN = process.env.WHALE_REFRESH_TOKEN || '';
const WHALE_SHOP_ID = process.env.WHALE_SHOP_ID || '1579337942525061';
const BASIC_AUTH = 'Basic d2hhbGU6d2hhbGU=';
const TOKEN_FILE = path.join(__dirname, '..', 'token.tmp');

// Token 缓存
let _token = null;
let _tokenExp = 0;

function request(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = mod.request(reqOpts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// === Token 恢复：从 token.tmp 文件读取 ===
function recoverTokenFromFile() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const content = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (content.startsWith('{')) {
      const obj = JSON.parse(content);
      return obj.refresh_token || obj.WHALE_REFRESH_TOKEN || null;
    }
    return content || null;
  } catch {
    return null;
  }
}

// === Token 刷新（带自动恢复） ===
async function refreshWithToken(refreshToken) {
  const url = `${WHALE_BASE_URL}/api/auth/oauth/token?refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token&scope=server`;
  const r = await request(url, { method: 'POST', headers: { 'Authorization': BASIC_AUTH } });
  return r.data;
}

async function getToken() {
  if (_token && Date.now() < _tokenExp - 300000) return _token;

  // 策略1: 用环境变量/当前的 WHALE_REFRESH_TOKEN
  if (WHALE_REFRESH_TOKEN) {
    const data = await refreshWithToken(WHALE_REFRESH_TOKEN);
    if (data?.access_token) {
      _token = data.access_token;
      _tokenExp = Date.now() + (data.expires_in || 604799) * 1000;
      console.log(`[worker] token refreshed, expires ${data.expires_in}s`);
      return _token;
    }
    console.warn(`[worker] env token failed: ${JSON.stringify(data)}`);
  }

  // 策略2: 从 token.tmp 文件恢复
  const fileToken = recoverTokenFromFile();
  if (fileToken && fileToken !== WHALE_REFRESH_TOKEN) {
    console.log('[worker] trying token from token.tmp...');
    const data = await refreshWithToken(fileToken);
    if (data?.access_token) {
      WHALE_REFRESH_TOKEN = fileToken;
      _token = data.access_token;
      _tokenExp = Date.now() + (data.expires_in || 604799) * 1000;
      console.log(`[worker] token recovered from token.tmp, expires ${data.expires_in}s`);
      return _token;
    }
    console.warn(`[worker] token.tmp also failed: ${JSON.stringify(data)}`);
  }

  // 策略3: 所有 token 都失效，抛出可识别错误
  const err = new Error('TOKEN_EXPIRED: All refresh_tokens invalid. Need browser login to whale.zwztf.net to recover.');
  err.code = 'TOKEN_EXPIRED';
  err.needBrowserLogin = true;
  throw err;
}

// === 鲸品云操作 ===
async function findStoreSkuId(token, barcode, shopId) {
  const url = `${WHALE_BASE_URL}/api/web/gms/b2c/store-goods/page?current=1&size=20&barcode=${encodeURIComponent(barcode)}`;
  const r = await request(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
  if (!r.data || r.data.code !== 0) throw new Error(`查询失败: ${JSON.stringify(r.data)}`);

  for (const rec of (r.data.data?.records || [])) {
    if (rec.shopId === shopId && rec.skuList?.length > 0) {
      return { storeSkuId: rec.skuList[0].id, currentStatus: rec.skuList[0].saleStatus, currentPrice: rec.skuList[0].salePrice };
    }
  }
  return null;
}

async function setPrice(token, storeSkuId, price) {
  if (!price || price <= 0) return null;
  const url = `${WHALE_BASE_URL}/api/web/gms/b2c/store-goods/price/batch`;
  const r = await request(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
    JSON.stringify({ storeSkuIds: [storeSkuId], salePrice: price }));
  if (r.data?.code !== 0) throw new Error(`改价失败: ${JSON.stringify(r.data)}`);
  return r.data;
}

async function onSale(token, storeSkuId) {
  const url = `${WHALE_BASE_URL}/api/web/gms/b2c/store-goods/skus/sale-status/on-sale/batch`;
  const r = await request(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
    JSON.stringify({ storeSkuIds: [storeSkuId], saleStatus: 1 }));
  if (r.data?.code !== 0) throw new Error(`上架失败: ${JSON.stringify(r.data)}`);
  return r.data;
}

// 查询并补充线下库存（offlineStock=0 时补到 DEFAULT_OFFLINE_STOCK）
const DEFAULT_OFFLINE_STOCK = 5;
async function ensureOfflineStock(token, barcode, shopId) {
  // 1. 查询当前库存
  const qUrl = `${WHALE_BASE_URL}/api/web/gms/b2c/store-goods/stocks/page?size=20&current=1&isSkuCodeFuzzy=0&isBarcodeFuzzy=0&barcode=${encodeURIComponent(barcode)}&organizationIds=${encodeURIComponent(shopId)}`;
  const q = await request(qUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
  if (!q.data || q.data.code !== 0) throw new Error(`查询库存失败: ${JSON.stringify(q.data)}`);
  const rec = (q.data.data?.records || [])[0];
  if (!rec) return { skipped: true, reason: 'stock record not found' };
  const stock = (rec.storeSkuStockList || [])[0];
  if (!stock) return { skipped: true, reason: 'sku stock not found' };

  const current = Number(stock.offlineStock) || 0;
  if (current >= DEFAULT_OFFLINE_STOCK) {
    return { skipped: true, reason: 'sufficient', current };
  }

  // 2. 补库存
  const pUrl = `${WHALE_BASE_URL}/api/web/gms/b2c/store-goods/stocks/store-sku/stocks`;
  const p = await request(pUrl, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
    JSON.stringify({ id: stock.id, offlineStock: String(DEFAULT_OFFLINE_STOCK) }));
  if (p.data?.code !== 0) throw new Error(`补库存失败: ${JSON.stringify(p.data)}`);
  return { ok: true, from: current, to: DEFAULT_OFFLINE_STOCK, stockId: stock.id };
}

// === Render API ===
async function claimTasks() {
  const url = `${RENDER_API}/v1/internal/worker/claim`;
  const r = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY } }, '{}');
  if (!r.data?.ok) throw new Error(`claim failed: ${JSON.stringify(r.data)}`);
  return r.data.tasks || [];
}

async function reportResult(taskId, success, errorMsg) {
  const url = `${RENDER_API}/v1/internal/worker/report`;
  const body = { taskId, success, errorMsg: errorMsg || undefined };
  const r = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY } },
    JSON.stringify(body));
  return r.data;
}

// === 主流程 ===
async function processTask(task, token) {
  const { id, barcode, item_name, action, actual_price } = task;
  console.log(`[worker] processing task#${id}: ${item_name} (${barcode}) action=${action}`);

  if (action !== 'shelf') {
    return { ok: false, error: `暂不支持操作: ${action}` };
  }

  // 查找 storeSkuId
  const sku = await findStoreSkuId(token, barcode, WHALE_SHOP_ID);
  if (!sku) {
    return { ok: false, error: `商品未找到: barcode=${barcode} 在门店 ${WHALE_SHOP_ID} 无 SKU` };
  }

  // 已经在架则跳过
  if (sku.currentStatus === 1) {
    console.log(`[worker] task#${id} already on-sale, skip`);
    return { ok: true, skipped: true, reason: 'already_on_sale' };
  }

  // 先补线下库存（offlineStock=0 时无法真正上架）
  const stockResult = await ensureOfflineStock(token, barcode, WHALE_SHOP_ID);
  if (stockResult.ok) {
    console.log(`[worker] task#${id} stock seeded: ${stockResult.from} → ${stockResult.to}`);
  } else if (stockResult.skipped) {
    console.log(`[worker] task#${id} stock skipped: ${stockResult.reason}${stockResult.current!=null?' ('+stockResult.current+')':''}`);
  }

  // 上架（不改价）
  await onSale(token, sku.storeSkuId);
  console.log(`[worker] task#${id} on-sale ✓`);

  return { ok: true, storeSkuId: sku.storeSkuId };
}

async function main() {
  console.log(`[worker] starting... RENDER=${RENDER_API} SHOP=${WHALE_SHOP_ID}`);

  // 1. Claim tasks
  const tasks = await claimTasks();
  if (tasks.length === 0) {
    console.log('[worker] no EXECUTING tasks, done.');
    return;
  }
  console.log(`[worker] claimed ${tasks.length} task(s)`);

  // 2. Get whale token
  const token = await getToken();

  // 3. Process each task
  let success = 0, failed = 0;
  for (const task of tasks) {
    try {
      const result = await processTask(task, token);
      if (result.ok) {
        await reportResult(task.id, true);
        success++;
        console.log(`[worker] task#${task.id} → DONE`);
      } else {
        await reportResult(task.id, false, result.error);
        failed++;
        console.log(`[worker] task#${task.id} → FAILED: ${result.error}`);
      }
    } catch (e) {
      await reportResult(task.id, false, e.message);
      failed++;
      console.error(`[worker] task#${task.id} → ERROR: ${e.message}`);
    }
  }

  console.log(`[worker] done. success=${success} failed=${failed}`);
}

main().catch(e => {
  console.error('[worker] fatal:', e.message);
  process.exit(1);
});
