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
 *   PUSH_COOLDOWN_MIN  - 推送去重冷却窗口（分钟），默认 30。同一门店在此窗口内不重复推送
 */
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const {
  loadFeedbackedBarcodes,
  saveLastPush,
} = require('./prev-shortage-filter');

// 是否启用"上一时段线下缺货即排除"过滤（默认开启，可用 SKIP_PREV_SHORTAGE=off 关闭）
const SKIP_PREV_SHORTAGE =
  (process.env.SKIP_PREV_SHORTAGE || 'on').toLowerCase() !== 'off';

const API = process.env.MVP_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.MVP_INTERNAL_KEY || 'worker-key-2026-prod';

// ============ HQ Magic Link 配置（P2） ============
// 7 店 → 品牌映射
const SHOP_TO_BRAND = {
  '1137486501': 'xq',   // 兴勤陈江
  '1328460101': 'xq',   // 兴勤港惠
  '1262004557': 'csnc', // 成山龙湖天街
  '1265426893': 'csnc', // 成山京东MALL
  '1284510785': 'txp',  // 淘小胖龙湖
  '528662517':  'txp',  // 淘小胖荥阳
  '1316559920': 'txp',  // 淘小胖宝龙城广
};
// brand 显示名
const BRAND_DISPLAY = { csnc: '成山农场', xq: '兴勤超市', txp: '淘小胖' };
// HQ 子路径默认与 MVP_API 同源；可通过 HQ_BASE_URL_<BRAND> 覆盖
function getHqBaseUrl(brand) {
  return process.env[`HQ_BASE_URL_${brand.toUpperCase()}`] || `${API}/${brand}`;
}
// 是否启用 HQ 按钮（默认开启，可用 HQ_BUTTON=off 关闭）
const HQ_BUTTON_ENABLED = (process.env.HQ_BUTTON || 'on').toLowerCase() !== 'off';

// ============ 品牌配置加载 ============
const BRANDS_CONFIG_PATH = path.join(__dirname, 'brands-config.json');
let brandsConfig = null;
try {
  brandsConfig = JSON.parse(fs.readFileSync(BRANDS_CONFIG_PATH, 'utf8'));
} catch (e) {
  console.warn(`[cron-push-v2] brands-config.json 不存在或解析失败，鲸品云字段将缺省: ${e.message}`);
}

// 按 wid 查找对应门店的 whaleShopId 和 credentialKey
function getWhaleConfig(storeWid) {
  if (!brandsConfig || !brandsConfig.brands) return { whaleShopId: null, credentialKey: null };
  for (const [brandKey, brand] of Object.entries(brandsConfig.brands)) {
    for (const store of (brand.stores || [])) {
      if (String(store.wid) === String(storeWid)) {
        return {
          whaleShopId: store.whaleShopId || null,
          credentialKey: brand.credentialKey || null,
        };
      }
    }
  }
  return { whaleShopId: null, credentialKey: null };
}

// 按 wid 查找门店级 webhook（优先门店配置，回退品牌级 webhook）
function getStoreWebhook(storeWid) {
  if (!brandsConfig || !brandsConfig.brands) return null;
  for (const [brandKey, brand] of Object.entries(brandsConfig.brands)) {
    for (const store of (brand.stores || [])) {
      if (String(store.wid) === String(storeWid)) {
        return store.dingtalkWebhook || brand.dingtalkWebhook || null;
      }
    }
  }
  return null;
}

// 解析命令行参数
const argv = process.argv.slice(2);
function getArg(flag, def) {
  const idx = argv.indexOf(flag);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : def;
}
const dryRun = argv.includes('--dry-run');
const syncRender = argv.includes('--sync-render');

// ============ --brand 品牌感知（自动解析 webhook + monitor 文件） ============
const brandKey = getArg('--brand', null);
let brandWebhook = null;
let brandMonitorFile = null;
if (brandKey && brandsConfig && brandsConfig.brands && brandsConfig.brands[brandKey]) {
  const brand = brandsConfig.brands[brandKey];
  brandWebhook = brand.dingtalkWebhook || null;
  brandMonitorFile = brand.monitorFile
    ? path.join(__dirname, brand.monitorFile)
    : null;
} else if (brandKey) {
  console.error(`[cron-push-v2] ❌ 未知品牌: ${brandKey}，请检查 brands-config.json`);
  process.exit(1);
}

