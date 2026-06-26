/**
 * 鲸品云适配器 - 五档模式
 *
 *   dry      (默认): 仅记录批次 JSONL，不调真实鲸品云。立即返回成功 → task DONE，
 *                  生产排盘后用 scripts/build-batch-xlsx.js 转 Excel，人工审核后再上架。
 *                  ★ 默认模式 = 绝不动真实数据。
 *   simulate       : 老的随机 80% 成功桩 (XTT001 强制失败演示@课长链路)，给状态机自测用。
 *   preview        : 模拟真实鲸品云操作全流程，生成操作计划 JSON，不真实调用 API。
 *   api            : ★ 真实 API 模式 ★ 通过鲸品云 REST API 完成上架/改价，无需浏览器。
 *                  流程: refresh_token 换 access_token → 按 barcode 查 storeSkuId → 改价 → 上架
 *   real           : 保留，当前直接抛错。
 *
 * 环境变量：
 *   WHALE_MODE=dry|simulate|preview|api|real      (默认 dry)
 *   WHALE_BATCH_DIR=...               (默认 ../whale-batches，自动按 YYYY-MM-DD 分目录)
 *   WHALE_PREVIEW_DIR=...             (默认 ../whale-preview，preview 模式输出)
 *   WHALE_REFRESH_TOKEN=...           (api 模式必须，7天有效可自动续期)
 *   WHALE_BASE_URL=...                (默认 https://whale.zwztf.net)
 *   WHALE_SHOP_ID=...                 (目标门店 shopId，默认 1579337942525061 龙湖天街)
 *
 * 调用方 (worker.js)：
 *   const { executeOnWhale } = require('../backend/whaleAdapter');
 *   const r = await executeOnWhale(task); // {ok, error?, batchFile?, entry?, storeSkuId?, apiResult?}
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const MODE = (process.env.WHALE_MODE || 'dry').toLowerCase();
const BATCH_DIR = process.env.WHALE_BATCH_DIR
  || path.resolve(__dirname, '..', 'whale-batches');
const PREVIEW_DIR = process.env.WHALE_PREVIEW_DIR
  || path.resolve(__dirname, '..', 'whale-preview');

// API 模式配置
const WHALE_BASE_URL = process.env.WHALE_BASE_URL || 'https://whale.zwztf.net';
const WHALE_REFRESH_TOKEN = process.env.WHALE_REFRESH_TOKEN || '';
const WHALE_SHOP_ID = process.env.WHALE_SHOP_ID || '1579337942525061';
const BASIC_AUTH = 'Basic d2hhbGU6d2hhbGU='; // whale:whale

// Token 缓存（进程内）
let _cachedToken = null;
let _tokenExpiresAt = 0;

function todayLocal() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function ensureBatchDir() {
  const day = todayLocal();
  const dir = path.join(BATCH_DIR, day);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function batchFileFor(task) {
  const dir = ensureBatchDir();
  const fname = `${task.store_id}.${task.action || 'shelf'}.jsonl`;
  return path.join(dir, fname);
}

function writeBatchRow(task, mode) {
  const file = batchFileFor(task);
  const entry = {
    ts: new Date().toISOString(),
    task_id: task.id,
    store_id: task.store_id,
    sku: task.sku,
    barcode: task.barcode,
    item_name: task.item_name,
    action: task.action || 'shelf',
    substitute_sku: task.substitute_sku || null,
    actual_price: task.actual_price ?? null,
    retry_count: task.retry_count || 0,
    mode: mode || MODE,
  };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  return { file, entry };
}

/* === HTTP 工具 === */

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/* === Token 管理 === */

async function getAccessToken() {
  // 缓存有效则直接返回（提前 5 分钟刷新）
  if (_cachedToken && Date.now() < _tokenExpiresAt - 300000) {
    return _cachedToken;
  }

  if (!WHALE_REFRESH_TOKEN) {
    throw new Error('WHALE_REFRESH_TOKEN 未配置，api 模式无法运行');
  }

  const url = `${WHALE_BASE_URL}/api/auth/oauth/token?refresh_token=${encodeURIComponent(WHALE_REFRESH_TOKEN)}&grant_type=refresh_token&scope=server`;
  const resp = await httpRequest(url, {
    method: 'POST',
    headers: { 'Authorization': BASIC_AUTH },
  });

  if (!resp.data || !resp.data.access_token) {
    throw new Error(`Token 刷新失败: ${JSON.stringify(resp.data)}`);
  }

  _cachedToken = resp.data.access_token;
  _tokenExpiresAt = Date.now() + (resp.data.expires_in || 604799) * 1000;
  console.log(`[whaleAdapter:api] token refreshed, expires in ${resp.data.expires_in}s`);
  return _cachedToken;
}

