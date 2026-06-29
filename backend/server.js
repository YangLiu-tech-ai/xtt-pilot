/**
 * 新通途 MVP · Express 后端
 *
 * 8 个 v1 接口（前向兼容方案 A 契约）：
 *   GET  /v1/health
 *   POST /v1/auth/issue        - 内部签发 token（仅本机）
 *   GET  /v1/tasks             - 课长拉取自己门店缺货清单
 *   GET  /v1/tasks/:id         - 单任务详情 + 替代品池
 *   POST /v1/tasks/:id/act     - 课长一键操作 (shelf/shortage/substitute)
 *   GET  /v1/tasks/:id/status  - 反查执行状态
 *   POST /v1/internal/worker/claim   - Worker 拉取 PENDING
 *   POST /v1/internal/worker/report  - Worker 回写结果
 */
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const db = require('./db');
const { issue, verify } = require('./token');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const PORT = process.env.PORT || 7788;
const INTERNAL_KEY = process.env.MVP_INTERNAL_KEY || 'worker-key-2026';

// ============ Helper ============
function authMiddleware(req, res, next) {
  const token = req.query.token || req.headers['x-mvp-token'];
  const claim = verify(token);
  if (!claim) return res.status(401).json({ ok: false, err: 'INVALID_TOKEN' });
  req.user = claim;
  next();
}
function internalOnly(req, res, next) {
  if (req.headers['x-internal-key'] !== INTERNAL_KEY) {
    return res.status(403).json({ ok: false, err: 'FORBIDDEN' });
  }
  next();
}
function logEvent(taskId, event, detail) {
  db.prepare(`INSERT INTO task_logs (task_id, event, detail) VALUES (?, ?, ?)`)
    .run([taskId, event, typeof detail === 'string' ? detail : JSON.stringify(detail)]);
}

// ============ Routes ============
app.get('/v1/health', (req, res) => {
  const stats = db.prepare(`
    SELECT status, COUNT(*) as n FROM tasks GROUP BY status
  `).all();
  res.json({ ok: true, ts: Date.now(), version: 'v3.1-ui', stats });
});

// 仅本机调试用：签发 token
app.post('/v1/auth/issue', (req, res) => {
  const { storeId, dingId } = req.body || {};
  if (!storeId) return res.status(400).json({ ok: false, err: 'storeId required' });
  const token = issue({ storeId, dingId: dingId || '' });
  res.json({ ok: true, token, expIn: '72h' });
});

// 课长拉缺货清单
app.get('/v1/tasks', authMiddleware, (req, res) => {
  const { storeId } = req.user;
  const tasks = db.prepare(`
    SELECT id, sku, barcode, item_name, category, priority,
           suggest_price, image_url, yesterday_sales, stock,
           monthly_sales, current_price, activity_price,
           status, action, store_name, created_at,
           source, assigned_by, assigned_at
    FROM tasks
    WHERE store_id = ? AND status NOT IN ('VERIFIED')
      AND (status = 'PENDING' OR action IS NOT NULL)
    ORDER BY
      CASE WHEN source = 'hq_assigned' THEN 0 ELSE 1 END,
      CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
      monthly_sales DESC,
      created_at
  `).all([storeId]);
  res.json({ ok: true, store: storeId, tasks });
});

// 单任务详情 + 替代品
app.get('/v1/tasks/:id', authMiddleware, (req, res) => {
  const task = db.prepare(`SELECT * FROM tasks WHERE id=? AND store_id=?`)
    .get([req.params.id, req.user.storeId]);
  if (!task) return res.status(404).json({ ok: false, err: 'NOT_FOUND' });
  const subs = db.prepare(`
    SELECT sub_sku, sub_name, sub_price, sub_stock, score
    FROM substitutes WHERE original_sku=? AND store_id=?
    ORDER BY score DESC LIMIT 3
  `).all([task.sku, task.store_id]);
  res.json({ ok: true, task, substitutes: subs });
});

// 一键操作
app.post('/v1/tasks/:id/act', authMiddleware, (req, res) => {
  const { action, substituteSku, actualPrice } = req.body || {};
  if (!['shelf', 'shortage', 'substitute'].includes(action)) {
    return res.status(400).json({ ok: false, err: 'bad action' });
  }
  const task = db.prepare(`SELECT * FROM tasks WHERE id=? AND store_id=?`)
    .get([req.params.id, req.user.storeId]);
  if (!task) return res.status(404).json({ ok: false, err: 'NOT_FOUND' });
  if (task.status !== 'PENDING') {
    return res.status(409).json({ ok: false, err: 'STATE_CONFLICT', current: task.status });
  }

  // 状态机：PENDING -> EXECUTING（shelf/substitute） or SHORTAGE
  const nextStatus = action === 'shortage' ? 'SHORTAGE' : 'EXECUTING';
  db.prepare(`
    UPDATE tasks
    SET action=?, status=?, operator=?, actual_price=?, substitute_sku=?,
        acted_at=datetime('now','+8 hours'), updated_at=datetime('now','+8 hours')
    WHERE id=?
  `).run([action, nextStatus, req.user.dingId || 'unknown',
         actualPrice || task.suggest_price,
         substituteSku || null,
         task.id]);

  logEvent(task.id, 'clicked', { action, operator: req.user.dingId, substituteSku, actualPrice });
  res.json({ ok: true, taskId: task.id, status: nextStatus });
});

