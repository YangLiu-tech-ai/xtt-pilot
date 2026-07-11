#!/usr/bin/env node
/**
 * sync-kunlun.js — 昆仑监控 → MVP 任务同步桥接
 *
 * 读取 kunlun fetch_store_items.py 的输出 JSON，
 * 筛选监控清单中未出勤（不可售）的商品，
 * POST 到 Render 后端 /v1/internal/sync-tasks 创建 PENDING 任务。
 *
 * 数据流：
 *   kunlun API (fetch_store_items.py)
 *     → items_data.json  (全量商品, 含 apiTotal/fetchedCount/items)
 *     → sync-kunlun.js  (筛选: 监控清单 ∩ 不可售)
 *     → Render /v1/internal/sync-tasks  (创建 PENDING)
 *     → cron-push.js  (推送钉钉卡片)
 *
 * 用法：
 *   node scripts/sync-kunlun.js <items_data.json> <monitor_barcodes.json> [options]
 *
 * 参数：
 *   items_data.json       - fetch_store_items.py 输出的全量数据
 *   monitor_barcodes.json - 监控条形码清单 [{barcode, item_name, category, priority?}]
 *
 * 环境变量：
 *   MVP_API          - Render 后端 (default: https://xtt-pilot.onrender.com)
 *   MVP_INTERNAL_KEY - 内部密钥 (default: worker-key-2026-prod)
 *
 * 输出：
 *   同步结果到 stdout，含创建任务数
 */
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

const API = process.env.MVP_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.MVP_INTERNAL_KEY || 'worker-key-2026-prod';

// ============ 取数口径模式 ============
// 默认（全量模式）：items 是门店全量目录，isUnattended 判 status!=0 / itemCanSell=false / qty=0。
// --on-shelf-mode（在架模式，配合 fetch_store_items.py --on-shelf-only 使用）：
//   items 只含"在架(status[0,1])"商品，已下架的品根本不在 items 里，
//   由"监控清单 − 在架集合"的差集兜底捕获（每条监控清单带 store_id=wid，精准到门店）。
//   此模式下 isUnattended 对在架品只需判"库存=0"，避免因缺少下架品而漏判。
// 开关默认关闭，不改变任何现有 cron/日报的行为。
const ON_SHELF_MODE = process.argv.includes('--on-shelf-mode');

