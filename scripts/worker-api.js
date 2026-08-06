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
const { execFile } = require('child_process');

const RENDER_API = process.env.RENDER_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'worker-key-2026-prod';
const BASIC_AUTH = 'Basic d2hhbGU6d2hhbGU=';
// DRY_RUN=1：只 claim + 刷 token + 查 SKU，绝不补库存/上架/report（安全冒烟用）
const DRY_RUN = !!process.env.DRY_RUN;

// === Fallback 环境变量（向后兼容） ===
const FALLBACK_BASE_URL = process.env.WHALE_BASE_URL || 'https://whale.zwztf.net';
const FALLBACK_REFRESH_TOKEN = process.env.WHALE_REFRESH_TOKEN || '';
const FALLBACK_SHOP_ID = process.env.WHALE_SHOP_ID || '1579337942525061';
const FALLBACK_TOKEN_FILE = path.join(__dirname, '..', 'token.tmp');

// === 凭证池加载 ===
const CREDENTIALS_PATH = path.join(__dirname, 'whale-credentials.json');
let credentialsPool = {};
let credentialsRaw = {};
try {
  credentialsRaw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  credentialsPool = credentialsRaw.credentials || {};
  console.log(`[worker] credentials pool loaded: ${Object.keys(credentialsPool).length} credential(s)`);
} catch (e) {
  console.warn(`[worker] whale-credentials.json not found or invalid, using env fallback: ${e.message}`);
}

// === Token 缓存（按 credentialKey:shopId 隔离） ===
const tokenCache = new Map(); // cacheKey → { token, exp }
const refreshInFlight = new Map(); // cacheKey → Promise (并发锁，防止同一 cacheKey 的多个并发刷新导致 token rotation race)

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

// === Token 刷新（支持租户隔离） ===
async function refreshWithToken(baseUrl, refreshToken, shopId) {
  let url = `${baseUrl}/api/auth/oauth/token?refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token&scope=server`;
  if (shopId) url += `&organizationIds=${encodeURIComponent(shopId)}`;
  const r = await request(url, { method: 'POST', headers: { 'Authorization': BASIC_AUTH } });
  return r.data;
}

/**
 * 实际执行 token 刷新（内部函数，由并发锁保护）
 */
