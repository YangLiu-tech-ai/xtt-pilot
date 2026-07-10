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
           source, assigned_by, assigned_at,
           shortage_reason, shortage_reason_detail
    FROM tasks
    WHERE store_id = ? AND status NOT IN ('VERIFIED', 'ARCHIVED')
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
  const { action, substituteSku, actualPrice, shortageReason, shortageReasonDetail } = req.body || {};
  if (!['shelf', 'shortage', 'substitute'].includes(action)) {
    return res.status(400).json({ ok: false, err: 'bad action' });
  }
  // shortage 必须带 reason (1-6)
  let reasonCode = null, reasonDetail = null;
  if (action === 'shortage') {
    reasonCode = Number(shortageReason);
    if (!Number.isInteger(reasonCode) || reasonCode < 1 || reasonCode > 6) {
      return res.status(400).json({ ok: false, err: 'SHORTAGE_REASON_REQUIRED' });
    }
    if (shortageReasonDetail) {
      reasonDetail = String(shortageReasonDetail).slice(0, 200);
    }
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
        shortage_reason=?, shortage_reason_detail=?,
        acted_at=datetime('now','+8 hours'), updated_at=datetime('now','+8 hours')
    WHERE id=?
  `).run([action, nextStatus, req.user.dingId || 'unknown',
         actualPrice || task.suggest_price,
         substituteSku || null,
         reasonCode, reasonDetail,
         task.id]);

  logEvent(task.id, 'clicked', { action, operator: req.user.dingId, substituteSku, actualPrice, shortageReason: reasonCode, shortageReasonDetail: reasonDetail });
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
  // 乐观锁：先原子性标记一批任务为 claimed，再返回
  // 防止并发 worker claim 到同一批任务导致重复执行
  // 可选 credentialKey：只 claim 指定租户的任务（浏览器半自动 worker 按当前会话租户拉取，
  //   避免跨租户任务挤占 20 条名额）
  const { credentialKey } = req.body || {};
  const now = new Date().toISOString();
  const credFilter = credentialKey ? `AND credential_key = ?` : ``;
  const stmt = db.prepare(`
    UPDATE tasks SET updated_at=?
    WHERE id IN (
      SELECT id FROM tasks
      WHERE status='EXECUTING' AND retry_count < 3 ${credFilter}
      ORDER BY updated_at LIMIT 20
    )
    RETURNING id, store_id, sku, barcode, item_name, action, substitute_sku, actual_price, retry_count,
              whale_shop_id, credential_key, stock
  `);
  const claimed = credentialKey ? stmt.all(now, credentialKey) : stmt.all(now);
  res.json({ ok: true, tasks: claimed });
});

app.post('/v1/internal/worker/report', internalOnly, (req, res) => {
  const { taskId, success, errorMsg, operationType } = req.body || {};
  const task = db.prepare(`SELECT * FROM tasks WHERE id=?`).get([taskId]);
  if (!task) return res.status(404).json({ ok: false, err: 'NOT_FOUND' });

  // 幂等保护：
  //   成功报告：允许覆盖 EXECUTING 或 FAILED（失败重试后成功仍能正确转为 DONE）
  //   失败报告：仅接受 EXECUTING，避免 retry_count 被重复累加
  if (success) {
    if (!['EXECUTING', 'FAILED'].includes(task.status)) {
      return res.json({ ok: true, next: task.status, skipped: true, reason: `task already ${task.status}` });
    }
    const prev = task.status;
    const result = db.prepare(`UPDATE tasks SET status='DONE', error_msg=NULL, retry_count=0,
      operation_type=?,
      updated_at=datetime('now','+8 hours') WHERE id=? AND status IN ('EXECUTING','FAILED')`).run([operationType || 'operated', taskId]);
    if (result.changes === 0) {
      return res.json({ ok: true, next: task.status, skipped: true, reason: 'no state change (race)' });
    }
    logEvent(taskId, 'done', { success, operationType: operationType || 'operated', prevStatus: prev, overwrote: prev === 'FAILED' });
    return res.json({ ok: true, next: 'DONE', overwrote: prev === 'FAILED' });
  }

  if (task.status !== 'EXECUTING') {
    return res.json({ ok: true, next: task.status, skipped: true, reason: `task already ${task.status}` });
  }

  // 失败：累加 retry_count（仅当状态仍为 EXECUTING 时）
  const retry = task.retry_count + 1;
  if (retry >= 3) {
    db.prepare(`UPDATE tasks SET status='FAILED', retry_count=?, error_msg=?,
      updated_at=datetime('now','+8 hours') WHERE id=? AND status='EXECUTING'`).run([retry, errorMsg || 'unknown', taskId]);
    logEvent(taskId, 'escalated', { retry, errorMsg });
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
    db.prepare(`UPDATE tasks SET retry_count=?, error_msg=?, status='EXECUTING',
      updated_at=datetime('now','+8 hours') WHERE id=? AND status='EXECUTING'`).run([retry, errorMsg || '', taskId]);
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
  if (status === 'EXECUTING') updates.push('retry_count=0');
  if (actualPrice) updates.push(`actual_price=${Number(actualPrice)}`);
  db.prepare(`UPDATE tasks SET ${updates.join(',')} WHERE id=?`).run([taskId]);
  res.json({ ok: true, taskId, status });
});

// ============ 归档脏 PENDING（category 为空，按 storeId） ============
// v2026.07.09: DELETE → ARCHIVE，保留历史数据供日报统计
app.post('/v1/internal/cleanup-pending', internalOnly, (req, res) => {
  const { storeId, where } = req.body || {};
  if (!storeId) return res.status(400).json({ ok: false, err: 'storeId required' });
  // 默认只归档 category 为空的 PENDING；where=all 时归档所有 PENDING
  const sql = where === 'all'
    ? `UPDATE tasks SET status='ARCHIVED', updated_at=datetime('now','+8 hours') WHERE store_id=? AND status='PENDING'`
    : `UPDATE tasks SET status='ARCHIVED', updated_at=datetime('now','+8 hours') WHERE store_id=? AND status='PENDING' AND (category IS NULL OR category='')`;
  const r = db.prepare(sql).run([storeId]);
  console.log(`[cleanup-pending] store=${storeId} where=${where||'empty-category'} archived=${r.changes}`);
  res.json({ ok: true, storeId, archived: r.changes });
});

// ============ Kunlun 实时同步 API ============
app.post('/v1/internal/sync-tasks', internalOnly, (req, res) => {
  const { batchId, storeId, storeName, items, whaleShopId, credentialKey } = req.body || {};
  if (!batchId || !storeId || !Array.isArray(items)) {
    return res.status(400).json({ ok: false, err: 'batchId, storeId, items[] required' });
  }

  // 归档该门店旧批次的 PENDING（含旧 batch），保留数据供日报统计
  // 不动 EXECUTING/DONE/SHORTAGE 等已推进状态，店长正在操作中的任务不受影响
  // ARCHIVED 任务对 /v1/tasks（课长视图）和 worker/claim 不可见，仅在 report 接口可见
  const archived = db.prepare(
    `UPDATE tasks SET status='ARCHIVED', updated_at=datetime('now','+8 hours')
     WHERE store_id=? AND status='PENDING'`
  ).run([storeId]);

  // 确保门店存在
  const storeExists = db.prepare('SELECT 1 FROM stores WHERE store_id=?').get([storeId]);
  if (!storeExists) {
    db.prepare(`INSERT INTO stores (store_id, store_name, brand, is_pilot)
      VALUES (?, ?, ?, 1)`).run([storeId, storeName || storeId, storeName || storeId]);
  }

  // 批量插入（含鲸品云隔离字段）
  const ins = db.prepare(`INSERT INTO tasks
    (batch_id, store_id, store_name, sku, barcode, item_name, category,
     priority, suggest_price, image_url, yesterday_sales, stock,
     monthly_sales, current_price, activity_price,
     whale_shop_id, credential_key, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING')`);

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
      whaleShopId || null,
      credentialKey || null,
    ]);
    created++;
  }

  console.log(`[sync-tasks] batch=${batchId} store=${storeId} whale=${whaleShopId||'N/A'} cred=${credentialKey||'N/A'} archived=${archived.changes} created=${created}`);
  res.json({ ok: true, batchId, storeId, archived: archived.changes, created });
});