// ============ HTTP helper ============
function request(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : '';
    const req = mod.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ============ 条形码标准化 ============
function normalizeBarcode(bc) {
  if (!bc) return '';
  return String(bc).replace(/^0+/, '').trim();
}

// ============ 判断商品是否不可售 (未出勤) ============
function isUnattended(item) {
  // 在架模式：items 已是 status[0,1] 的在架品，下架品由差集兜底捕获，
  //   这里只需判"库存=0"（在架但零库存=不可售/即将售罄）。
  if (ON_SHELF_MODE) {
    return item.quantity === 0 || item.quantity === '0' || item.itemCanSell === false;
  }
  // 全量模式（默认）：status=0 且 itemCanSell=true 才是可售（在架），其他均为未出勤
  if (item.itemCanSell === false) return true;
  if (item.status !== 0 && item.status !== '0') return true;
  // 库存为 0 也视为不可售
  if (item.quantity === 0 || item.quantity === '0') return true;
  return false;
}

// ============ 主流程 ============
async function main() {
  // 过滤掉 --flag 形式的参数，只取位置参数（items 文件、monitor 文件）
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (args.length < 2) {
    console.error('用法: node sync-kunlun.js <items_data.json> <monitor_barcodes.json> [--on-shelf-mode]');
    console.error('  items_data.json       - fetch_store_items.py 输出');
    console.error('  monitor_barcodes.json - 监控条形码清单');
    console.error('  --on-shelf-mode       - 配合 fetch --on-shelf-only 使用（items 仅在架，下架品由差集兜底）');
    process.exit(1);
  }
  if (ON_SHELF_MODE) console.log('[sync-kunlun] 运行模式: 在架模式(--on-shelf-mode)，下架品由"监控清单−在架集合"兜底');

  const itemsFile = args[0];
  const monitorFile = args[1];

  // 读取数据
  console.log(`[sync-kunlun] 读取商品数据: ${itemsFile}`);
  const rawData = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));

  console.log(`[sync-kunlun] 读取监控清单: ${monitorFile}`);
  const monitorList = JSON.parse(fs.readFileSync(monitorFile, 'utf8'));

  // 构建监控 barcode 索引 (标准化后)
  const monitorMap = new Map();
  for (const m of monitorList) {
    const bc = normalizeBarcode(m.barcode);
    if (bc) monitorMap.set(bc, m);
  }
  console.log(`[sync-kunlun] 监控清单: ${monitorMap.size} 个条形码`);

  // 遍历门店 — 兼容 dict (wid→store) 和 array 两种格式
  let stores;
  if (rawData.stores && typeof rawData.stores === 'object' && !Array.isArray(rawData.stores)) {
    // dict format: { "1262004557": { storeConfig, apiTotal, fetchedCount, items } }
    stores = Object.entries(rawData.stores).map(([wid, storeData]) => ({
      wid,
      ...(storeData.storeConfig || {}),
      ...storeData,
    }));
  } else {
    stores = rawData.stores || (Array.isArray(rawData) ? rawData : [rawData]);
  }
  let totalSynced = 0;

  for (const store of stores) {
    const storeId = store.wid || store.store_id;
    const storeName = store.name || store.store_name || storeId;
    const items = store.items || [];

    console.log(`\n[sync-kunlun] 门店: ${storeName} (${storeId}), 商品总数: ${items.length}`);

    // 检查数据完整性
    if (store.fetchedCount && store.apiTotal) {
      const rate = store.fetchedCount / store.apiTotal;
      if (rate < 0.9) {
        console.warn(`[sync-kunlun] ⚠️ 门店 ${storeName} 数据不完整 (rate=${(rate * 100).toFixed(1)}%), 跳过`);
        continue;
      }
    }

    // 筛选：监控清单中 + 未出勤
    const unattended = [];
    for (const item of items) {
      const bc = normalizeBarcode(item.barCode || item.barcode);
      if (!monitorMap.has(bc)) continue; // 不在监控清单
      if (!isUnattended(item)) continue;  // 在架可售

      const monitorInfo = monitorMap.get(bc);
      unattended.push({
        barcode: bc,
        itemId: String(item.itemId || ''),
        itemName: item.title || item.item_name || monitorInfo.item_name || '',
        category: item.cateName1 || monitorInfo.category || '',
        price: parseFloat(item.price) || monitorInfo.price || 0,
        quantity: parseInt(item.quantity) || 0,
        yesterdaySales: parseInt(item.monthlySaledQuantity) || monitorInfo.monthly_sales || 0,
        priority: monitorInfo.priority || 'P1',
        // 未出勤原因
        reason: item.itemCanSell === false ? '不可售' :
                (item.quantity === 0 || item.quantity === '0') ? '库存为0' : '下架',
      });
    }

    // 额外：监控清单里完全没出现在 API 数据中的商品 = 也属于未出勤
    const apiBarcodesSet = new Set(items.map(i => normalizeBarcode(i.barCode || i.barcode)));
    for (const [bc, info] of monitorMap.entries()) {
      if (apiBarcodesSet.has(bc)) continue;
      // 可能该门店不卖这个品，跳过没有 storeId 过滤的情况
      // 如果 monitor list 有 store_id 字段，才匹配
      if (info.store_id && info.store_id !== storeId) continue;
      unattended.push({
        barcode: bc,
        itemId: '',
        itemName: info.item_name || '',
        category: info.category || '',
        price: info.price || 0,
        quantity: 0,
        yesterdaySales: info.monthly_sales || 0,
        priority: info.priority || 'P2',
        reason: '商品不存在(未创建/已删除)',
      });
    }

    console.log(`[sync-kunlun] 未出勤商品: ${unattended.length} 件`);
    if (unattended.length === 0) {
      console.log(`[sync-kunlun] ✅ ${storeName} 监控品全部在架`);
      continue;
    }

    // 生成 batchId: YYYYMMDD-HHmm
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const batchId = now.toISOString().slice(0, 16).replace(/[-T:]/g, '').slice(0, 12);
    // e.g. "202606261000"

    // POST 到 Render
    console.log(`[sync-kunlun] → POST /v1/internal/sync-tasks (batch=${batchId}, items=${unattended.length})`);
    const result = await request('POST', `${API}/v1/internal/sync-tasks`, {
      batchId,
      storeId,
      storeName,
      items: unattended,
    }, { 'X-Internal-Key': INTERNAL_KEY });

    if (result.status === 200 && result.data.ok) {
      console.log(`[sync-kunlun] ✅ 同步成功: created=${result.data.created}, deleted_old=${result.data.deleted}`);
      totalSynced += result.data.created;
    } else {
      console.error(`[sync-kunlun] ❌ 同步失败: status=${result.status}`, result.data);
    }
  }

  console.log(`\n[sync-kunlun] 🏁 完成. 共同步 ${totalSynced} 条缺货任务到后端`);
  return totalSynced;
}

main().catch(e => {
  console.error('[sync-kunlun] 执行异常:', e.message);
  process.exit(1);
});