/* === API 核心操作 === */

async function apiFindStoreSkuId(token, barcode, shopId) {
  // 通过 store-goods/page 按 barcode 查询，找到指定门店的 storeSkuId
  const url = `${WHALE_BASE_URL}/api/web/gms/b2c/store-goods/page?current=1&size=20&barcode=${encodeURIComponent(barcode)}`;
  const resp = await httpRequest(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!resp.data || resp.data.code !== 0 || !resp.data.data) {
    throw new Error(`查询商品失败: ${JSON.stringify(resp.data)}`);
  }

  const records = resp.data.data.records || [];
  for (const record of records) {
    if (record.shopId === shopId) {
      const skuList = record.skuList || [];
      if (skuList.length > 0) {
        return {
          storeSkuId: skuList[0].id,
          currentSaleStatus: skuList[0].saleStatus,
          currentPrice: skuList[0].salePrice,
          goodsName: record.goodsName,
          shopName: record.shopName,
        };
      }
    }
  }
  return null;
}

async function apiSetPrice(token, storeSkuId, price) {
  if (!price || price <= 0) return { skipped: true, reason: 'price not set' };

  const url = `${WHALE_BASE_URL}/api/web/gms/b2c/store-goods/price/batch`;
  const resp = await httpRequest(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }, JSON.stringify({ storeSkuIds: [storeSkuId], salePrice: price }));

  if (!resp.data || resp.data.code !== 0) {
    throw new Error(`改价失败: ${JSON.stringify(resp.data)}`);
  }
  return { ok: true, data: resp.data.data };
}

async function apiOnSale(token, storeSkuId) {
  const url = `${WHALE_BASE_URL}/api/web/gms/b2c/store-goods/skus/sale-status/on-sale/batch`;
  const resp = await httpRequest(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }, JSON.stringify({ storeSkuIds: [storeSkuId], saleStatus: 1 }));

  if (!resp.data || resp.data.code !== 0) {
    throw new Error(`上架失败: ${JSON.stringify(resp.data)}`);
  }
  return { ok: true, data: resp.data.data };
}

async function apiOffSale(token, storeSkuId) {
  const url = `${WHALE_BASE_URL}/api/web/gms/b2c/store-goods/skus/sale-status/off-sale/batch`;
  const resp = await httpRequest(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }, JSON.stringify({ storeSkuIds: [storeSkuId], saleStatus: 0 }));

  if (!resp.data || resp.data.code !== 0) {
    throw new Error(`下架失败: ${JSON.stringify(resp.data)}`);
  }
  return { ok: true, data: resp.data.data };
}

/* === 模式实现 === */

async function executeDry(task) {
  const { file, entry } = writeBatchRow(task, 'dry');
  return { ok: true, batchFile: file, entry, mode: 'dry' };
}

async function executeSimulate(task) {
  if (task.sku === 'XTT001') {
    return { ok: false, error: '鲸品云 SKU 校验失败：商品不存在', mode: 'simulate' };
  }
  const ok = ((task.id * 9301 + 49297) % 233280) / 233280 < 0.8;
  return ok
    ? { ok: true, mode: 'simulate' }
    : { ok: false, error: '鲸品云页面超时', mode: 'simulate' };
}