// webhook 优先级：--brand 品牌配置 > 环境变量 > 硬编码默认（csnc 向后兼容）
const WEBHOOK = brandWebhook
  || process.env.DING_WEBHOOK
  || 'https://oapi.dingtalk.com/robot/send?access_token=86ff44c61d0eb7877f9db3bef374ab387480e7193764dfc3a98c125711cc48b2';

const itemsPath = getArg('--items', path.join(__dirname, 'items_csnclt.json'));
// monitor 优先级：--monitor 显式指定 > --brand 品牌配置 > 硬编码默认（csnclt 向后兼容）
let monitorPath = getArg('--monitor', brandMonitorFile || path.join(__dirname, 'monitor-barcodes-csnclt.json'));

if (brandKey) {
  console.log(`[cron-push-v2] ✅ 品牌: ${brandKey} (${brandsConfig.brands[brandKey].brandName})`);
  console.log(`[cron-push-v2]    webhook: ...${WEBHOOK.slice(-12)}`);
  console.log(`[cron-push-v2]    monitor: ${path.basename(monitorPath)}`);
}

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

function getJSON(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      method: 'GET',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers,
      timeout: 30000,
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('GET timeout')));
    req.end();
  });
}

// ============ 推送去重 ============
const DEDUP_PATH = path.join(__dirname, '.push-dedup.json');
const COOLDOWN_MS = (parseInt(process.env.PUSH_COOLDOWN_MIN) || 30) * 60 * 1000;

function readDedupState() {
  try { return JSON.parse(fs.readFileSync(DEDUP_PATH, 'utf8')); }
  catch { return {}; }
}

