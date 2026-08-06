#!/usr/bin/env node
/**
 * prev-shortage-filter.js
 * ----------------------------------------------------------------
 * 分小时推送去重：排除今天店长在 H5 已经"处理过"的商品。
 *
 * 判定口径（2026-07-11 修订，从 action 改为 status）：
 *   - 今天该 barcode 存在任一记录 status ∈ {DONE, SHORTAGE, FAILED, EXECUTING}
 *     → 视为"已处理"（worker 自动上架 / 店长标记缺货 / 执行中 / 失败），本轮排除
 *   - status ∈ {PENDING, ARCHIVED} 或无 status → 未处理，继续推送
 *
 * 说明：sync-tasks 会把上一轮未处理的 PENDING 归档为 ARCHIVED；
 *   ARCHIVED 表示店长未响应且 worker 未认领 → 本轮继续推
 *   SHORTAGE = 店长标记线下缺货 → 排除
 *   DONE = worker 已上架完成（无论店长是否点过按钮）→ 排除
 *   EXECUTING = worker 正在上架 → 排除
 *   FAILED = 处理失败 → 排除
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
 * 本地备份回退：扫描 backups/YYYY-MM-DD/{storeId}_batch-*.json
 * 收集今天更早批次中出现过的所有 barcode 作为排除集（不依赖 action 字段）。
 *
 * 设计说明（2026-07-10 修复）：
 *   原逻辑只排除 action != null 的 barcode，但 action 由 Render API 回写，
 *   当 Render 不可用（免费套餐冷启动/数据库重建）时，本地备份从未被 enriched，
 *   导致去重完全失效 → 同一商品当天被反复推送。
 *
 *   修复后：只要 barcode 出现在今天更早批次的 kept 或 filteredOut 中，
 *   就视为"今天已推送/已处理过"，本轮排除。
 *   代价：店长未响应的商品也不再重复推送（每天最多推一次），
 *   但远优于"Render 一挂就全量重推"。
 */
function loadFromLocalBackups({ storeId, dateStr, logger = console }) {
  const excluded = new Set();
  const backupDir = path.join(__dirname, 'backups', dateStr);
  if (!fs.existsSync(backupDir)) return excluded;

  const prefix = `${storeId}_batch-`;
  const files = fs.readdirSync(backupDir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  if (!files.length) return excluded;

  let scanned = 0;
  for (const fname of files.sort()) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(backupDir, fname), 'utf8'));
      // 扫描 kept + filteredOut，收集所有 barcode（不依赖 action 字段）
      for (const item of [...(data.kept || []), ...(data.filteredOut || [])]) {
        const bc = normalizeBarcode(item.barcode);
        if (bc) {
          excluded.add(bc);
        }
      }
      scanned++;
    } catch (e) {
      // 单个文件损坏不阻塞
      logger.warn('[prev-shortage-filter] 本地备份读取失败(跳过): ' + fname + ' - ' + e.message);
    }
  }
  logger.log('[prev-shortage-filter] 本地备份扫描: ' + scanned + ' 个文件, 排除 ' + excluded.size + ' 条(今日已推送)');
  return excluded;
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
    const excludedLocal = loadFromLocalBackups({ storeId, dateStr, logger });
    if (excludedLocal.size > 0) {
      logger.log(
        '[prev-shortage-filter] API 失败，本地备份回退: storeId=' +
          storeId + ' 排除 ' + excludedLocal.size + ' 条已处理商品'
      );
    }
    return excludedLocal;
  }
  const tasks = (data && data.tasks) || [];

  // ---- 本地备份回退：Render 返回空或失败时，从 backups/ 目录补全 ----
  if (!tasks.length) {
    const excludedLocal = loadFromLocalBackups({ storeId, dateStr, logger });
    if (excludedLocal.size > 0) {
      logger.log(
        '[prev-shortage-filter] Render 无数据，本地备份回退: storeId=' +
          storeId + ' 排除 ' + excludedLocal.size + ' 条已处理商品'
      );
      return excludedLocal;
    }
    logger.log('[prev-shortage-filter] 当天暂无历史任务');
    return excluded;
  }

  // 已处理状态集合：task 进入这些状态 = 已被 worker 或店长处理过，本轮不重复推送
  const PROCESSED_STATUSES = new Set(['DONE', 'SHORTAGE', 'FAILED', 'EXECUTING']);
  const statusBreakdown = { DONE: 0, SHORTAGE: 0, FAILED: 0, EXECUTING: 0 };
  for (const t of tasks) {
    const bc = normalizeBarcode(t.barcode);
    if (!bc) continue;
    const tBatch = t.batch_id || '';
    // 跳过本轮及之后的批次（本轮 sync-tasks 还没执行时理应为空，冗余保护）
    if (currentBatchId && tBatch && tBatch >= currentBatchId) continue;

    const st = (t.status || '').toUpperCase();
    if (PROCESSED_STATUSES.has(st)) {
      if (!excluded.has(bc)) {
        excluded.add(bc);
        statusBreakdown[st] = (statusBreakdown[st] || 0) + 1;
      }
    }
  }

  logger.log(
    '[prev-shortage-filter] storeId=' +
      storeId +
      ' 今日已处理 ' +
      excluded.size +
      ' 条 (DONE=' +
      statusBreakdown.DONE +
      ' SHORTAGE=' +
      statusBreakdown.SHORTAGE +
      ' EXECUTING=' +
      statusBreakdown.EXECUTING +
      ' FAILED=' +
      statusBreakdown.FAILED +
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
