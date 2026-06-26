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

const RENDER_API = process.env.RENDER_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'worker-key-2026-prod';
const WHALE_BASE_URL = process.env.WHALE_BASE_URL || 'https://whale.zwztf.net';
const WHALE_REFRESH_TOKEN = process.env.WHALE_REFRESH_TOKEN || '';
const WHALE_SHOP_ID = process.env.WHALE_SHOP_ID || '1579337942525061';
const BASIC_AUTH = 'Basic d2hhbGU6d2hhbGU=';

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

// === Token ===
async function getToken() {
  if (_token && Date.now() < _tokenExp - 300000) return _token;
  if (!WHALE_REFRESH_TOKEN) throw new Error('WHALE_REFRESH_TOKEN not set');

  const url = `${WHALE_BASE_URL}/api/auth/oauth/token?refresh_token=${encodeURIComponent(WHALE_REFRESH_TOKEN)}&grant_type=refresh_token&scope=server`;
  const r = await request(url, { method: 'POST', headers: { 'Authorization': BASIC_AUTH } });
  if (!r.data?.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(r.data)}`);

  _token = r.data.access_token;
  _tokenExp = Date.now() + (r.data.expires_in || 604799) * 1000;
  console.log(`[worker] token refreshed, expires ${r.data.expires_in}s`);
  return _token;
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

  // 改价
  if (actual_price && actual_price > 0) {
    await setPrice(token, sku.storeSkuId, actual_price);
    console.log(`[worker] task#${id} price → ¥${actual_price}`);
  }

  // 上架
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
