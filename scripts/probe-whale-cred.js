/**
 * probe-whale-cred.js — 鲸品云凭证验证工具（只读：不补库存、不上架、不 report）
 *
 * 用途：新机器部署时验证 whale-credentials.json 中的凭证是否有效、租户隔离是否正确。
 *
 * 用法：
 *   cd scripts
 *   node probe-whale-cred.js <credentialKey>
 *   例：node probe-whale-cred.js csnc-whale
 *
 * 步骤：
 *   1) 从 brands-config.json 找到 credentialKey 对应品牌，取其第一个门店的 whaleShopId
 *   2) 用 refresh_token 刷新 access_token（带 organizationIds 租户隔离，与 worker-api.js 完全一致）
 *   3) 带 organizationIds 查询一页商品列表（size=1），total > 0 才算通过
 *   4) 若刷新导致 refresh_token 轮转，回写 whale-credentials.json 与 tokenFile（与 worker-api.js 行为一致，防止凭证丢失）
 *
 * 退出码：0=通过  1=失败  2=参数/配置错误
 */
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASIC_AUTH = 'Basic d2hhbGU6d2hhbGU=';
const CREDENTIALS_PATH = path.join(__dirname, 'whale-credentials.json');

const credKey = process.argv[2];
if (!credKey) {
  console.error('用法: node probe-whale-cred.js <credentialKey>   例: node probe-whale-cred.js csnc-whale');
  process.exit(2);
}

let credentialsRaw = {};
let credentialsPool = {};
try {
  credentialsRaw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  credentialsPool = credentialsRaw.credentials || {};
} catch (e) {
  console.error('whale-credentials.json 读取失败: ' + e.message);
  process.exit(2);
}
const cred = credentialsPool[credKey];
if (!cred || !cred.refreshToken) {
  console.error('whale-credentials.json 中缺少凭证 ' + credKey + '（或其 refreshToken 为空）');
  process.exit(2);
}

let brandKey = null, shopId = null, brandName = '';
try {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'brands-config.json'), 'utf8'));
  const brands = config.brands || {};
  for (const k of Object.keys(brands)) {
    if (brands[k].credentialKey === credKey) {
      brandKey = k;
      brandName = brands[k].brandName || k;
      const stores = brands[k].stores || [];
      shopId = stores.length > 0 ? stores[0].whaleShopId : null;
      break;
    }
  }
} catch (e) {
  console.error('brands-config.json 读取失败: ' + e.message);
  process.exit(2);
}
if (!shopId) {
  console.error('brands-config.json 中找不到 credentialKey=' + credKey + ' 的品牌，或其第一个门店缺少 whaleShopId');
  process.exit(2);
}

const BASE = (cred.baseUrl || 'https://whale.zwztf.net').replace(/\/+$/, '');

function request(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
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

async function main() {
  console.log(`[verify] 品牌=${brandName}(${brandKey}) credentialKey=${credKey} shopId=${shopId}`);

  // 1) 刷新 token（带 organizationIds 租户隔离）
  let url = `${BASE}/api/auth/oauth/token?refresh_token=${encodeURIComponent(cred.refreshToken)}&grant_type=refresh_token&scope=server`;
  url += `&organizationIds=${encodeURIComponent(shopId)}`;
  const r = await request(url, { method: 'POST', headers: { 'Authorization': BASIC_AUTH } });
  if (!r.data || !r.data.access_token) {
    console.error('token 刷新失败（refresh_token 可能已失效，需重登鲸品云重新提取）: ' + JSON.stringify(r.data).slice(0, 300));
    process.exit(1);
  }
  const token = r.data.access_token;
  console.log(`[verify] token 刷新成功, expires_in=${r.data.expires_in}s`);

  // 2) refresh_token 轮转回写（与 worker-api.js 一致）
  if (r.data.refresh_token && r.data.refresh_token !== cred.refreshToken) {
    cred.refreshToken = r.data.refresh_token;
    try {
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentialsRaw, null, 2), 'utf8');
      console.log('[verify] refresh_token 已轮转并回写 whale-credentials.json');
    } catch (e) { console.warn('[verify] 回写 whale-credentials.json 失败: ' + e.message); }
    if (cred.tokenFile) {
      try { fs.writeFileSync(path.resolve(__dirname, cred.tokenFile), r.data.refresh_token, 'utf8'); } catch (e) { /* ignore */ }
    }
  }

  // 3) 带 organizationIds 查询一页商品
  const qUrl = `${BASE}/api/web/gms/b2c/store-goods/page?current=1&size=1&organizationIds=${encodeURIComponent(shopId)}`;
  const q = await request(qUrl, { method: 'GET', headers: { 'Authorization': 'Bearer ' + token } });
  if (!q.data || q.data.code !== 0) {
    console.error('商品查询失败（token 有效但查询被拒，检查账号权限/租户）: ' + JSON.stringify(q.data).slice(0, 300));
    process.exit(1);
  }
  const total = q.data.data && q.data.data.total;
  if (!(Number(total) > 0)) {
    console.error('查询成功但商品总数为 0 —— organizationIds/租户很可能不对，凭证验证不通过');
    process.exit(1);
  }
  const sample = ((q.data.data.records || [])[0] || {}).name || '';
  console.log(`[verify] ✅ 验证通过: 商品总数=${total}${sample ? ' (样例: ' + sample + ')' : ''}`);
  process.exit(0);
}

main().catch(e => {
  console.error('验证异常: ' + e.message);
  process.exit(1);
});
