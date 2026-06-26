#!/usr/bin/env node
/**
 * cron-push-v2.js — 实时数据闭环推送
 *
 * 新流程（v2）：
 *   1. 调用 kunlun API 拉取门店实时商品数据 (fetch_store_items.py)
 *   2. 对比监控清单筛选未出勤商品 (sync-kunlun.js 逻辑内联)
 *   3. POST /v1/internal/sync-tasks 创建 PENDING 任务
 *   4. 签发 token → 推送钉钉卡片
 *
 * 降级：
 *   若 kunlun fetch 失败（cookie 过期等），回退到查询现有 PENDING 推送
 *
 * 环境变量：
 *   MVP_API            - Render 后端 (default: https://xtt-pilot.onrender.com)
 *   MVP_INTERNAL_KEY   - 内部密钥
 *   DING_WEBHOOK       - 钉钉群 webhook
 *   KUNLUN_DATA_DIR    - kunlun fetch 输出目录 (default: ../outputs)
 *   MONITOR_BARCODES   - 监控清单 JSON 路径
 *
 * 两种执行模式：
 *   A) 带 kunlun 数据（完整闭环）：
 *      node cron-push-v2.js --kunlun-json <items_data.json>
 *
 *   B) 仅推送已有 PENDING（降级模式，兼容 v1）：
 *      node cron-push-v2.js
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const API = process.env.MVP_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.MVP_INTERNAL_KEY || 'worker-key-2026-prod';
const WEBHOOK = process.env.DING_WEBHOOK || 'https://oapi.dingtalk.com/robot/send?access_token=b92c7d5f0c3a4447294f310afbaa99ce09ae3ce1b15a470e029dd8f38a60fa86';
const MONITOR_FILE = process.env.MONITOR_BARCODES || path.join(__dirname, 'monitor-barcodes-pilot.json');

// 试点配置
const PILOT_STORE = '1284510785';
const PILOT_STORE_NAME = '淘小胖·龙湖天街';
const PILOT_DING_ID = 'd12yidm';

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

// ============ 判断未出勤 ============
function isUnattended(item) {
  if (item.itemCanSell === false) return true;
  if (item.status !== 0 && item.status !== '0') return true;
  if (item.quantity === 0 || item.quantity === '0') return true;
  return false;
}

// ============ kunlun 同步逻辑 ============
async function syncFromKunlun(itemsJson) {
  console.log('[cron-push-v2] 模式: kunlun 实时同步');

  // 读取监控清单
  if (!fs.existsSync(MONITOR_FILE)) {
    console.warn(`[cron-push-v2] 监控清单不存在: ${MONITOR_FILE}, 跳过同步`);
    return false;
  }
  const monitorList = JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf8'));
  const monitorMap = new Map();
  for (const m of monitorList) {
    const bc = normalizeBarcode(m.barcode);
    if (bc) monitorMap.set(bc, m);
  }

  // 读取 kunlun 数据
  const rawData = JSON.parse(fs.readFileSync(itemsJson, 'utf8'));
  const stores = rawData.stores || (Array.isArray(rawData) ? rawData : [rawData]);

  for (const store of stores) {
    const storeId = store.wid || store.store_id || PILOT_STORE;
    const storeName = store.name || store.store_name || PILOT_STORE_NAME;
    const items = store.items || [];

    // 完整性校验
    if (store.fetchedCount && store.apiTotal) {
      const rate = store.fetchedCount / store.apiTotal;
      if (rate < 0.9) {
        console.warn(`[cron-push-v2] ⚠️ ${storeName} 数据不完整 (${(rate * 100).toFixed(1)}%), 跳过`);
        continue;
      }
    }

    // 筛选未出勤监控品
    const unattended = [];
    for (const item of items) {
      const bc = normalizeBarcode(item.barCode || item.barcode);
      if (!monitorMap.has(bc)) continue;
      if (!isUnattended(item)) continue;

      const info = monitorMap.get(bc);
      unattended.push({
        barcode: bc,
        itemId: String(item.itemId || ''),
        itemName: item.title || info.item_name || '',
        category: item.cateName1 || info.category || '',
        price: parseFloat(item.price) || info.price || 0,
        yesterdaySales: parseInt(item.monthlySaledQuantity) || info.monthly_sales || 0,
        quantity: parseInt(item.quantity) || 0,
        priority: info.priority || 'P1',
      });
    }

    if (unattended.length === 0) {
      console.log(`[cron-push-v2] ✅ ${storeName} 监控品全部在架，无需同步`);
      continue;
    }

    // 生成 batchId
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const batchId = now.toISOString().slice(0, 16).replace(/[-T:]/g, '').slice(0, 12);

    // 同步到后端
    console.log(`[cron-push-v2] 同步 ${unattended.length} 件未出勤商品到后端 (batch=${batchId})`);
    const syncRes = await request('POST', `${API}/v1/internal/sync-tasks`, {
      batchId, storeId, storeName, items: unattended,
    }, { 'X-Internal-Key': INTERNAL_KEY });

    if (syncRes.status === 200 && syncRes.data.ok) {
      console.log(`[cron-push-v2] ✅ 同步成功: created=${syncRes.data.created}`);
    } else {
      console.error(`[cron-push-v2] ❌ 同步失败:`, syncRes.data);
      return false;
    }
  }

  return true;
}

// ============ 推送逻辑 (复用 v1) ============
async function pushPending() {
  // 1. 签发 token
  const tokenRes = await request('POST', `${API}/v1/auth/issue`, {
    storeId: PILOT_STORE,
    dingId: PILOT_DING_ID,
  });
  if (!tokenRes.data.ok) {
    console.error('[cron-push-v2] token签发失败:', tokenRes.data);
    return;
  }
  const token = tokenRes.data.token;

  // 2. 查询待处理
  const tasksRes = await request('GET', `${API}/v1/tasks?token=${token}`, null);
  if (!tasksRes.data.ok) {
    console.error('[cron-push-v2] 查询失败:', tasksRes.data);
    return;
  }
  const tasks = tasksRes.data.tasks || [];
  const pendingTasks = tasks.filter(t => t.status === 'PENDING');
  console.log(`[cron-push-v2] 总任务: ${tasks.length}, 待处理: ${pendingTasks.length}`);

  if (pendingTasks.length === 0) {
    console.log('[cron-push-v2] 无待处理任务，跳过推送');
    return;
  }

  // 3. 构建卡片
  const h5Url = `${API}/h5/preview.html?token=${token}`;
  const topItems = pendingTasks.slice(0, 5);
  const count = pendingTasks.length;
  const lines = [
    `### 缺货补品推送 · ${PILOT_STORE_NAME}`,
    `**${count} 件商品待处理**`,
    '',
    ...topItems.map((t, i) =>
      `${i + 1}. ${t.item_name} · 昨日${t.yesterday_sales}单 · 库存${t.stock}`
    ),
  ];
  if (count > 5) lines.push('', `… 还有 ${count - 5} 件`);
  lines.push('', '> 点击下方按钮一键处理');

  const cardBody = {
    msgtype: 'actionCard',
    actionCard: {
      title: `推送: 缺货补品 · ${PILOT_STORE_NAME} · ${count}件`,
      text: lines.join('\n'),
      singleTitle: '📱 打开补品清单',
      singleURL: h5Url,
    },
    at: { atUserIds: [PILOT_DING_ID], isAtAll: false },
  };

  const pushRes = await request('POST', WEBHOOK, cardBody);
  if (pushRes.data.errcode === 0) {
    console.log(`[cron-push-v2] ✅ 成功推送 ${count} 件缺货商品到钉钉群`);
  } else {
    console.error(`[cron-push-v2] ❌ 推送失败:`, pushRes.data.errmsg);
  }
}

// ============ main ============
async function main() {
  console.log(`[cron-push-v2] ${new Date().toISOString()} 开始执行`);
  console.log(`[cron-push-v2] API: ${API}`);

  // 解析参数
  const args = process.argv.slice(2);
  const kunlunJsonIdx = args.indexOf('--kunlun-json');
  const kunlunJson = kunlunJsonIdx >= 0 ? args[kunlunJsonIdx + 1] : null;

  if (kunlunJson) {
    // 完整闭环：kunlun 实时数据 → 同步 → 推送
    if (!fs.existsSync(kunlunJson)) {
      console.error(`[cron-push-v2] kunlun 数据文件不存在: ${kunlunJson}`);
      console.log('[cron-push-v2] 降级: 推送现有 PENDING 任务');
    } else {
      const ok = await syncFromKunlun(kunlunJson);
      if (!ok) {
        console.log('[cron-push-v2] kunlun 同步失败，降级推送现有 PENDING');
      }
    }
  } else {
    console.log('[cron-push-v2] 模式: 推送已有 PENDING (无 --kunlun-json 参数)');
  }

  // 无论是否同步成功，都尝试推送
  await pushPending();
}

main().catch(e => {
  console.error('[cron-push-v2] 执行异常:', e.message);
  process.exit(1);
});