// ============ 只读审计 API（门店操作记录查询） ============

// 计算某日在北京时区的 [YYYY-MM-DD 00:00:00, YYYY-MM-DD 24:00:00) 范围
// 数据库 created_at/acted_at/updated_at 存的是 +8 时区字符串，直接字符串比较即可
function normalizeDate(dateStr) {
  if (!dateStr) {
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    return now.toISOString().slice(0, 10);
  }
  const s = String(dateStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

// 按门店 + 日期返回当天全部任务快照（含状态、动作、鲸品云字段、错误信息）
app.get('/v1/internal/report/tasks-by-store', internalOnly, (req, res) => {
  const { storeId } = req.query;
  const date = normalizeDate(req.query.date);
  if (!storeId) return res.status(400).json({ ok: false, err: 'storeId required' });
  if (!date) return res.status(400).json({ ok: false, err: 'date must be YYYY-MM-DD' });

  const start = `${date} 00:00:00`;
  const end = `${date} 23:59:59`;

  const rows = db.prepare(`
    SELECT id, batch_id, store_id, store_name, sku, barcode, item_name, category,
           priority, suggest_price, actual_price, substitute_sku,
           status, action, operator, retry_count, error_msg,
           shortage_reason, shortage_reason_detail, operation_type,
           whale_shop_id, credential_key,
           created_at, pushed_at, acted_at, updated_at
    FROM tasks
    WHERE store_id = ?
      AND (
        (created_at BETWEEN ? AND ?)
        OR (acted_at BETWEEN ? AND ?)
        OR (updated_at BETWEEN ? AND ?)
      )
    ORDER BY COALESCE(acted_at, updated_at, created_at) DESC
  `).all([storeId, start, end, start, end, start, end]);

  // 附加状态分布
  const summary = { total: rows.length };
  for (const r of rows) summary[r.status] = (summary[r.status] || 0) + 1;

  res.json({ ok: true, storeId, date, summary, tasks: rows });
});

// 按任务 ID 返回全事件流水
app.get('/v1/internal/report/task-logs/:taskId', internalOnly, (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId)) return res.status(400).json({ ok: false, err: 'taskId must be integer' });
  const task = db.prepare(`SELECT * FROM tasks WHERE id=?`).get([taskId]);
  if (!task) return res.status(404).json({ ok: false, err: 'NOT_FOUND' });
  const logs = db.prepare(`
    SELECT id, event, detail, created_at FROM task_logs WHERE task_id=? ORDER BY id
  `).all([taskId]);
  res.json({ ok: true, task, logs: logs.map(l => ({ ...l, detail: safeJson(l.detail) })) });
});

function safeJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
}

// 按品牌 credential_key + 日期出日报聚合（跨门店汇总）
app.get('/v1/internal/report/daily-summary', internalOnly, (req, res) => {
  const date = normalizeDate(req.query.date);
  const credKey = req.query.credentialKey || null;
  if (!date) return res.status(400).json({ ok: false, err: 'date must be YYYY-MM-DD' });

  const start = `${date} 00:00:00`;
  const end = `${date} 23:59:59`;

  const where = [`(created_at BETWEEN ? AND ? OR acted_at BETWEEN ? AND ? OR updated_at BETWEEN ? AND ?)`];
  const params = [start, end, start, end, start, end];
  if (credKey) { where.push(`credential_key = ?`); params.push(credKey); }

  // 按门店 x 状态聚合
  const byStore = db.prepare(`
    SELECT store_id, store_name, whale_shop_id, credential_key,
           status, action, COUNT(*) as n
    FROM tasks
    WHERE ${where.join(' AND ')}
    GROUP BY store_id, store_name, whale_shop_id, credential_key, status, action
    ORDER BY store_id
  `).all(params);

  // 按门店整理
  const storeMap = {};
  for (const r of byStore) {
    const key = r.store_id;
    if (!storeMap[key]) {
      storeMap[key] = {
        storeId: r.store_id,
        storeName: r.store_name,
        whaleShopId: r.whale_shop_id,
        credentialKey: r.credential_key,
        total: 0,
        byStatus: {},
        byAction: {},
      };
    }
    storeMap[key].total += r.n;
    storeMap[key].byStatus[r.status] = (storeMap[key].byStatus[r.status] || 0) + r.n;
    if (r.action) storeMap[key].byAction[r.action] = (storeMap[key].byAction[r.action] || 0) + r.n;
  }

  // 失败任务样例（便于排查）
  const failWhere = [...where, `status = 'FAILED'`];
  const failedSamples = db.prepare(`
    SELECT id, store_id, store_name, sku, barcode, item_name,
           whale_shop_id, credential_key, error_msg, retry_count, updated_at
    FROM tasks
    WHERE ${failWhere.join(' AND ')}
    ORDER BY updated_at DESC LIMIT 20
  `).all(params);

  res.json({
    ok: true,
    date,
    credentialKey: credKey,
    stores: Object.values(storeMap),
    failedSamples,
  });
});

