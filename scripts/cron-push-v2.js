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
  || 'https://oapi.dingtalk.com/robot/send?access_token=86ff44c61d0eb7877f9db3bef374ab387480e7193764dfc3a98c125711cc48b2';
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

    // 不在 API 中的监控品
    const apiBarcodes = new Set(items.map(i => normalizeBarcode(i.barCode || i.barcode)));
    for (const [bc, info] of monitorMap.entries()) {
      if (apiBarcodes.has(bc)) continue;
      if (info.store_id && info.store_id !== storeId) continue;
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

    if (unattended.length === 0) {
      console.log(`[cron-push-v2] ✅ ${storeName} 全部在架，跳过推送`);
      continue;
    }

    // 5. 可选：同步到 Render
    if (syncRender) {
      const batchId = now.toISOString().slice(0, 16).replace(/[-T:]/g, '').slice(0, 12);
      console.log(`[cron-push-v2] → sync-render (batch=${batchId})`);
      try {
        // 5.1 双保险：先显式清除该门店所有未操作 PENDING（含旧 batch）
        //     即使后端 sync-tasks 已做幂等清理，这里仍保留以防回滚或后端逻辑变更
        const cleanupRes = await post(`${API}/v1/internal/cleanup-pending`, {
          storeId, where: 'all',
        }, { 'X-Internal-Key': INTERNAL_KEY });
        console.log(`[cron-push-v2] cleanup-pending: deleted=${cleanupRes.deleted || 0}`);
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

    // 7. 签发 token + 推送钉钉
    let h5Url = `${API}/h5/preview.html`;
    try {
      const tokenRes = await post(`${API}/v1/auth/issue`, { storeId, dingId: 'push' });
      if (tokenRes.ok && tokenRes.token) {
        h5Url = `${API}/h5/preview.html?token=${tokenRes.token}`;
      }
    } catch (e) {
      console.warn(`[cron-push-v2] token签发失败(非致命): ${e.message}`);
    }

    // 7.1 HQ Magic Link (P2)：为 7 店之一签发对应品牌的 magic-link
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
