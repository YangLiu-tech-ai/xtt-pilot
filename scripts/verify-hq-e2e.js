#!/usr/bin/env node
/**
 * P4 部署后联调验证脚本（against Render 或本地后端）
 *
 * 用法：
 *   BASE=http://localhost:3000 INTERNAL_KEY=worker-key-2026-prod node verify-hq-e2e.js
 *   BASE=https://xtt-pilot.onrender.com INTERNAL_KEY=worker-key-2026-prod node verify-hq-e2e.js
 *
 * 覆盖：
 *   1) /api/hq/auth/issue-magic 签发 magic-link
 *   2) /api/hq/auth/magic-login 兑换 session
 *   3) /api/hq/dashboard 拉首屏
 *   4) /api/hq/shops/:shopId/missing-skus 拉门店明细
 *   5) /api/hq/tasks/assign 派单 → 校验 source='hq_assigned'
 *   6) /v1/tasks 店长端能看到该任务且包含 source
 *   7) replay：同一 magic-link 再次 login 应被 jti 拦截
 *   8) 静态资源：/csnc/index.html、/xq/index.html、/txp/index.html 存在
 */

const BASE = process.env.BASE || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'worker-key-2026-prod';
const BRAND = process.env.BRAND || 'csnc';
const SHOP_ID = process.env.SHOP_ID || '1262004557';

async function call(method, path, { body, headers = {} } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}

function step(n, name) { console.log(`\n[${n}] ${name}`); }
function ok(msg) { console.log('  OK', msg); }
function fail(msg) { console.error('  FAIL', msg); process.exitCode = 1; }

(async () => {
  console.log(`>>> HQ E2E verification | BASE=${BASE} | brand=${BRAND} | shop=${SHOP_ID}`);

  // 1
  step(1, 'POST /api/hq/auth/issue-magic');
  const r1 = await call('POST', '/api/hq/auth/issue-magic', { body: { brand: BRAND, userId: 'e2e' } });
  if (r1.status === 200 && r1.json.ok && r1.json.token) ok(`token=${r1.json.token.slice(0, 24)}... link=${r1.json.link}`);
  else { fail(`status=${r1.status} body=${JSON.stringify(r1.json)}`); return; }
  const magicToken = r1.json.token;

  // 2
  step(2, 'POST /api/hq/auth/magic-login');
  const r2 = await call('POST', '/api/hq/auth/magic-login', { body: { token: magicToken } });
  if (r2.status === 200 && r2.json.ok && r2.json.sessionToken) ok(`session=${r2.json.sessionToken.slice(0, 24)}... brand=${r2.json.brand}`);
  else { fail(`status=${r2.status} body=${JSON.stringify(r2.json)}`); return; }
  const session = r2.json.sessionToken;

  // 3
  step(3, 'GET /api/hq/dashboard');
  const r3 = await call('GET', '/api/hq/dashboard', { headers: { 'x-hq-token': session } });
  if (r3.status === 200 && r3.json.ok && Array.isArray(r3.json.shops)) ok(`shops=${r3.json.shops.length} summary.missing_sku=${r3.json.summary.missing_sku}`);
  else fail(`status=${r3.status} body=${JSON.stringify(r3.json).slice(0, 200)}`);

  // 4
  step(4, `GET /api/hq/shops/${SHOP_ID}/missing-skus`);
  const r4 = await call('GET', `/api/hq/shops/${SHOP_ID}/missing-skus`, { headers: { 'x-hq-token': session } });
  if (r4.status === 200 && r4.json.ok) ok(`items=${r4.json.items?.length || 0}`);
  else fail(`status=${r4.status} body=${JSON.stringify(r4.json).slice(0, 200)}`);

  // 5
  step(5, 'POST /api/hq/tasks/assign (1 任务)');
  const testBc = `E2E-${Date.now()}`;
  const r5 = await call('POST', '/api/hq/tasks/assign', {
    headers: { 'x-hq-token': session },
    body: {
      items: [{
        shop_id: SHOP_ID,
        barcode: testBc,
        item_name: 'E2E 测试商品',
        yesterday_sales: 5,
        suggest_price: 9.9,
        priority: 'P1',
      }],
    },
  });
  if (r5.status === 200 && r5.json.ok && r5.json.created_cnt === 1) ok(`task_id=${r5.json.created[0].task_id}`);
  else fail(`status=${r5.status} body=${JSON.stringify(r5.json).slice(0, 300)}`);
  const newTaskId = r5.json?.created?.[0]?.task_id;

  // 6 store-end
  step(6, 'GET /v1/tasks (店长端，新任务应含 source=hq_assigned)');
  const auth6 = await call('POST', '/v1/auth/issue', { body: { storeId: SHOP_ID, dingId: 'e2e' } });
  if (!auth6.json?.token) fail(`无法签发店长 token: ${JSON.stringify(auth6.json)}`);
  else {
    const r6 = await call('GET', '/v1/tasks', { headers: { 'x-mvp-token': auth6.json.token } });
    const hq = r6.json?.tasks?.find(t => t.id === newTaskId || t.barcode === testBc);
    if (hq && hq.source === 'hq_assigned') ok(`找到 HQ 任务 source=${hq.source} 排第${r6.json.tasks.findIndex(t => t === hq) + 1}/${r6.json.tasks.length}`);
    else fail(`未找到 HQ 任务或 source 不对: ${JSON.stringify(hq)}`);
  }

  // 7 replay
  step(7, '重放 magic-link（应被 jti 拒绝）');
  const r7 = await call('POST', '/api/hq/auth/magic-login', { body: { token: magicToken } });
  if (r7.status === 401) ok(`replay blocked: ${r7.json.err}`);
  else fail(`未拦截重放: status=${r7.status} body=${JSON.stringify(r7.json)}`);

  // 8 static
  step(8, 'GET /:brand/ 静态首页（dist 部署校验）');
  for (const b of ['csnc', 'xq', 'txp']) {
    const r = await fetch(`${BASE}/${b}/`);
    const html = await r.text();
    if (r.status === 200 && /id=\"?root\"?/.test(html)) ok(`/${b}/ -> 200, contains root`);
    else fail(`/${b}/ -> status=${r.status}, len=${html.length}`);
  }

  console.log('\n>>> DONE');
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
