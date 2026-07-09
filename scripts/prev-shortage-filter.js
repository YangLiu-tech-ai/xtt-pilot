#!/usr/bin/env node
/**
 * prev-shortage-filter.js
 * ----------------------------------------------------------------
 * 分小时推送去重：排除今天店长在 H5 已经"处理过"的商品。
 *
 * 判定口径（与用户对齐 2026-07-09 二次澄清）：
 *   - 今天该 barcode 存在任一记录 action != null（店长点过 H5 按钮，
 *     无论 shortage/shelf/substitute）→ 视为"已处理"，本轮排除
 *   - action = null（今天从未在 H5 点过按钮）→ 继续推送
 *
 * 说明：sync-tasks 会把上一轮未处理的 PENDING 归档为 ARCHIVED；
 *   ARCHIVED + action=null 表示店长在上一轮完全没响应 → 本轮继续推
 *   ARCHIVED + action=shortage/shelf/substitute → 店长已处理 → 本轮排除
 *   SHORTAGE / DONE / FAILED 等推进状态一律带 action，都会命中排除。
 *
 * 数据源（authoritative）：
 *   GET {API}/v1/internal/report/tasks-by-store?storeId=&date=YYYY-MM-DD
 *   Header: x-internal-key: {INTERNAL_KEY}
 *
 * 本地 JSON 快照（审计用，仅落盘不作为下轮判定源）：
 *   scripts/state/last-push-{storeId}.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const STATE_DIR = path.join(__dirname, 'state');

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

// 与 cron-push-v2.js 保持一致：去前导 0 + trim
function normalizeBarcode(bc) {
  if (!bc) return '';
  return String(bc).replace(/^0+/, '').trim();
}

function getJSON(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: 'GET',
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers,
        timeout: 30000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            reject(new Error('Non-JSON response: ' + buf.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.end();
  });
}

/**
 * 拉取当天该门店的历史任务，返回"应本轮排除"的 barcode 集合。
 * 判定：只要今天任意一条记录 action != null，该 barcode 就加入排除集。
 * 排除同一 barcode 在本轮及之后批次(currentBatchId)已经产生的记录。
 */
async function loadFeedbackedBarcodes({
  apiBase,
  internalKey,
  storeId,
  dateStr,
  currentBatchId,
  logger = console,
}) {
  const excluded = new Set();
  if (!apiBase || !storeId || !dateStr) {
    logger.warn('[prev-shortage-filter] 参数缺失，跳过过滤');
    return excluded;
  }
  const url =
    apiBase +
    '/v1/internal/report/tasks-by-store?storeId=' +
    encodeURIComponent(storeId) +
    '&date=' +
    encodeURIComponent(dateStr);
  let data;
  try {
    data = await getJSON(url, { 'x-internal-key': internalKey || '' });
  } catch (e) {
    logger.warn('[prev-shortage-filter] Render 拉历史失败(非致命): ' + e.message);
    return excluded;
  }
  const tasks = (data && data.tasks) || [];
  if (!tasks.length) {
    logger.log('[prev-shortage-filter] 当天暂无历史任务');
    return excluded;
  }

  const actionBreakdown = { shortage: 0, shelf: 0, substitute: 0, other: 0 };
  for (const t of tasks) {
    const bc = normalizeBarcode(t.barcode);
    if (!bc) continue;
    const tBatch = t.batch_id || '';
    // 跳过本轮及之后的批次（本轮 sync-tasks 还没执行时理应为空，冗余保护）
    if (currentBatchId && tBatch && tBatch >= currentBatchId) continue;

    if (t.action) {
      if (!excluded.has(bc)) {
        excluded.add(bc);
        if (t.action === 'shortage') actionBreakdown.shortage++;
        else if (t.action === 'shelf') actionBreakdown.shelf++;
        else if (t.action === 'substitute') actionBreakdown.substitute++;
        else actionBreakdown.other++;
      }
    }
  }

  logger.log(
    '[prev-shortage-filter] storeId=' +
      storeId +
      ' 今日已处理 ' +
      excluded.size +
      ' 条 (shortage=' +
      actionBreakdown.shortage +
      ' shelf=' +
      actionBreakdown.shelf +
      ' substitute=' +
      actionBreakdown.substitute +
      ' other=' +
      actionBreakdown.other +
      ')，将被本轮排除'
  );
  return excluded;
}

function saveLastPush({ storeId, storeName, batchId, kept, filteredOut }) {
  try {
    ensureStateDir();
    const outPath = path.join(STATE_DIR, 'last-push-' + storeId + '.json');
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const snapshot = {
      storeId,
      storeName: storeName || '',
      pushedAt: now.toISOString().replace('Z', '+08:00'),
      batchId: batchId || '',
      keptCount: (kept || []).length,
      filteredOutCount: (filteredOut || []).length,
      kept: (kept || []).map((u) => ({
        barcode: u.barcode,
        itemName: u.itemName,
        reason: u.reason,
      })),
      filteredOut: (filteredOut || []).map((u) => ({
        barcode: u.barcode,
        itemName: u.itemName,
        reason: u.reason,
        excludedBy: u.excludedBy || 'H5_ACTION',
      })),
    };
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');
    return outPath;
  } catch (e) {
    console.warn('[prev-shortage-filter] 快照落盘失败(非致命): ' + e.message);
    return null;
  }
}

module.exports = {
  loadFeedbackedBarcodes,
  saveLastPush,
  normalizeBarcode,
};
