/**
 * 重试脚本 V3：按租户隔离 token
 * 关键修复：refresh token 时带 organizationIds，获取对应租户上下文的 access_token
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const RENDER_API = process.env.RENDER_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'worker-key-2026-prod';
const BASIC_AUTH = 'Basic d2hhbGU6d2hhbGU=';

const CREDENTIALS_PATH = path.join(__dirname, 'whale-credentials.json');
const credentialsRaw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
const credentialsPool = credentialsRaw.credentials || {};

// Token 缓存：按 (credentialKey + shopId) 隔离
const tokenCache = new Map();

function request(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const reqOpts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: opts.method || 'GET', headers: opts.headers || {},
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

// 刷新 token 时带 organizationIds，获取对应租户的 access_token
async function refreshWithToken(baseUrl, refreshToken, shopId) {
  let url = `${baseUrl}/api/auth/oauth/token?refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token&scope=server`;
  if (shopId) url += `&organizationIds=${encodeURIComponent(shopId)}`;
  return (await request(url, { method: 'POST', headers: { 'Authorization': BASIC_AUTH } })).data;
}

// 读取共享 tokenFile 中的最新 refresh_token（可能已被其他 key 旋转更新）
function readSharedTokenFile(cred) {
  if (!cred.tokenFile) return null;
  try {
    const absPath = path.resolve(__dirname, cred.tokenFile);
    if (!fs.existsSync(absPath)) return null;
    return fs.readFileSync(absPath, 'utf8').trim() || null;
  } catch { return null; }
}

// 持久化旋转后的 refresh_token 到所有共享凭证和 tokenFile
function persistRotatedToken(oldToken, newToken, tokenFile) {
  let updated = false;
  for (const [key, cred] of Object.entries(credentialsPool)) {
    if (cred.refreshToken === oldToken) { cred.refreshToken = newToken; updated = true; }
  }
  if (updated) {
    try { fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({ ...credentialsRaw, credentials: credentialsPool }, null, 2), 'utf8'); } catch {}
  }
  if (tokenFile) {
    try { fs.writeFileSync(path.resolve(__dirname, tokenFile), newToken, 'utf8'); } catch {}
  }
}

/**
 * 获取指定 (credentialKey, shopId) 的 access_token
 * 关键：传入 shopId 作为 organizationIds，确保 token 在正确的租户上下文中
 */