async function executePreview(task) {
  const { file, entry } = writeBatchRow(task, 'preview');
  entry.mode = 'preview';

  const plan = {
    mode: 'preview',
    generated_at: new Date().toISOString(),
    task_id: task.id,
    store_id: task.store_id,
    sku: task.sku,
    barcode: task.barcode,
    item_name: task.item_name,
    action: task.action || 'shelf',
    target_price: task.actual_price,
    substitute_sku: task.substitute_sku || null,
    steps: [
      { step: 1, action: 'navigate', url: WHALE_BASE_URL, description: '打开鲸品云首页', status: 'simulated' },
      { step: 2, action: 'select_store', store_id: task.store_id, description: `切换到门店: ${task.store_id}`, status: 'simulated' },
      { step: 3, action: 'search_item', query: task.barcode || task.sku, description: `搜索商品: ${task.barcode} (${task.item_name})`, status: 'simulated' },
      { step: 4, action: task.action === 'substitute' ? 'add_substitute' : 'set_shelf',
        detail: task.action === 'substitute'
          ? { substitute_sku: task.substitute_sku, price: task.actual_price }
          : { price: task.actual_price, quantity: 999 },
        description: task.action === 'substitute'
          ? `设置替代品: ${task.substitute_sku}, 定价 ¥${task.actual_price}`
          : `设置上架: 定价 ¥${task.actual_price}, 库存 999`,
        status: 'simulated' },
      { step: 5, action: 'review_confirm_page', description: '进入确认页面', status: 'simulated' },
      { step: 6, action: 'STOP_BEFORE_SUBMIT', description: '停止：等待切换 api 模式执行', status: 'BLOCKED' },
    ],
    review_checklist: [
      `确认商品: ${task.item_name} (${task.barcode})`,
      `确认门店: ${task.store_id}`,
      `确认价格: ¥${task.actual_price}`,
      task.action === 'substitute' ? `确认替代品: ${task.substitute_sku}` : '确认操作: 上架',
      '确认后将 WHALE_MODE 切换为 api 并重新执行',
    ],
  };

  const previewDir = path.join(PREVIEW_DIR, todayLocal());
  fs.mkdirSync(previewDir, { recursive: true });
  const planFile = path.join(previewDir, `${task.id}_${task.store_id}_${task.barcode}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), 'utf8');

  console.log(`[whaleAdapter:preview] plan written → ${planFile}`);
  return { ok: true, mode: 'preview', batchFile: file, planFile, plan };
}

async function executeApi(task) {
  const shopId = WHALE_SHOP_ID;
  const barcode = task.barcode;
  const action = task.action || 'shelf';

  console.log(`[whaleAdapter:api] executing ${action} for barcode=${barcode} store=${shopId}`);

  // 1. 获取 token
  const token = await getAccessToken();

  // 2. 查找 storeSkuId
  const skuInfo = await apiFindStoreSkuId(token, barcode, shopId);
  if (!skuInfo) {
    return {
      ok: false,
      mode: 'api',
      error: `商品未找到: barcode=${barcode} 在门店 ${shopId} 无对应 SKU`,
    };
  }

  console.log(`[whaleAdapter:api] found storeSkuId=${skuInfo.storeSkuId} name=${skuInfo.goodsName} currentStatus=${skuInfo.currentSaleStatus} price=${skuInfo.currentPrice}`);

  // 3. 记录批次日志
  const { file, entry } = writeBatchRow(task, 'api');
  entry.storeSkuId = skuInfo.storeSkuId;

  // 4. 执行操作
  let apiResult = {};
  if (action === 'shelf') {
    // 改价（如果课长设置了价格）
    if (task.actual_price && task.actual_price > 0) {
      const priceResult = await apiSetPrice(token, skuInfo.storeSkuId, task.actual_price);
      apiResult.price = priceResult;
      console.log(`[whaleAdapter:api] price set to ¥${task.actual_price}`);
    }
    // 上架
    const saleResult = await apiOnSale(token, skuInfo.storeSkuId);
    apiResult.onSale = saleResult;
    console.log(`[whaleAdapter:api] on-sale success`);

  } else if (action === 'off_shelf') {
    // 下架
    const offResult = await apiOffSale(token, skuInfo.storeSkuId);
    apiResult.offSale = offResult;
    console.log(`[whaleAdapter:api] off-sale success`);

  } else {
    return { ok: false, mode: 'api', error: `不支持的操作: ${action}` };
  }

  return {
    ok: true,
    mode: 'api',
    batchFile: file,
    entry,
    storeSkuId: skuInfo.storeSkuId,
    skuInfo,
    apiResult,
  };
}

async function executeReal(task) {
  throw new Error(
    'WHALE_MODE=real is deprecated. Use WHALE_MODE=api for direct API integration.'
  );
}

async function executeOnWhale(task) {
  switch (MODE) {
    case 'simulate': return executeSimulate(task);
    case 'preview':  return executePreview(task);
    case 'api':      return executeApi(task);
    case 'real':     return executeReal(task);
    case 'dry':
    default:         return executeDry(task);
  }
}

console.log(`[whaleAdapter] mode=${MODE} batchDir=${BATCH_DIR}`);

module.exports = { executeOnWhale, getAccessToken, apiFindStoreSkuId, apiOnSale, apiOffSale, apiSetPrice, MODE, BATCH_DIR, PREVIEW_DIR };
