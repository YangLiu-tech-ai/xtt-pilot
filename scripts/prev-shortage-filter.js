#!/usr/bin/env node
/**
 * prev-shortage-filter.js
 * ----------------------------------------------------------------
 * 分小时推送去重：排除上一时段店长已经"选择线下缺货"（SHORTAGE）
 * 且当前仍然缺货、无需再次提醒的商品。
 *
 * 判定口径（与用户对齐 2026-07-09）：
 *   - 上一时段 status = SHORTAGE  → 视为"已反馈"，本轮排除
 *   - 上一时段 status = DONE      → 已成功上架；若本轮 unattended 又捞到
 *                                    该 barcode，说明"上架后又下架"，
 *                                    继续推送，不排除
 *   - 其它状态（PENDING/EXECUTING/FAILED/ARCHIVED）→ 不排除，继续推送
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
 *
 * batchId 形如 "202607091340"（YYYYMMDDHHmm），字符串比较即时间比较；
 * 只考虑本轮之前的记录，对每个 barcode 取 created_at 最新的一条。
 * status === 'SHORTAGE' 视为已反馈，加入排除集。
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

  const latestByBarcode = new Map();
  for (const t of tasks) {
    const bc = normalizeBarcode(t.barcode);
    if (!bc) continue;
    const tBatch = t.batch_id || '';
    // 只考虑本轮之前的批次
    if (currentBatchId && tBatch && tBatch >= currentBatchId) continue;

    const createdAt = t.created_at || '';
    const prev = latestByBarcode.get(bc);
    if (!prev || createdAt > (prev.created_at || '')) {
      latestByBarcode.set(bc, t);
    }
  }

  let shortageCount = 0;
  for (const [bc, t] of latestByBarcode.entries()) {
    if (t.status === 'SHORTAGE') {
      excluded.add(bc);
      shortageCount++;
    }
  }
  logger.log(
    '[prev-shortage-filter] storeId=' +
      storeId +
      ' 上一时段 SHORTAGE 反馈 ' +
      shortageCount +
      ' 条，将被本轮排除'
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
        excludedBy: 'SHORTAGE',
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