async function getTokenForCredential(credentialKey, shopId) {
  const cacheKey = `${credentialKey}:${shopId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.exp - 300000) return cached;

  const cred = credentialsPool[credentialKey];
  if (!cred) throw new Error(`credential not found: ${credentialKey}`);
  const { baseUrl, tokenFile } = cred;

  // 优先用共享 tokenFile 中的最新 refresh_token
  let refreshToken = cred.refreshToken;
  const fileToken = readSharedTokenFile(cred);
  if (fileToken && fileToken !== refreshToken) {
    refreshToken = fileToken;
  }

  // 刷新时带 shopId，获取该租户上下文的 access_token
  let data = await refreshWithToken(baseUrl, refreshToken, shopId);

  if (!data?.access_token) {
    throw new Error(`token refresh failed for ${credentialKey} (shop=${shopId}): ${JSON.stringify(data)}`);
  }

  const entry = { token: data.access_token, exp: Date.now() + (data.expires_in || 604799) * 1000, baseUrl };
  tokenCache.set(cacheKey, entry);

  // 持久化旋转后的 refresh_token（所有共享凭证同步更新）
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.log(`  [${credentialKey}] token rotated, persisting`);
    persistRotatedToken(refreshToken, data.refresh_token, tokenFile);
  }

  console.log(`  [${credentialKey}] token OK for shop=${shopId}, expires ${data.expires_in}s`);
  return entry;
}

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
        isReceiveStock: sku.isReceiveStock,
        currentStock: Number(sku.currentStock) || 0,
        safeStock: Number(sku.safeStock) || 0,
        availableStock: Number(sku.availableStock) || 0,
        offlineStock: Number(sku.offlineStock) || 0,
      };
    }
  }
  return null;
}

async function ensureOnlineStock(baseUrl, token, storeSkuId, targetStock = 10) {
  const url = `${baseUrl}/api/web/gms/b2c/store-goods/skus/stocks`;
  const r = await request(url, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
    JSON.stringify({ storeSkuId, currentStock: targetStock }));
  if (r.data?.code !== 0) throw new Error(`补线上库存失败: ${JSON.stringify(r.data)}`);
  return { ok: true, to: targetStock };
}

async function ensureOfflineStock(baseUrl, token, barcode, shopId, targetStock = 10) {
  const qUrl = `${baseUrl}/api/web/gms/b2c/store-goods/stocks/page?size=20&current=1&isSkuCodeFuzzy=0&isBarcodeFuzzy=0&barcode=${encodeURIComponent(barcode)}&organizationIds=${encodeURIComponent(shopId)}`;
  const q = await request(qUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
  if (!q.data || q.data.code !== 0) throw new Error(`查询库存失败: ${JSON.stringify(q.data)}`);
  const rec = (q.data.data?.records || [])[0];
  if (!rec) return { skipped: true, reason: 'no record' };
  const stock = (rec.storeSkuStockList || [])[0];
  if (!stock) return { skipped: true, reason: 'no stock' };
  const current = Number(stock.offlineStock) || 0;
  if (current >= targetStock) return { skipped: true, reason: 'sufficient', current };
  const pUrl = `${baseUrl}/api/web/gms/b2c/store-goods/stocks/store-sku/stocks`;
  await request(pUrl, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
    JSON.stringify({ id: stock.id, offlineStock: String(targetStock) }));
  return { ok: true, from: current, to: targetStock };
}

async function onSale(baseUrl, token, storeSkuId, shopId) {
  let url = `${baseUrl}/api/web/gms/b2c/store-goods/skus/sale-status/on-sale/batch`;
  if (shopId) url += `?organizationIds=${encodeURIComponent(shopId)}`;
  const r = await request(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
    JSON.stringify({ storeSkuIds: [storeSkuId], saleStatus: 1 }));
  if (r.data?.code !== 0) throw new Error(`上架失败: ${JSON.stringify(r.data)}`);
  return r.data;
}

async function reportResult(taskId, success, errorMsg, operationType) {
  const url = `${RENDER_API}/v1/internal/worker/report`;
  const body = { taskId, success, errorMsg: errorMsg || undefined, operationType: operationType || undefined };
  await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY } },
    JSON.stringify(body));
}

async function main() {
  console.log(`[retry] fetching all tasks from ${RENDER_API}...`);
  const dumpUrl = `${RENDER_API}/v1/internal/db-dump?table=tasks`;
  const dump = await request(dumpUrl, { method: 'GET', headers: { 'x-internal-key': INTERNAL_KEY } });
  const allTasks = dump.data?.rows || [];
  const tasks = allTasks.filter(t => t.status === 'FAILED');
  console.log(`[retry] ${tasks.length} FAILED tasks out of ${allTasks.length} total`);

  if (tasks.length === 0) { console.log('[retry] nothing to do'); return; }

  const groups = {};
  for (const t of tasks) groups[t.credential_key || '?'] = (groups[t.credential_key || '?'] || 0) + 1;
  console.log(`[retry] distribution:`, JSON.stringify(groups));

  let success = 0, failed = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const credKey = task.credential_key || '__fallback__';
    const shopId = task.whale_shop_id;

    try {
      // 关键：传 shopId 获取对应租户上下文的 token
      const { token, baseUrl } = await getTokenForCredential(credKey, shopId);

      const sku = await findStoreSkuId(baseUrl, token, task.barcode, shopId);
      if (!sku) {
        await reportResult(task.id, false, `retry: SKU not found barcode=${task.barcode} shop=${shopId}`);
        failed++;
        errors.push(`#${task.id} ${task.item_name}: SKU not found (shop=${shopId})`);
        continue;
      }

      if (sku.currentStatus === 1) {
        await reportResult(task.id, true, undefined, 'already_on_sale');
        skipped++;
        console.log(`  [${i+1}/${tasks.length}] #${task.id} ${task.item_name} -> SKIP (on-sale)`);
        continue;
      }

      // 双轨补货：isReceiveStock=0 补线上，=1 补线下；补货目标 fill_stock 优先，否则默认10
      let fillTarget = 10;
      if (task.fill_stock != null) {
        const n = Math.round(Number(task.fill_stock));
        if (Number.isFinite(n)) fillTarget = Math.min(99, Math.max(1, n));
      }
      if (sku.availableStock <= 0) {
        if (sku.isReceiveStock === 0) {
          const r = await ensureOnlineStock(baseUrl, token, sku.storeSkuId, fillTarget);
          console.log(`    online-stock: ${sku.currentStock}->${r.to} (safe=${sku.safeStock})`);
        } else {
          const r = await ensureOfflineStock(baseUrl, token, task.barcode, shopId, fillTarget);
          if (r.ok) console.log(`    offline-stock: ${r.from}->${r.to}`);
        }
      }

      await onSale(baseUrl, token, sku.storeSkuId, shopId);
      await reportResult(task.id, true, undefined, 'operated');
      success++;
      console.log(`  [${i+1}/${tasks.length}] #${task.id} ${task.item_name} -> OK`);

    } catch (e) {
      try { await reportResult(task.id, false, `retry: ${e.message}`); } catch {}
      failed++;
      errors.push(`#${task.id} ${task.item_name}: ${e.message}`);
      console.error(`  [${i+1}/${tasks.length}] #${task.id} ${task.item_name} -> FAIL: ${e.message}`);
    }

    if ((i + 1) % 10 === 0) await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n[retry] DONE. success=${success} skipped=${skipped} failed=${failed} total=${tasks.length}`);
  if (errors.length > 0) {
    console.log(`[retry] ${errors.length} errors:`);
    errors.forEach(e => console.log(`  - ${e}`));
  }
}

main().catch(e => { console.error('[retry] fatal:', e.message); process.exit(1); });
