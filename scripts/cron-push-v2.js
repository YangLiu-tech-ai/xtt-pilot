#!/usr/bin/env node
/**
 * cron-push-v2.js — 自包含版：昆仑实时数据 → 未出勤筛选 → 钉钉推送
 * 
 * 完全本地运行，不依赖 Render 后端。
 * 数据源：fetch_store_items.py 输出的 JSON + 监控清单
 * 
 * 两种模式：
 *   A) 独立推送（自包含，从本地 JSON 筛选推送）：
 *      node cron-push-v2.js --items <items.json> --monitor <monitor.json>
 *   
 *   B) 完整闭环（kunlun fetch → 筛选 → sync Render → 推送）：
 *      node cron-push-v2.js --items <items.json> --monitor <monitor.json> --sync-render
 *
 * 默认文件：
 *   --items   scripts/items_csnclt.json
 *   --monitor scripts/monitor-barcodes-csnclt.json
 * 
 * 环境变量：
 *   DING_WEBHOOK       - 钉钉群 webhook
 *   MVP_API            - Render 后端（仅 --sync-render 时使用）
 *   MVP_INTERNAL_KEY   - 内部密钥（仅 --sync-render 时使用）
 */
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

const WEBHOOK = process.env.DING_WEBHOOK
  || 'https://oapi.dingtalk.com/robot/send?access_token=b92c7d5f0c3a4447294f310afbaa99ce09ae3ce1b15a470e029dd8f38a60fa86';
const API = process.env.MVP_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.MVP_INTERNAL_KEY || 'worker-key-2026-prod';

// 解析命令行参数
const argv = process.argv.slice(2);
function getArg(flag, def) {
  const idx = argv.indexOf(flag);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : def;
}
const itemsPath = getArg('--items', path.join(__dirname, 'items_csnclt.json'));
const monitorPath = getArg('--monitor', path.join(__dirname, 'monitor-barcodes-csnclt.json'));
const dryRun = argv.includes('--dry-run');
const syncRender = argv.includes('--sync-render');

// ============ 条形码标准化 ============
function normalizeBarcode(bc) {
  if (!bc) return '';
  return String(bc).replace(/^0+/, '').trim();
}

// ============ 判断商品是否不可售 ============
function isUnattended(item) {
  if (item.itemCanSell === false) return true;
  if (item.status !== 0 && item.status !== '0') return true;
  if (item.quantity === 0 || item.quantity === '0') return true;
  return false;
}

