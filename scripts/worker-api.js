/**
 * Worker 自动执行脚本 (v2 - 多品牌多账号隔离)
 * 
 * 流程: claim EXECUTING 任务 → 按 task.credential_key 加载鲸品云凭证
 *       → 按 task.whale_shop_id 执行上架 → report 结果回 Render
 * 
 * 隔离机制:
 *   - 每个 task 携带 whale_shop_id (鲸品云门店) + credential_key (凭证池索引)
 *   - 凭证池定义在 whale-credentials.json，支持多品牌多鲸品云账号
 *   - Token 按 credential_key 独立缓存，互不干扰
 *   - 向后兼容：无字段时 fallback 到环境变量 (WHALE_SHOP_ID / WHALE_REFRESH_TOKEN)
 * 
 * 部署方式: 
 *   1. 本地 cron (QoderWork 定时任务，每 5 分钟)
 *   2. 或 Render cron job
 * 
 * 环境变量 (fallback):
 *   RENDER_API=https://xtt-pilot.onrender.com
 *   INTERNAL_KEY=worker-key-2026-prod
 *   WHALE_REFRESH_TOKEN=xxx            (仅 fallback，优先用凭证池)
 *   WHALE_SHOP_ID=1579337942525061     (仅 fallback，优先用 task 字段)
 *   WHALE_BASE_URL=https://whale.zwztf.net  (仅 fallback)
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const RENDER_API = process.env.RENDER_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'worker-key-2026-prod';
const BASIC_AUTH = 'Basic d2hhbGU6d2hhbGU=';

// === Fallback 环境变量（向后兼容） ===
const FALLBACK_BASE_URL = process.env.WHALE_BASE_URL || 'https://whale.zwztf.net';
const FALLBACK_REFRESH_TOKEN = process.env.WHALE_REFRESH_TOKEN || '';
const FALLBACK_SHOP_ID = process.env.WHALE_SHOP_ID || '1579337942525061';
const FALLBACK_TOKEN_FILE = path.join(__dirname, '..', 'token.tmp');

// === 凭证池加载 ===
const CREDENTIALS_PATH = path.join(__dirname, 'whale-credentials.json');
let credentialsPool = {};
try {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  credentialsPool = raw.credentials || {};
  console.log(`[worker] credentials pool loaded: ${Object.keys(credentialsPool).length} credential(s)`);
} catch (e) {
  console.warn(`[worker] whale-credentials.json not found or invalid, using env fallback: ${e.message}`);
}

// === Token 缓存（按 credentialKey 隔离） ===
const tokenCache = new Map(); // key → { token, exp }

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

// === Token 恢复：从文件读取 ===
function recoverTokenFromFile(tokenFilePath) {
  try {
    const absPath = path.resolve(__dirname, tokenFilePath);
    if (!fs.existsSync(absPath)) return null;
    const content = fs.readFileSync(absPath, 'utf8').trim();
    if (content.startsWith('{')) {
      const obj = JSON.parse(content);
      return obj.refresh_token || obj.WHALE_REFRESH_TOKEN || null;
    }
    return content || null;
  } catch {
    return null;
  }
}

// === Token 刷新 ===
async function refreshWithToken(baseUrl, refreshToken) {
  const url = `${baseUrl}/api/auth/oauth/token?refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token&scope=server`;
  const r = await request(url, { method: 'POST', headers: { 'Authorization': BASIC_AUTH } });
  return r.data;
}

/**
 * 获取指定 credentialKey 的 access_token
 * 隔离缓存，互不干扰
 */
async function getTokenForCredential(credentialKey) {
  // 1. 检查缓存
  const cached = tokenCache.get(credentialKey);
  if (cached && Date.now() < cached.exp - 300000) return cached;

  // 2. 解析凭证信息
  const cred = credentialsPool[credentialKey];
  const baseUrl = cred?.baseUrl || FALLBACK_BASE_URL;
  const refreshToken = cred?.refreshToken || FALLBACK_REFRESH_TOKEN;
  const tokenFile = cred?.tokenFile || FALLBACK_TOKEN_FILE;

  // 策略1: 用凭证池中的 refreshToken
  if (refreshToken) {
    const data = await refreshWithToken(baseUrl, refreshToken);
    if (data?.access_token) {
      const entry = { token: data.access_token, exp: Date.now() + (data.expires_in || 604799) * 1000, baseUrl };
      tokenCache.set(credentialKey, entry);
      console.log(`[worker] [${credentialKey}] token refreshed, expires ${data.expires_in}s`);
      return entry;
    }
    console.warn(`[worker] [${credentialKey}] pool token failed: ${JSON.stringify(data)}`);
  }

  // 策略2: 从 tokenFile 恢复
  const fileToken = recoverTokenFromFile(tokenFile);
  if (fileToken && fileToken !== refreshToken) {
    console.log(`[worker] [${credentialKey}] trying token from file: ${tokenFile}`);
    const data = await refreshWithToken(baseUrl, fileToken);
    if (data?.access_token) {
      const entry = { token: data.access_token, exp: Date.now() + (data.expires_in || 604799) * 1000, baseUrl };
      tokenCache.set(credentialKey, entry);
      console.log(`[worker] [${credentialKey}] token recovered from file, expires ${data.expires_in}s`);
      return entry;
    }
    console.warn(`[worker] [${credentialKey}] file token also failed: ${JSON.stringify(data)}`);
  }

  // 策略3: 全部失效
  const err = new Error(`TOKEN_EXPIRED [${credentialKey}]: All refresh_tokens invalid. Need browser login to recover.`);
  err.code = 'TOKEN_EXPIRED';
  err.credentialKey = credentialKey;
  throw err;
}

