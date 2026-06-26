/**
 * 本地 Worker · 5min 轮询 EXECUTING 任务
 *
 * 当前 MVP 阶段：执行逻辑用「模拟」占位（80% 成功 / 20% 失败）
 * 真正接入 whale-batch-shelf-upload 在 D2 完成，已留好对接点：executeOnWhale()
 *
 * 失败累计 3 次 → 调 notifier.escalateToManager() @ 课长
 */
const http = require('http');
// 不直接连 DB：node-sqlite3-wasm 不支持多进程，store 信息由 server 的 report 接口随 escalateInfo 返回
const { escalateToManager } = require('../backend/notifier');
const { executeOnWhale, MODE: WHALE_MODE, BATCH_DIR } = require('../backend/whaleAdapter');

const API = process.env.MVP_API || 'http://localhost:7788';
const INTERNAL_KEY = process.env.MVP_INTERNAL_KEY || 'worker-key-2026';
const INTERVAL_MS = parseInt(process.env.WORKER_INTERVAL || '15000', 10);

function call(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API + path);
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname,
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
    const r = await executeOnWhale(t);
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
      const tag = r.mode === 'dry' && r.batchFile
        ? `✅ DONE [dry → ${r.batchFile.replace(/^.*[\\/]whale-batches/, 'whale-batches')}]`
        : `✅ DONE [${r.mode || 'ok'}]`;
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