// 课长查执行状态
app.get('/v1/tasks/:id/status', authMiddleware, (req, res) => {
  const task = db.prepare(`SELECT id,status,action,error_msg,retry_count,updated_at FROM tasks WHERE id=? AND store_id=?`)
    .get([req.params.id, req.user.storeId]);
  if (!task) return res.status(404).json({ ok: false, err: 'NOT_FOUND' });
  res.json({ ok: true, task });
});

// ============ Worker 内部 API ============
app.post('/v1/internal/worker/claim', internalOnly, (req, res) => {
  // 拿一批 EXECUTING 状态 + retry_count < 3 的任务
  const rows = db.prepare(`
    SELECT id, store_id, sku, barcode, item_name, action, substitute_sku, actual_price, retry_count
    FROM tasks
    WHERE status='EXECUTING' AND retry_count < 3
    ORDER BY updated_at LIMIT 20
  `).all();
  res.json({ ok: true, tasks: rows });
});

app.post('/v1/internal/worker/report', internalOnly, (req, res) => {
  const { taskId, success, errorMsg } = req.body || {};
  const task = db.prepare(`SELECT * FROM tasks WHERE id=?`).get([taskId]);
  if (!task) return res.status(404).json({ ok: false, err: 'NOT_FOUND' });

  if (success) {
    db.prepare(`UPDATE tasks SET status='DONE', error_msg=NULL,
      updated_at=datetime('now','+8 hours') WHERE id=?`).run([taskId]);
    logEvent(taskId, 'done', { success });
    return res.json({ ok: true, next: 'DONE' });
  }

  // 失败：累加 retry_count
  const retry = task.retry_count + 1;
  if (retry >= 3) {
    db.prepare(`UPDATE tasks SET status='FAILED', retry_count=?, error_msg=?,
      updated_at=datetime('now','+8 hours') WHERE id=?`).run([retry, errorMsg || 'unknown', taskId]);
    logEvent(taskId, 'escalated', { retry, errorMsg });
    // 把课长信息一并返回，避免 worker 二次访问 DB（WASM 不支持多进程）
    const store = db.prepare(`SELECT store_id, store_name, manager_name, manager_dingtalk_id
      FROM stores WHERE store_id=?`).get([task.store_id]);
    return res.json({
      ok: true, next: 'FAILED', needsEscalate: true,
      escalateInfo: {
        taskId: task.id, sku: task.sku, item_name: task.item_name,
        store_id: task.store_id,
        store_name: store?.store_name || task.store_id,
        manager_name: store?.manager_name || null,
        manager_dingtalk_id: store?.manager_dingtalk_id || null,
        errorMsg: errorMsg || 'unknown',
      },
    });
  } else {
    // 回到 EXECUTING 等下轮
    db.prepare(`UPDATE tasks SET retry_count=?, error_msg=?, status='EXECUTING',
      updated_at=datetime('now','+8 hours') WHERE id=?`).run([retry, errorMsg || '', taskId]);
    logEvent(taskId, 'retry', { retry, errorMsg });
    return res.json({ ok: true, next: 'EXECUTING', retry });
  }
});

// ============ Admin: force status (for testing/worker trigger) ============
app.post('/v1/internal/force-status', internalOnly, (req, res) => {
  const { taskId, status, actualPrice } = req.body || {};
  if (!taskId || !status) return res.status(400).json({ ok: false, err: 'taskId, status required' });
  const allowed = ['PENDING', 'EXECUTING', 'DONE', 'FAILED', 'SHORTAGE'];
  if (!allowed.includes(status)) return res.status(400).json({ ok: false, err: `status must be one of: ${allowed}` });
  const task = db.prepare('SELECT id FROM tasks WHERE id=?').get([taskId]);
  if (!task) return res.status(404).json({ ok: false, err: 'NOT_FOUND' });
  const updates = [`status='${status}'`, `updated_at=datetime('now','+8 hours')`];
  if (actualPrice) updates.push(`actual_price=${Number(actualPrice)}`);
  db.prepare(`UPDATE tasks SET ${updates.join(',')} WHERE id=?`).run([taskId]);
  res.json({ ok: true, taskId, status });
});

