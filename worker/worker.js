/**
 * 本地 Worker · 5min 轮询 EXECUTING 任务
 *
 * api 模式：通过鲸品云 REST API 完成上架（含库存=0自动补5）
 * dry 模式（默认）：仅记录批次 JSONL，不触达真实鲸品云
 *
 * 失败累计 3 次 → 调 notifier.escalateToManager() @ 课长
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
// 不直接连 DB：node-sqlite3-wasm 不支持多进程，store 信息由 server 的 report 接口随 escalateInfo 返回
const { escalateToManager } = require('../backend/notifier');
const { executeOnWhale, MODE: WHALE_MODE, BATCH_DIR } = require('../backend/whaleAdapter');

const API = process.env.MVP_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.MVP_INTERNAL_KEY || 'worker-key-2026-prod';
const INTERVAL_MS = parseInt(process.env.WORKER_INTERVAL || '15000', 10);

// ============ 凭证池加载 ============
const CREDS_PATH = path.join(__dirname, '..', 'scripts', 'whale-credentials.json');
let _whaleCreds = null;
function loadWhaleCreds() {
  if (_whaleCreds) return _whaleCreds;
  try {
    _whaleCreds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    console.log(`[worker] loaded whale credentials: ${Object.keys(_whaleCreds.credentials || {}).join(', ')}`);
  } catch (e) {
    console.warn(`[worker] whale-credentials.json not found or invalid: ${e.message}`);
    _whaleCreds = { credentials: {} };
  }
  return _whaleCreds;
}

function getCredentialForTask(credentialKey) {
  if (!credentialKey) return { refreshToken: null, whaleShopId: null };
  const creds = loadWhaleCreds();
  const cred = creds.credentials?.[credentialKey];
  if (!cred) return { refreshToken: null, whaleShopId: null };
  return {
    refreshToken: cred.refreshToken || null,
    whaleShopId: null, // whaleShopId comes from the task claim response
  };
}

function call(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API + path);
    const mod = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : '';
    const req = mod.request({
      method: 'POST', hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Internal-Key': INTERNAL_KEY,
      },
    }, res => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function tick() {
  const ts = new Date().toISOString();
  let { tasks = [] } = await call('/v1/internal/worker/claim', {});
  if (!tasks.length) {
    console.log(`[${ts}] worker idle`);
    return;
  }
  console.log(`[${ts}] picked ${tasks.length} tasks`);

  for (const t of tasks) {
    console.log(`  ▶ ${t.id}/${t.sku} ${t.item_name} (retry=${t.retry_count})`);

    // 加载该任务的品牌凭证（refreshToken），whaleShopId 来自任务本身
    const cred = getCredentialForTask(t.credential_key);
    const opts = {
      refreshToken: cred.refreshToken || null,
      whaleShopId: t.whale_shop_id || null,
      organizationId: t.whale_shop_id || null,
    };

    const r = await executeOnWhale(t, opts);
    const report = await call('/v1/internal/worker/report', {
      taskId: t.id, success: r.ok, errorMsg: r.error || null,
    });
    if (report.needsEscalate) {
      // 失败 3 次 → @ 课长（store/manager 信息由 server 一并返回）
      const info = report.escalateInfo || {};
      const dingId = info.manager_dingtalk_id;
      try {
        await escalateToManager({
          task: { ...t, store_name: info.store_name || t.store_id, item_name: info.item_name || t.item_name },
          reason: info.errorMsg || r.error,
          dingId,
        });
        console.log(`    ⚠️ escalated to manager dingId=${dingId || 'fallback-group'}`);
      } catch (e) {
        console.log(`    ⚠️ escalate webhook failed: ${e.message}`);
      }
    }
    if (r.ok) {
      let tag;
      if (r.mode === 'preview' && r.planFile) {
        tag = `✅ DONE [preview → ${r.planFile.replace(/^.*[\\/]whale-preview/, 'whale-preview')}]`;
      } else if (r.mode === 'dry' && r.batchFile) {
        tag = `✅ DONE [dry → ${r.batchFile.replace(/^.*[\\/]whale-batches/, 'whale-batches')}]`;
      } else {
        tag = `✅ DONE [${r.mode || 'ok'}]`;
      }
      console.log(`    ${tag} → ${report.next}`);
    } else {
      console.log(`    ❌ ${r.error} → ${report.next}`);
    }
  }
}

console.log(`[worker] starting · poll=${INTERVAL_MS}ms · whaleMode=${WHALE_MODE}`);
if (WHALE_MODE === 'dry') {
  console.log(`[worker] DRY MODE · batches will be written to: ${BATCH_DIR}`);
  console.log(`[worker] ★ 不会触达真实鲸品云。审核 JSONL → scripts/build-batch-xlsx.js → 人工上架`);
}
tick().catch(e => console.error(e));
setInterval(() => tick().catch(e => console.error(e)), INTERVAL_MS);
