#!/usr/bin/env node
/**
 * revive-token-failed.js — 把"因 token/环境问题被误挂起"的 FAILED 任务复活为 EXECUTING
 *
 * 背景：worker 现已不会把 token 过期计入挂起（见 kunlun-worker-node.js 的探活+deferred 逻辑）。
 *   但历史上（修复前）token 过期会 report(false) 累加 retry_count，3 次后转 FAILED 卡死。
 *   本脚本用 /v1/internal/force-status 把这类 FAILED 重置回 EXECUTING（retry_count 清零），
 *   下一轮 worker 即可重新认领处理。仅用现有接口，无需部署。
 *
 * 判定"token 类"：error_msg 命中 TOKEN_EXPIRED/令牌过期/timeout/Failed to fetch/未登录/无权限 等
 *   环境类关键字（可用 --all 强制复活所有 FAILED，或 --pattern 自定义正则）。
 *
 * 用法：
 *   node revive-token-failed.js                 # 预演（DRY，只列出命中项，不改状态）
 *   node revive-token-failed.js --commit         # 实际复活
 *   node revive-token-failed.js --commit --all    # 复活所有 FAILED（不限 token 类）
 *   node revive-token-failed.js --commit --pattern "查询失败|补库存"
 *   CREDENTIAL_KEY=xq-whale node revive-token-failed.js --commit  # 只复活指定品牌
 */
const https = require('https');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const RENDER = process.env.RENDER_API || 'https://xtt-pilot.onrender.com';
const KEY = process.env.INTERNAL_KEY || 'worker-key-2026-prod';
const COMMIT = process.argv.includes('--commit');
const ALL = process.argv.includes('--all');
const CRED = process.env.CREDENTIAL_KEY || null;
const pIdx = process.argv.indexOf('--pattern');
const CUSTOM = pIdx >= 0 ? process.argv[pIdx + 1] : null;

// 环境类（可恢复）错误关键字：token 过期、网络超时等，非业务失败
const TOKEN_RE = CUSTOM ? new RegExp(CUSTOM, 'i')
  : /TOKEN[_ ]?EX(P|O)IRED|令牌过期|FAIL_SYS_SESSION|未登录|无权限|ILLEGAL_ACCESS|timeout|Failed to fetch|ECONN|socket hang up|network/i;

function http(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(RENDER + path);
    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', 'x-internal-key': KEY } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on('error', reject); req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body)); req.end();
  });
}

(async () => {
  const dump = await http('GET', '/v1/internal/db-dump?table=tasks&where=status:FAILED&limit=1000');
  let failed = dump.rows || [];
  if (CRED) failed = failed.filter(t => t.credential_key === CRED);
  console.log(`[revive] FAILED 总数=${(dump.rows||[]).length}${CRED ? ` (品牌 ${CRED} 过滤后=${failed.length})` : ''}`);

  const hit = failed.filter(t => ALL || (t.error_msg && TOKEN_RE.test(String(t.error_msg))));
  console.log(`[revive] 命中${ALL ? '(--all 全部)' : '(token/环境类)'}=${hit.length}`);
  for (const t of hit) {
    console.log(`  #${t.id} store=${t.store_id} retry=${t.retry_count} err=${String(t.error_msg).slice(0, 70)}`);
  }
  if (!hit.length) { console.log('[revive] 无命中项，退出'); return; }

  if (!COMMIT) {
    console.log('\n[revive] DRY 预演（未改动）。确认无误后加 --commit 实际复活为 EXECUTING。');
    return;
  }
  let ok = 0, fail = 0;
  for (const t of hit) {
    const r = await http('POST', '/v1/internal/force-status', { taskId: t.id, status: 'EXECUTING' });
    if (r && r.ok) { ok++; } else { fail++; console.log(`  ✗ #${t.id} force-status 失败: ${JSON.stringify(r)}`); }
  }
  console.log(`[revive] 复活完成 ok=${ok} fail=${fail}（EXECUTING，retry_count 已清零，下轮 worker 会重跑）`);
})().catch(e => { console.error('[revive] fatal:', e.message); process.exit(1); });