// ============ 清理脏 PENDING（category 为空，按 storeId） ============
app.post('/v1/internal/cleanup-pending', internalOnly, (req, res) => {
  const { storeId, where } = req.body || {};
  if (!storeId) return res.status(400).json({ ok: false, err: 'storeId required' });
  // 默认只清 category 为空的 PENDING；where=all 时清所有 PENDING
  const sql = where === 'all'
    ? `DELETE FROM tasks WHERE store_id=? AND status='PENDING'`
    : `DELETE FROM tasks WHERE store_id=? AND status='PENDING' AND (category IS NULL OR category='')`;
  const r = db.prepare(sql).run([storeId]);
  console.log(`[cleanup-pending] store=${storeId} where=${where||'empty-category'} deleted=${r.changes}`);
  res.json({ ok: true, storeId, deleted: r.changes });
});

// ============ Kunlun 实时同步 API ============
app.post('/v1/internal/sync-tasks', internalOnly, (req, res) => {
  const { batchId, storeId, storeName, items } = req.body || {};
  if (!batchId || !storeId || !Array.isArray(items)) {
    return res.status(400).json({ ok: false, err: 'batchId, storeId, items[] required' });
  }

  // 幂等：清除同一 batch 的旧 PENDING（不动 EXECUTING/DONE 等已推进状态）
  const deleted = db.prepare(
    `DELETE FROM tasks WHERE batch_id=? AND store_id=? AND status='PENDING'`
  ).run([batchId, storeId]);

  // 确保门店存在
  const storeExists = db.prepare('SELECT 1 FROM stores WHERE store_id=?').get([storeId]);
  if (!storeExists) {
    db.prepare(`INSERT INTO stores (store_id, store_name, brand, is_pilot)
      VALUES (?, ?, ?, 1)`).run([storeId, storeName || storeId, storeName || storeId]);
  }

  // 批量插入
  const ins = db.prepare(`INSERT INTO tasks
    (batch_id, store_id, store_name, sku, barcode, item_name, category,
     priority, suggest_price, image_url, yesterday_sales, stock,
     monthly_sales, current_price, activity_price, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING')`);

  let created = 0;
  for (const it of items) {
    ins.run([
      batchId, storeId, storeName || storeId,
      it.sku || it.itemId || `SKU-${it.barcode}`,
      it.barcode || '',
      it.itemName || it.item_name || '未知商品',
      it.category || it.cateName1 || '',
      it.priority || 'P1',
      it.price || it.suggest_price || 0,
      it.imageUrl || it.image_url || it.picUrl || null,
      it.yesterdaySales || it.yesterday_sales || 0,
      it.stock || it.quantity || 0,
      it.monthlySales || it.monthly_sales || 0,
      it.currentPrice || it.current_price || it.price || 0,
      it.activityPrice || it.activity_price || null,
    ]);
    created++;
  }

  console.log(`[sync-tasks] batch=${batchId} store=${storeId} deleted=${deleted.changes} created=${created}`);
  res.json({ ok: true, batchId, storeId, deleted: deleted.changes, created });
});

// ============ HQ 总部端路由 ============
try {
  const hqRoutes = require('./hq-routes');
  hqRoutes.mount(app, db);
} catch (e) {
  console.warn('[server] hq-routes not mounted:', e.message);
}

// ============ 静态文件: 店长端 H5 + 三品牌 HQ H5 ============
const path = require('path');
const fs = require('fs');
app.use('/h5', express.static(path.join(__dirname, '..', 'h5')));

// HQ 三品牌：dist/csnc dist/xq dist/txp（hq-h5 build:all 产物）
const HQ_H5_DIST = path.join(__dirname, '..', 'hq-h5', 'dist');
['csnc', 'xq', 'txp'].forEach((brand) => {
  const dir = path.join(HQ_H5_DIST, brand);
  if (fs.existsSync(dir)) {
    app.use(`/${brand}`, express.static(dir));
    // SPA fallback: react-router 刷新不出现 404
    app.get(`/${brand}/*`, (req, res, next) => {
      const idx = path.join(dir, 'index.html');
      if (fs.existsSync(idx)) return res.sendFile(idx);
      next();
    });
    console.log(`[server] hq-h5 mounted: /${brand} -> ${dir}`);
  } else {
    console.warn(`[server] hq-h5 dist missing: ${dir} (run hq-h5/npm run build:${brand})`);
  }
});

// 根路径跳转到 H5 (localtunnel bypass 后会重定向到 /)
app.get('/', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect('/h5/preview.html' + qs);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[mvp-backend] listening on http://0.0.0.0:${PORT}`);
  console.log(`[mvp-backend] health: http://localhost:${PORT}/v1/health`);
  console.log(`[mvp-backend] H5: http://localhost:${PORT}/h5/preview.html`);
  // 打印内网地址方便 pilot
  const nets = require('os').networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) {
        console.log(`[mvp-backend] LAN: http://${cfg.address}:${PORT}/h5/preview.html`);
      }
    }
  }
});