async function _doRefresh(credentialKey, shopId) {
  const cred = credentialsPool[credentialKey];
  const baseUrl = cred?.baseUrl || FALLBACK_BASE_URL;
  const refreshToken = cred?.refreshToken || FALLBACK_REFRESH_TOKEN;
  const tokenFile = cred?.tokenFile || FALLBACK_TOKEN_FILE;
  const cacheKey = `${credentialKey}:${shopId}`;

  // 策略1: 用凭证池中的 refreshToken（带 shopId 实现租户隔离）
  if (refreshToken) {
    const data = await refreshWithToken(baseUrl, refreshToken, shopId);
    if (data?.access_token) {
      const entry = { token: data.access_token, exp: Date.now() + (data.expires_in || 604799) * 1000, baseUrl };
      tokenCache.set(cacheKey, entry);
      // 持久化旋转后的 refresh_token，防止 token 丢失
      if (data.refresh_token && data.refresh_token !== refreshToken) {
        if (cred) {
          cred.refreshToken = data.refresh_token;
          try {
            fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({ _comment: credentialsRaw._comment, credentials: credentialsPool }, null, 2), 'utf8');
          } catch (e) { /* ignore write errors */ }
        }
        try { fs.writeFileSync(path.resolve(__dirname, tokenFile), data.refresh_token, 'utf8'); } catch (e) { /* ignore */ }
      }
      console.log(`[worker] [${credentialKey}] token refreshed for shop=${shopId}, expires ${data.expires_in}s`);
      return entry;
    }
    console.warn(`[worker] [${credentialKey}] pool token failed: ${JSON.stringify(data)}`);
  }

  // 策略2: 从 tokenFile 恢复
  const fileToken = recoverTokenFromFile(tokenFile);
  if (fileToken && fileToken !== refreshToken) {
    console.log(`[worker] [${credentialKey}] trying token from file: ${tokenFile}`);
    const data = await refreshWithToken(baseUrl, fileToken, shopId);
    if (data?.access_token) {
      const entry = { token: data.access_token, exp: Date.now() + (data.expires_in || 604799) * 1000, baseUrl };
      tokenCache.set(cacheKey, entry);
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

/**
 * 获取指定 credentialKey + shopId 的 access_token
 * 缓存按 (credentialKey, shopId) 隔离，确保租户上下文正确
 * 并发安全：同一 cacheKey 的多个请求共享同一个 Promise，避免 token rotation race
 */
async function getTokenForCredential(credentialKey, shopId) {
  // 1. 检查缓存（按 credentialKey:shopId 隔离）
  const cacheKey = `${credentialKey}:${shopId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.exp - 300000) return cached;

  // 2. 并发锁：如果已有同 cacheKey 的刷新在进行中，等待它
  if (refreshInFlight.has(cacheKey)) {
    console.log(`[worker] [${credentialKey}] refresh already in-flight for shop=${shopId}, waiting...`);
    return refreshInFlight.get(cacheKey);
  }

  // 3. 发起刷新并注册 Promise
  const promise = _doRefresh(credentialKey, shopId).finally(() => {
    refreshInFlight.delete(cacheKey);
  });
  refreshInFlight.set(cacheKey, promise);
  return promise;
}

// === 鲸品云操作（参数化 baseUrl + shopId） ===
async function findStoreSkuId(baseUrl, token, barcode, shopId) {
  const url = `${baseUrl}/api/web/gms/b2c/store-goods/page?current=1&size=20&barcode=${encodeURIComponent(barcode)}&organizationIds=${encodeURIComponent(shopId)}`;
  const r = await request(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
  if (!r.data || r.data.code !== 0) throw new Error(`查询失败: ${JSON.stringify(r.data)}`);

  for (const rec of (r.data.data?.records || [])) {
    if (String(rec.shopId) === String(shopId) && rec.skuList?.length > 0) {
      const sku = rec.skuList[0];
      return {
        storeSkuId: sku.id,
        currentStatus: sku.saleStatus,
        currentPrice: sku.salePrice,
        // 库存双轨字段（用于判断走线上还是线下补货）
        isReceiveStock: sku.isReceiveStock,     // 1=接收线下库存(线上自动跟随) 0=独立管理线上库存
        currentStock: Number(sku.currentStock) || 0,   // 线上库存
        safeStock: Number(sku.safeStock) || 0,         // 安全库存
        availableStock: Number(sku.availableStock) || 0, // 可用库存 = currentStock - safeStock
        offlineStock: Number(sku.offlineStock) || 0,   // 线下库存
      };
    }
  }
  return null;
}

async function onSale(baseUrl, token, storeSkuId, shopId) {
  let url = `${baseUrl}/api/web/gms/b2c/store-goods/skus/sale-status/on-sale/batch`;
  if (shopId) url += `?organizationIds=${encodeURIComponent(shopId)}`;
  const r = await request(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
    JSON.stringify({ storeSkuIds: [storeSkuId], saleStatus: 1 }));
  if (r.data?.code !== 0) throw new Error(`上架失败: ${JSON.stringify(r.data)}`);
  return r.data;
}

const DEFAULT_ONLINE_STOCK = 10;   // 线上库存目标值（默认10，防超售；任务带 fill_stock 时优先用任务值）
const DEFAULT_OFFLINE_STOCK = 10;  // 线下库存目标值（默认10，防超售；任务带 fill_stock 时优先用任务值）

/**
 * 直接补线上库存（当 isReceiveStock=0 时使用）
 * 用 UI 抓包的 API: POST /skus/stocks + {storeSkuId, currentStock}
 */
async function ensureOnlineStock(baseUrl, token, storeSkuId, targetStock = DEFAULT_ONLINE_STOCK) {
  const url = `${baseUrl}/api/web/gms/b2c/store-goods/skus/stocks`;
  const r = await request(url, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
    JSON.stringify({ storeSkuId, currentStock: targetStock }));
  if (r.data?.code !== 0) throw new Error(`补线上库存失败: ${JSON.stringify(r.data)}`);
  return { ok: true, to: targetStock };
}

async function ensureOfflineStock(baseUrl, token, barcode, shopId, targetStock = DEFAULT_OFFLINE_STOCK) {
  const qUrl = `${baseUrl}/api/web/gms/b2c/store-goods/stocks/page?size=20&current=1&isSkuCodeFuzzy=0&isBarcodeFuzzy=0&barcode=${encodeURIComponent(barcode)}&organizationIds=${encodeURIComponent(shopId)}`;
  const q = await request(qUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
  if (!q.data || q.data.code !== 0) throw new Error(`查询库存失败: ${JSON.stringify(q.data)}`);
  const rec = (q.data.data?.records || [])[0];
  if (!rec) return { skipped: true, reason: 'stock record not found' };
  const stock = (rec.storeSkuStockList || [])[0];
  if (!stock) return { skipped: true, reason: 'sku stock not found' };

  const current = Number(stock.offlineStock) || 0;
  if (current >= targetStock) {
    return { skipped: true, reason: 'sufficient', current };
  }

  const pUrl = `${baseUrl}/api/web/gms/b2c/store-goods/stocks/store-sku/stocks`;
  const p = await request(pUrl, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
    JSON.stringify({ id: stock.id, offlineStock: String(targetStock) }));
  if (p.data?.code !== 0) throw new Error(`补库存失败: ${JSON.stringify(p.data)}`);
  return { ok: true, from: current, to: targetStock, stockId: stock.id };
}

// === Render API ===
async function claimTasks() {
  const url = `${RENDER_API}/v1/internal/worker/claim`;
  // 若指定 ONLY_CREDENTIAL_KEY，claim 层就只拿该品牌任务（claim 接口 P0 后已修复 credentialKey 过滤），
  // 从源头避免刷新/占用其他品牌任务；未指定则 claim 全部（向后兼容）。
  const onlyCred = process.env.ONLY_CREDENTIAL_KEY || '';
  const body = onlyCred ? JSON.stringify({ credentialKey: onlyCred }) : '{}';
  const r = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY } }, body);
  if (!r.data?.ok) throw new Error(`claim failed: ${JSON.stringify(r.data)}`);
  return r.data.tasks || [];
}

async function reportResult(taskId, success, errorMsg, operationType) {
  const url = `${RENDER_API}/v1/internal/worker/report`;
  const body = { taskId, success, errorMsg: errorMsg || undefined, operationType: operationType || undefined };
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

  // 获取对应凭证的 token（带租户隔离）
  const { token, baseUrl } = await getTokenForCredential(credKey, shopId);

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

  // DRY_RUN：查到 SKU 但不做任何写操作（补库存/上架），只报告将要做什么
  if (DRY_RUN) {
    console.log(`[worker] task#${id} DRY_RUN: 已查到SKU storeSkuId=${sku.storeSkuId} status=${sku.currentStatus} avail=${sku.availableStock} isReceive=${sku.isReceiveStock}（不上架）`);
    return { ok: true, dryRun: true, storeSkuId: sku.storeSkuId, wouldSeedStock: sku.availableStock <= 0 };
  }

  // 补库存策略（鲸品云双轨制）：
  //   isReceiveStock=1 → 线上库存自动跟随线下，补线下即可
  //   isReceiveStock=0 → 线上库存独立管理，须直接补线上
  // 关键约束：availableStock = currentStock - safeStock，只有 > 0 时渠道才能真正上架
  // 补货目标值：课长手填 fill_stock（1-99）优先，否则默认 10。
  let fillTarget = DEFAULT_ONLINE_STOCK;
  if (task.fill_stock != null) {
    const n = Math.round(Number(task.fill_stock));
    if (Number.isFinite(n)) fillTarget = Math.min(99, Math.max(1, n));
  }
  if (sku.availableStock <= 0) {
    if (sku.isReceiveStock === 0) {
      // 独立管理线上库存：直接 POST /skus/stocks
      const r = await ensureOnlineStock(baseUrl, token, sku.storeSkuId, fillTarget);
      console.log(`[worker] task#${id} online-stock seeded: ${sku.currentStock} → ${r.to} (safe=${sku.safeStock})`);
    } else {
      // 接收线下库存：补线下，线上自动跟随
      const r = await ensureOfflineStock(baseUrl, token, barcode, shopId, fillTarget);
      if (r.ok) console.log(`[worker] task#${id} offline-stock seeded: ${r.from} → ${r.to}`);
      else if (r.skipped) console.log(`[worker] task#${id} offline-stock skipped: ${r.reason}${r.current!=null?' ('+r.current+')':''}`);
    }
  } else {
    console.log(`[worker] task#${id} stock sufficient: available=${sku.availableStock} (isReceive=${sku.isReceiveStock})`);
  }

  // 上架
  await onSale(baseUrl, token, sku.storeSkuId, shopId);
  console.log(`[worker] task#${id} on-sale ✓ (shop=${shopId})`);

  return { ok: true, storeSkuId: sku.storeSkuId, shopId };
}

async function main() {
  console.log(`[worker] starting... RENDER=${RENDER_API}`);
  console.log(`[worker] credentials pool: ${Object.keys(credentialsPool).length} key(s), fallback shop=${FALLBACK_SHOP_ID}`);

  // 1. Claim tasks
  let tasks = await claimTasks();
  if (tasks.length === 0) {
    console.log('[worker] no EXECUTING tasks, done.');
    return;
  }
  console.log(`[worker] claimed ${tasks.length} task(s)`);

  // 1.5 品牌过滤（防止与昆仑 worker 并发时互抢/误处理）：
  //   ONLY_CREDENTIAL_KEY=xq-whale → 只处理兴勤任务，其他品牌任务原样留 EXECUTING 不 touch。
  //   claim 已把它们 updated_at 刷新了，但不 report，昆仑 worker 下轮仍会正常认领。
  const ONLY_CRED = process.env.ONLY_CREDENTIAL_KEY || '';
  if (ONLY_CRED) {
    const before = tasks.length;
    const skipped = tasks.filter(t => (t.credential_key || '') !== ONLY_CRED);
    tasks = tasks.filter(t => (t.credential_key || '') === ONLY_CRED);
    console.log(`[worker] ONLY_CREDENTIAL_KEY=${ONLY_CRED} 过滤：保留 ${tasks.length}/${before}，跳过其他品牌 ${skipped.length} 条(不report,留给对应worker)`);
    if (tasks.length === 0) { console.log('[worker] 过滤后无本品牌任务，done.'); return; }
  }

  // 2. 按 credential_key 分组打印概况
  const groups = {};
  for (const t of tasks) {
    const k = t.credential_key || '__fallback__';
    groups[k] = (groups[k] || 0) + 1;
  }
  console.log(`[worker] task distribution:`, JSON.stringify(groups));

  // 3. Process each task（token 按 credentialKey 自动缓存复用）
  let success = 0, failed = 0, dry = 0;
  for (const task of tasks) {
    try {
      const result = await processTask(task);
      if (result.dryRun) {
        dry++;
        console.log(`[worker] task#${task.id} → DRY(查到SKU未上架未report)`);
        continue; // DRY_RUN 不 report，任务保持 EXECUTING
      }
      if (result.ok) {
        const opType = result.skipped ? 'already_on_sale' : 'operated';
        await reportResult(task.id, true, undefined, opType);
        success++;
        console.log(`[worker] task#${task.id} → DONE (${opType})`);
      } else {
        await reportResult(task.id, false, result.error);
        failed++;
        console.log(`[worker] task#${task.id} → FAILED: ${result.error}`);
      }
    } catch (e) {
      if (DRY_RUN) { console.log(`[worker] task#${task.id} → DRY EXC(未report): ${e.message}`); continue; }
      await reportResult(task.id, false, e.message);
      failed++;
      console.error(`[worker] task#${task.id} → ERROR: ${e.message}`);
    }
  }

  console.log(`[worker] done. success=${success} failed=${failed} dry=${dry}${DRY_RUN ? ' (DRY_RUN: 未做任何上架/report)' : ''}`);
}

main().catch(e => {
  console.error('[worker] fatal:', e.message);
  process.exit(1);
});