// 按 batchId / storeId 拉 task_logs 事件流（join tasks 取核心字段）
// GET /v1/internal/task-logs?batchId=xxx&storeId=xxx&days=1&limit=500
app.get('/v1/internal/task-logs', internalOnly, (req, res) => {
  const { batchId, storeId } = req.query;
  const days = Math.max(1, Math.min(30, parseInt(req.query.days || '1', 10) || 1));
  const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit || '500', 10) || 500));
  if (!batchId && !storeId) {
    return res.status(400).json({ ok: false, err: 'batchId or storeId required' });
  }

  const where = [`l.created_at >= datetime('now','+8 hours','-${days} days')`];
  const params = [];
  if (batchId) { where.push(`t.batch_id = ?`); params.push(batchId); }
  if (storeId) { where.push(`t.store_id = ?`); params.push(storeId); }

  const rows = db.prepare(`
    SELECT
      l.id            AS log_id,
      l.task_id       AS task_id,
      l.event         AS event,
      l.detail        AS detail,
      l.created_at    AS event_at,
      t.batch_id      AS batch_id,
      t.store_id      AS store_id,
      t.store_name    AS store_name,
      t.barcode       AS barcode,
      t.item_name     AS item_name,
      t.sku           AS sku,
      t.status        AS status,
      t.action        AS action,
      t.operator      AS operator,
      t.shortage_reason      AS shortage_reason,
      t.shortage_reason_detail AS shortage_reason_detail,
      t.error_msg     AS error_msg,
      t.acted_at      AS acted_at,
      t.updated_at    AS updated_at
    FROM task_logs l
    LEFT JOIN tasks t ON t.id = l.task_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.id DESC
    LIMIT ${limit}
  `).all(params);

  // detail 反序列化
  const logs = rows.map(r => ({ ...r, detail: safeJson(r.detail) }));

  // 事件类型直方图
  const eventHist = {};
  for (const r of logs) eventHist[r.event] = (eventHist[r.event] || 0) + 1;

  res.json({
    ok: true,
    query: { batchId: batchId || null, storeId: storeId || null, days, limit },
    count: logs.length,
    eventHist,
    logs,
  });
});

// 白名单单表 dump（开发排查用）
// GET /v1/internal/db-dump?table=tasks&limit=200&where=status:PENDING
app.get('/v1/internal/db-dump', internalOnly, (req, res) => {
  const ALLOW = new Set(['tasks', 'task_logs', 'stores', 'hq_shops_meta', 'substitutes', 'substitute_rules']);
  const table = String(req.query.table || '').trim();
  if (!ALLOW.has(table)) {
    return res.status(400).json({ ok: false, err: 'table must be one of: ' + [...ALLOW].join(', ') });
  }
  const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '200', 10) || 200));

  // 可选 where=col:val 简单等值过滤（仅字母数字下划线列名，避免注入）
  const whereClauses = [];
  const whereParams = [];
  const rawWhere = req.query.where;
  if (rawWhere) {
    const parts = String(rawWhere).split(',');
    for (const p of parts) {
      const [col, ...rest] = p.split(':');
      const val = rest.join(':');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) continue;
      whereClauses.push(`${col} = ?`);
      whereParams.push(val);
    }
  }

  const sql = `SELECT * FROM ${table} ${whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : ''}
    ORDER BY ${table === 'task_logs' ? 'id' : (table === 'tasks' ? 'id' : 'ROWID')} DESC LIMIT ${limit}`;

  try {
    const rows = db.prepare(sql).all(whereParams);
    res.json({ ok: true, table, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ ok: false, err: e.message });
  }
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

const server = app.listen(PORT, '0.0.0.0', () => {
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

// ============ 优雅退出：重启/部署前把 WAL 落库并关闭数据库 ============
// Render 重启/部署时发送 SIGTERM。若不 checkpoint + close，WAL 中未合并的写入
// 可能在下次启动时丢失（历史数据丢失根因之一）。这里确保退出前数据安全落盘。
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mvp-backend] received ${signal}, shutting down gracefully...`);

  const finalize = () => {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      console.log('[mvp-backend] wal_checkpoint(TRUNCATE) done before exit');
    } catch (e) {
      console.warn('[mvp-backend] checkpoint on shutdown failed:', e.message);
    }
    try {
      db.close();
      console.log('[mvp-backend] database closed cleanly');
    } catch (e) {
      console.warn('[mvp-backend] db.close failed:', e.message);
    }
    process.exit(0);
  };

  // 停止接收新连接后落库退出
  server.close(finalize);
  // 兜底：若 server.close 迟迟不回调（仍有挂起连接），8s 后强制落库退出
  setTimeout(() => {
    console.warn('[mvp-backend] forced shutdown after timeout');
    finalize();
  }, 8000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