function saveDedupState(state) {
  fs.writeFileSync(DEDUP_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ============ 本地批次备份（按日期 + 批次归档，永不覆盖） ============
const BACKUP_ROOT = path.join(__dirname, 'backups');

function saveBatchBackup({ storeId, storeName, batchId, kept, filteredOut }) {
  const dateStr = batchId.slice(0, 4) + '-' + batchId.slice(4, 6) + '-' + batchId.slice(6, 8);
  const dir = path.join(BACKUP_ROOT, dateStr);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${storeId}_batch-${batchId}.json`);
  const payload = {
    storeId,
    storeName,
    batchId,
    pushedAt: new Date().toISOString(),
    keptCount: kept.length,
    filteredOutCount: filteredOut.length,
    kept: kept.map(u => ({ ...u, batchId })),
    filteredOut: filteredOut.map(u => ({ ...u, batchId })),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[cron-push-v2] 💾 本地备份: ${file}`);
}

// ============ 状态回写：拉服务端最新处理状态，更新本地备份文件 ============
async function syncBatchStatuses({ apiBase, internalKey, storeId, dateStr }) {
  try {
    const url = `${apiBase}/v1/internal/report/tasks-by-store?storeId=${storeId}&date=${dateStr}`;
    const data = await getJSON(url, { 'x-internal-key': internalKey });
    const tasks = (data && data.tasks) || [];
    if (!tasks.length) {
      console.log(`[cron-push-v2] 🔄 状态同步: ${storeId} 当天暂无任务`);
      return;
    }

    // barcode + batchId → { status, action, operator, shortage_reason }
    const statusMap = new Map();
    for (const t of tasks) {
      const key = `${normalizeBarcode(t.barcode)}|${t.batch_id || ''}`;
      statusMap.set(key, {
        status: t.status || null,
        action: t.action || null,
        operator: t.operator || null,
        shortageReason: t.shortage_reason || null,
        shortageReasonDetail: t.shortage_reason_detail || null,
      });
    }

    const dir = path.join(BACKUP_ROOT, dateStr);
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter(
      f => f.startsWith(`${storeId}_batch-`) && f.endsWith('.json')
    );

    let updatedCount = 0;
    for (const file of files) {
      const filePath = path.join(dir, file);
      const raw = fs.readFileSync(filePath, 'utf8');
      const backup = JSON.parse(raw);
      let changed = false;

      const enrichItem = (item) => {
        const bc = normalizeBarcode(item.barcode);
        const bid = item.batchId || backup.batchId || '';
        const key = `${bc}|${bid}`;
        const s = statusMap.get(key);
        if (s) {
          item.status = s.status;
          item.action = s.action;
          if (s.operator) item.operator = s.operator;
          if (s.shortageReason) item.shortageReason = s.shortageReason;
          if (s.shortageReasonDetail) item.shortageReasonDetail = s.shortageReasonDetail;
          changed = true;
        }
      };

      (backup.kept || []).forEach(enrichItem);
      (backup.filteredOut || []).forEach(enrichItem);

      if (changed) {
        backup.lastSyncedAt = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf8');
        updatedCount++;
      }
    }

    console.log(`[cron-push-v2] 🔄 状态同步: ${storeId} ${dateStr} 更新了 ${updatedCount}/${files.length} 个备份文件`);
  } catch (e) {
    console.warn(`[cron-push-v2] 🔄 状态同步失败(非致命): ${e.message}`);
  }
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

  // 2. 构建监控索引（复合键 storeId:barcode 严格门店隔离）
  const monitorMap = new Map();
  for (const m of monitorList) {
    const bc = normalizeBarcode(m.barcode);
    if (!bc) continue;
    const sid = m.store_id || '';
    monitorMap.set(`${sid}:${bc}`, m);
  }
  // 辅助函数：先查当前门店，再查无门店绑定的通配条目
  function getMonitorEntry(bc, storeId) {
    return monitorMap.get(`${storeId}:${bc}`) || monitorMap.get(`:${bc}`);
  }
  const uniqueBarcodes = new Set(monitorList.map(m => normalizeBarcode(m.barcode)).filter(Boolean));
  console.log(`[cron-push-v2] 监控清单: ${uniqueBarcodes.size} 个条形码 (${monitorMap.size} 条门店绑定)`);

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

    // ⛔ 防护1：商品数据为空 = 昆仑取数失败，严禁推送
    if (!items || items.length === 0) {
      console.error(`[cron-push-v2] ⛔ 数据异常: ${storeName}(${storeId}) 商品数据为空，昆仑取数可能失败，跳过推送`);
      continue;
    }

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
      const info = getMonitorEntry(bc, storeId);
      if (!info) continue;
      if (!isUnattended(item)) continue;
      unattended.push({
        barcode: bc,
        itemName: item.title || info.item_name,
        category: item.cateName1 || '',
        price: parseFloat(item.price) || 0,
        currentPrice: parseFloat(item.price) || 0,
        activityPrice: item.minActivePrice ? parseFloat(item.minActivePrice) : null,
        monthlySales: parseInt(item.monthlySaledQuantity) || 0,
        imageUrl: item.picUrl || null,
        quantity: parseInt(item.quantity) || 0,
        reason: item.itemCanSell === false ? '不可售' :
          (item.quantity == 0) ? '库存为0' : '下架',
      });
    }

    // 不在 API 中的监控品（复合键：只查当前门店绑定和无门店绑定的条目）
    const apiBarcodes = new Set(items.map(i => normalizeBarcode(i.barCode || i.barcode)));
    for (const [key, info] of monitorMap.entries()) {
      const [sid, bc] = [key.substring(0, key.indexOf(':')), key.substring(key.indexOf(':') + 1)];
      if (sid && sid !== storeId) continue;  // 跳过其他门店的条目
      if (apiBarcodes.has(bc)) continue;
      unattended.push({
        barcode: bc,
        itemName: info.item_name || '',
        price: 0,
        currentPrice: 0,
        activityPrice: null,
        monthlySales: 0,
        imageUrl: null,
        quantity: 0,
        reason: '商品不存在',
      });
    }

    console.log(`[cron-push-v2] 未出勤: ${unattended.length} 件`);

    // ⛔ 防护2：未出勤占比超过 80% = 数据异常（正常情况下不会几乎全部缺货）
    const storeMonitorCount = Array.from(monitorMap.entries()).filter(([key, m]) => {
      const sid = key.substring(0, key.indexOf(':'));
      return !sid || sid === storeId;
    }).length;
    if (storeMonitorCount > 0 && unattended.length > storeMonitorCount * 0.8) {
      console.error(`[cron-push-v2] ⛔ 数据异常: ${storeName}(${storeId}) 未出勤 ${unattended.length}/${storeMonitorCount} (${(unattended.length / storeMonitorCount * 100).toFixed(1)}% > 80%)，疑似数据不完整，跳过推送`);
      continue;
    }

    if (unattended.length === 0) {
      console.log(`[cron-push-v2] ✅ ${storeName} 全部在架，跳过推送`);
      // 留档：记录本轮全部在架
      const emptyBatchId = now.toISOString().slice(0, 16).replace(/[-T:]/g, '').slice(0, 12);
      try { saveBatchBackup({ storeId, storeName, batchId: emptyBatchId, kept: [], filteredOut: [] }); } catch (e) {
        console.warn(`[cron-push-v2] 备份失败(非致命): ${e.message}`);
      }
      continue;
    }

    // 5. 生成 batchId（推送 + 去重共用）
    const batchId = now.toISOString().slice(0, 16).replace(/[-T:]/g, '').slice(0, 12);

    // 5.0 状态回写：拉服务端最新处理状态，更新今天所有历史批次的本地备份
    const syncDateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD (CST)
    await syncBatchStatuses({ apiBase: API, internalKey: INTERNAL_KEY, storeId, dateStr: syncDateStr });

    // 5.1 排除"上一时段店长已选择线下缺货"的商品（SHORTAGE 视为已反馈）
    //     上架成功(DONE)后又被下架的商品仍然会出现在本轮 unattended，继续推送
    let filteredOutByShortage = [];
    if (SKIP_PREV_SHORTAGE) {
      const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD (CST)
      const feedbackedSet = await loadFeedbackedBarcodes({
        apiBase: API,
        internalKey: INTERNAL_KEY,
        storeId,
        dateStr,
        currentBatchId: batchId,
      });
      if (feedbackedSet.size > 0) {
        const keep = [];
        for (const u of unattended) {
          if (feedbackedSet.has(u.barcode)) {
            filteredOutByShortage.push(u);
          } else {
            keep.push(u);
          }
        }
        console.log(
          `[cron-push-v2] 上一时段线下缺货反馈已过滤 ${filteredOutByShortage.length} 件，剩余 ${keep.length} 件待推送`
        );
        unattended.length = 0;
        for (const u of keep) unattended.push(u);
      }
      if (unattended.length === 0) {
        console.log(
          `[cron-push-v2] ✅ ${storeName} 剩余商品均已在上一时段反馈，跳过推送`
        );
        // 落审计快照（本轮全部被排除）
        try { saveLastPush({ storeId, storeName, batchId, kept: [], filteredOut: filteredOutByShortage }); } catch (e) {
          console.warn(`[cron-push-v2] saveLastPush 失败(非致命): ${e.message}`);
        }
        // 本地批次备份
        try { saveBatchBackup({ storeId, storeName, batchId, kept: [], filteredOut: filteredOutByShortage }); } catch (e) {
          console.warn(`[cron-push-v2] 备份失败(非致命): ${e.message}`);
        }
        continue;
      }
    }

    // 6. 去重检查：同一门店在冷却窗口内不重复推送（无论 batchId 是否相同）
    const dedupState = readDedupState();
    const lastPush = dedupState[storeId];
    if (lastPush && (Date.now() - lastPush.timestamp) < COOLDOWN_MS) {
      const minsAgo = ((Date.now() - lastPush.timestamp) / 60000).toFixed(1);
      console.log(`[cron-push-v2] ⏭️ 去重跳过: ${storeName} 已于 ${minsAgo} 分钟前推送 (lastBatch=${lastPush.batchId}, currentBatch=${batchId})`);
      // 仍然保存结果文件，方便排查
      const outFile = path.join(__dirname, `unattended-${storeId}.json`);
      fs.writeFileSync(outFile, JSON.stringify(unattended, null, 2), 'utf8');
      // 本地批次备份（去重跳过也留档）
      try { saveBatchBackup({ storeId, storeName, batchId, kept: unattended, filteredOut: filteredOutByShortage }); } catch (e) {
        console.warn(`[cron-push-v2] 备份失败(非致命): ${e.message}`);
      }
      continue;
    }

    // 7. 可选：同步到 Render
    if (syncRender) {
      console.log(`[cron-push-v2] → sync-render (batch=${batchId})`);
      try {
        // 5.1 归档该门店所有 PENDING 任务（含旧 batch），保留数据供日报统计
        //     sync-tasks 也会归档，这里是双保险；改为 ARCHIVE 而非 DELETE 防止数据丢失
        const cleanupRes = await post(`${API}/v1/internal/cleanup-pending`, {
          storeId, where: 'all',
        }, { 'X-Internal-Key': INTERNAL_KEY });
        console.log(`[cron-push-v2] cleanup-pending: archived=${cleanupRes.archived || cleanupRes.deleted || 0}`);
      } catch (e) {
        console.warn(`[cron-push-v2] cleanup-pending 失败 (非致命): ${e.message}`);
      }
      try {
        // 从 brands-config 获取门店对应的鲸品云隔离字段
        const whaleConf = getWhaleConfig(storeId);
        const syncRes = await post(`${API}/v1/internal/sync-tasks`, {
          batchId, storeId, storeName, items: unattended,
          whaleShopId: whaleConf.whaleShopId,
          credentialKey: whaleConf.credentialKey,
        }, { 'X-Internal-Key': INTERNAL_KEY });
        console.log(`[cron-push-v2] sync result:`, syncRes.ok ? 'OK' : syncRes,
          `(whale=${whaleConf.whaleShopId}, cred=${whaleConf.credentialKey})`);
      } catch (e) {
        console.warn(`[cron-push-v2] sync-render 失败 (非致命): ${e.message}`);
      }
    }

    // 8. 构建钉钉卡片
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

    // 9. 签发 token + 推送钉钉
    let h5Url = `${API}/h5/preview.html`;
    try {
      const tokenRes = await post(`${API}/v1/auth/issue`, { storeId, dingId: 'push' });
      if (tokenRes.ok && tokenRes.token) {
        h5Url = `${API}/h5/preview.html?token=${tokenRes.token}`;
      }
    } catch (e) {
      console.warn(`[cron-push-v2] token签发失败(非致命): ${e.message}`);
    }

    // 9.1 HQ Magic Link (P2)：为 7 店之一签发对应品牌的 magic-link
    let hqUrl = null;
    const brand = SHOP_TO_BRAND[String(storeId)];
    if (HQ_BUTTON_ENABLED && brand) {
      try {
        const magicRes = await post(`${API}/api/hq/auth/issue-magic`, {
          brand,
          userId: 'group-broadcast',
        });
        if (magicRes.ok && magicRes.link) {
          hqUrl = magicRes.link;
        } else if (magicRes.ok && magicRes.token) {
          hqUrl = `${getHqBaseUrl(brand)}/?t=${encodeURIComponent(magicRes.token)}`;
        }
      } catch (e) {
        console.warn(`[cron-push-v2] HQ magic-link 签发失败(非致命): ${e.message}`);
      }
    }

    // 构建多按钮 actionCard
    const btns = [{ title: '📱 店长查看清单', actionURL: h5Url }];
    if (hqUrl) {
      btns.push({
        title: `🏢 ${BRAND_DISPLAY[brand] || '总部'}盯盘`,
        actionURL: hqUrl,
      });
    }

    const cardBody = {
      msgtype: 'actionCard',
      actionCard: {
        title: `推送: 缺货补品 · ${storeName} · ${unattended.length}件`,
        text: lines.join('\n'),
        btnOrientation: '0', // 0 = 竖直
        btns,
      },
    };

    // 门店级 webhook 优先，回退品牌级 WEBHOOK
    const storeWebhook = getStoreWebhook(storeId) || WEBHOOK;
    console.log(`[cron-push-v2] 推送 webhook: ...${storeWebhook.slice(-12)} (store=${storeId})`);
    const resp = await post(storeWebhook, cardBody);
    if (resp.errcode === 0) {
      console.log(`[cron-push-v2] ✅ 推送成功: ${unattended.length} 件`);
      // 10. 保存去重状态
      dedupState[storeId] = { timestamp: Date.now(), batchId, count: unattended.length };
      saveDedupState(dedupState);
    } else {
      console.error(`[cron-push-v2] ❌ 推送失败:`, resp);
    }

    // 11. 保存结果
    const outFile = path.join(__dirname, `unattended-${storeId}.json`);
    fs.writeFileSync(outFile, JSON.stringify(unattended, null, 2), 'utf8');
    console.log(`[cron-push-v2] 结果已保存: ${outFile}`);

    // 12. 落审计快照（记录本轮推送 + 被上一时段反馈过滤掉的清单）
    try { saveLastPush({ storeId, storeName, batchId, kept: unattended, filteredOut: filteredOutByShortage }); } catch (e) {
      console.warn(`[cron-push-v2] saveLastPush 失败(非致命): ${e.message}`);
    }

    // 13. 本地批次备份（按日期+批次归档，永不覆盖）
    try { saveBatchBackup({ storeId, storeName, batchId, kept: unattended, filteredOut: filteredOutByShortage }); } catch (e) {
      console.warn(`[cron-push-v2] 备份失败(非致命): ${e.message}`);
    }
  }

  console.log(`[cron-push-v2] 🏁 完成`);
}

main().catch(e => {
  console.error('[cron-push-v2] 执行异常:', e.message);
  process.exit(1);
});