// === 鲸品云操作（参数化 baseUrl + shopId） ===
async function findStoreSkuId(baseUrl, token, barcode, shopId) {
  const url = `${baseUrl}/api/web/gms/b2c/store-goods/page?current=1&size=20&barcode=${encodeURIComponent(barcode)}`;
  const r = await request(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
  if (!r.data || r.data.code !== 0) throw new Error(`查询失败: ${JSON.stringify(r.data)}`);

  for (const rec of (r.data.data?.records || [])) {
    if (String(rec.shopId) === String(shopId) && rec.skuList?.length > 0) {
      return { storeSkuId: rec.skuList[0].id, currentStatus: rec.skuList[0].saleStatus, currentPrice: rec.skuList[0].salePrice };
    }
  }
  return null;
}

async function onSale(baseUrl, token, storeSkuId) {
  const url = `${baseUrl}/api/web/gms/b2c/store-goods/skus/sale-status/on-sale/batch`;
  const r = await request(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
    JSON.stringify({ storeSkuIds: [storeSkuId], saleStatus: 1 }));
  if (r.data?.code !== 0) throw new Error(`上架失败: ${JSON.stringify(r.data)}`);
  return r.data;
}

const DEFAULT_OFFLINE_STOCK = 5;
async function ensureOfflineStock(baseUrl, token, barcode, shopId) {
  const qUrl = `${baseUrl}/api/web/gms/b2c/store-goods/stocks/page?size=20&current=1&isSkuCodeFuzzy=0&isBarcodeFuzzy=0&barcode=${encodeURIComponent(barcode)}&organizationIds=${encodeURIComponent(shopId)}`;
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

  const pUrl = `${baseUrl}/api/web/gms/b2c/store-goods/stocks/store-sku/stocks`;
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

// === 主流程（多品牌隔离） ===
async function processTask(task) {
  const { id, barcode, item_name, action, whale_shop_id, credential_key } = task;

  // 解析隔离参数（fallback 兼容旧数据）
  const credKey = credential_key || '__fallback__';
  const shopId = whale_shop_id || FALLBACK_SHOP_ID;

  console.log(`[worker] task#${id}: ${item_name} (${barcode}) action=${action} shop=${shopId} cred=${credKey}`);

  if (action !== 'shelf') {
    return { ok: false, error: `暂不支持操作: ${action}` };
  }

  // 获取对应凭证的 token
  const { token, baseUrl } = await getTokenForCredential(credKey);

  // 查找 storeSkuId（按门店级 shopId 精确匹配）
  const sku = await findStoreSkuId(baseUrl, token, barcode, shopId);
  if (!sku) {
    return { ok: false, error: `商品未找到: barcode=${barcode} 在鲸品云门店 ${shopId} 无 SKU` };
  }

  // 已经在架则跳过
  if (sku.currentStatus === 1) {
    console.log(`[worker] task#${id} already on-sale, skip`);
    return { ok: true, skipped: true, reason: 'already_on_sale' };
  }

  // 先补线下库存
  const stockResult = await ensureOfflineStock(baseUrl, token, barcode, shopId);
  if (stockResult.ok) {
    console.log(`[worker] task#${id} stock seeded: ${stockResult.from} → ${stockResult.to}`);
  } else if (stockResult.skipped) {
    console.log(`[worker] task#${id} stock skipped: ${stockResult.reason}${stockResult.current!=null?' ('+stockResult.current+')':''}`);
  }

  // 上架
  await onSale(baseUrl, token, sku.storeSkuId);
  console.log(`[worker] task#${id} on-sale ✓ (shop=${shopId})`);

  return { ok: true, storeSkuId: sku.storeSkuId, shopId };
}

async function main() {
  console.log(`[worker] starting... RENDER=${RENDER_API}`);
  console.log(`[worker] credentials pool: ${Object.keys(credentialsPool).length} key(s), fallback shop=${FALLBACK_SHOP_ID}`);

  // 1. Claim tasks
  const tasks = await claimTasks();
  if (tasks.length === 0) {
    console.log('[worker] no EXECUTING tasks, done.');
    return;
  }
  console.log(`[worker] claimed ${tasks.length} task(s)`);

  // 2. 按 credential_key 分组打印概况
  const groups = {};
  for (const t of tasks) {
    const k = t.credential_key || '__fallback__';
    groups[k] = (groups[k] || 0) + 1;
  }
  console.log(`[worker] task distribution:`, JSON.stringify(groups));

  // 3. Process each task（token 按 credentialKey 自动缓存复用）
  let success = 0, failed = 0;
  for (const task of tasks) {
    try {
      const result = await processTask(task);
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