// ============ HTTP POST ============
function post(urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = mod.request({
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ============ 主流程 ============
async function main() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const timeStr = now.toISOString().slice(0, 16).replace('T', ' ');
  console.log(`[cron-push-v2] ${timeStr} CST 开始执行`);

  // 1. 读取数据
  if (!fs.existsSync(itemsPath)) {
    console.error(`[cron-push-v2] 商品数据文件不存在: ${itemsPath}`);
    console.error('[cron-push-v2] 请先运行 fetch_store_items.py 获取最新数据');
    process.exit(1);
  }
  console.log(`[cron-push-v2] 读取: ${itemsPath}`);
  const rawData = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
  const monitorList = JSON.parse(fs.readFileSync(monitorPath, 'utf8'));

  // 2. 构建监控索引
  const monitorMap = new Map();
  for (const m of monitorList) {
    const bc = normalizeBarcode(m.barcode);
    if (bc) monitorMap.set(bc, m);
  }
  console.log(`[cron-push-v2] 监控清单: ${monitorMap.size} 个条形码`);

  // 3. 遍历门店（兼容 dict 和 array）
  let stores;
  if (rawData.stores && typeof rawData.stores === 'object' && !Array.isArray(rawData.stores)) {
    stores = Object.entries(rawData.stores).map(([wid, d]) => ({ wid, ...d }));
  } else {
    stores = rawData.stores || [rawData];
  }

  for (const store of stores) {
    const storeId = store.wid || store.store_id;
    const storeName = (store.storeConfig && store.storeConfig.name) || store.name || storeId;
    const items = store.items || [];
    console.log(`[cron-push-v2] 门店: ${storeName} (${storeId}), 商品: ${items.length}`);

    // 完整性检查
    if (store.fetchedCount && store.apiTotal) {
      const rate = store.fetchedCount / store.apiTotal;
      if (rate < 0.9) {
        console.warn(`[cron-push-v2] 数据不完整 (${(rate * 100).toFixed(1)}%), 跳过`);
        continue;
      }
    }

    // 4. 筛选未出勤
    const unattended = [];
    for (const item of items) {
      const bc = normalizeBarcode(item.barCode || item.barcode);
      if (!monitorMap.has(bc)) continue;
      if (!isUnattended(item)) continue;
      const info = monitorMap.get(bc);
      unattended.push({
        barcode: bc,
        itemName: item.title || info.item_name,
        price: parseFloat(item.price) || 0,
        quantity: parseInt(item.quantity) || 0,
        reason: item.itemCanSell === false ? '不可售' :
          (item.quantity == 0) ? '库存为0' : '下架',
      });
    }

    // 不在 API 中的监控品
    const apiBarcodes = new Set(items.map(i => normalizeBarcode(i.barCode || i.barcode)));
    for (const [bc, info] of monitorMap.entries()) {
      if (apiBarcodes.has(bc)) continue;
      if (info.store_id && info.store_id !== storeId) continue;
      unattended.push({
        barcode: bc,
        itemName: info.item_name || '',
        price: 0,
        quantity: 0,
        reason: '商品不存在',
      });
    }

    console.log(`[cron-push-v2] 未出勤: ${unattended.length} 件`);

    if (unattended.length === 0) {
      console.log(`[cron-push-v2] ✅ ${storeName} 全部在架，跳过推送`);
      continue;
    }

    // 5. 可选：同步到 Render
    if (syncRender) {
      const batchId = now.toISOString().slice(0, 16).replace(/[-T:]/g, '').slice(0, 12);
      console.log(`[cron-push-v2] → sync-render (batch=${batchId})`);
      try {
        const syncRes = await post(`${API}/v1/internal/sync-tasks`, {
          batchId, storeId, storeName, items: unattended,
        }, { 'X-Internal-Key': INTERNAL_KEY });
        console.log(`[cron-push-v2] sync result:`, syncRes.ok ? 'OK' : syncRes);
      } catch (e) {
        console.warn(`[cron-push-v2] sync-render 失败 (非致命): ${e.message}`);
      }
    }

    // 6. 构建钉钉卡片
    const offline = unattended.filter(u => u.reason === '不可售' || u.reason === '下架');
    const zeroStock = unattended.filter(u => u.reason === '库存为0');
    const notExist = unattended.filter(u => u.reason === '商品不存在');

    const lines = [
      `### 缺货补品 · ${storeName}`,
      `**${unattended.length} 件监控品未出勤**`,
      '',
    ];

    if (offline.length > 0) {
      lines.push(`#### 🔴 不可售/下架 (${offline.length}件)`);
      offline.slice(0, 8).forEach((u, i) => lines.push(`${i + 1}. ${u.itemName}`));
      if (offline.length > 8) lines.push(`   … 还有 ${offline.length - 8} 件`);
      lines.push('');
    }
    if (zeroStock.length > 0) {
      lines.push(`#### 🟡 库存为0 (${zeroStock.length}件)`);
      zeroStock.slice(0, 5).forEach((u, i) => lines.push(`${i + 1}. ${u.itemName}`));
      if (zeroStock.length > 5) lines.push(`   … 还有 ${zeroStock.length - 5} 件`);
      lines.push('');
    }
    if (notExist.length > 0) {
      lines.push(`#### ⚪ 商品不存在 (${notExist.length}件)`);
      notExist.slice(0, 5).forEach((u, i) => lines.push(`${i + 1}. ${u.itemName}`));
      if (notExist.length > 5) lines.push(`   … 还有 ${notExist.length - 5} 件`);
      lines.push('');
    }

    lines.push('---');
    lines.push(`> 昆仑实时监控 · ${timeStr}`);

    if (dryRun) {
      console.log('[cron-push-v2] [DRY-RUN] 卡片内容:\n' + lines.join('\n'));
      continue;
    }

    // 7. 推送钉钉
    const cardBody = {
      msgtype: 'actionCard',
      actionCard: {
        title: `推送: 缺货补品 · ${storeName} · ${unattended.length}件`,
        text: lines.join('\n'),
        singleTitle: '📱 查看补品清单',
        singleURL: 'https://xtt-pilot.onrender.com/h5/preview.html',
      },
    };

    const resp = await post(WEBHOOK, cardBody);
    if (resp.errcode === 0) {
      console.log(`[cron-push-v2] ✅ 推送成功: ${unattended.length} 件`);
    } else {
      console.error(`[cron-push-v2] ❌ 推送失败:`, resp);
    }

    // 8. 保存结果
    const outFile = path.join(__dirname, `unattended-${storeId}.json`);
    fs.writeFileSync(outFile, JSON.stringify(unattended, null, 2), 'utf8');
    console.log(`[cron-push-v2] 结果已保存: ${outFile}`);
  }

  console.log(`[cron-push-v2] 🏁 完成`);
}

main().catch(e => {
  console.error('[cron-push-v2] 执行异常:', e.message);
  process.exit(1);
});
