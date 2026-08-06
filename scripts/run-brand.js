#!/usr/bin/env node
/**
 * run-brand.js — 品牌级编排器（多品牌多账号安全隔离）
 *
 * 用法:
 *   node run-brand.js --brand <brandKey> [--dry-run]
 *
 * 流程:
 *   1. 从 brands-config.json 读取品牌配置（含 kunlunCredKey / whale credentialKey / 门店 / webhook）
 *   2. 从 kunlun-credentials.json 读取昆仑凭证（eleKunlunToken + cookieFile）
 *   3. 生成临时 stores_<brand>.json（该品牌的门店列表）
 *   4. 调用 fetch_store_items.py，注入该品牌昆仑 token + cookie
 *   5. 调用 cron-push-v2.js，注入该品牌 webhook + monitor 文件
 *
 * 保证:
 *   - 品牌间凭证完全隔离，绝不共用 token / cookie
 *   - 每个品牌一次调用只处理自己的门店
 *   - webhook 从配置读取，避免硬编码错群
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { probeToken, syncCookieFromToken } = require('./probe-kunlun-token');

// ============ 参数 ============
const argv = process.argv.slice(2);
function getArg(flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const brandKey = getArg('--brand', null);
const dryRun = argv.includes('--dry-run');
// 取数口径：默认"条码定向查询"(--barcode-mode)，用 mixedBarCodeOrId 逐条码直查，
//   比全量翻页快 6.4x，且能检出下架品。TOKEN_EXPIRED 时自动兜底回退全量扫描。
//   加 --on-shelf-only 可切换"仅拉在架"(status[0,1])，此时不走条码模式。
const onShelfOnly = argv.includes('--on-shelf-only');
// 监控时段：兴勤分 9/16/19 点推送不同清单；不传则按当前北京时间自动判断
const monitorTime = getArg('--monitor-time', null);

if (!brandKey) {
  console.error('❌ 用法: node run-brand.js --brand <brandKey> [--dry-run] [--on-shelf-only] [--monitor-time 9|16|19|auto]');
  console.error('   默认条码定向查询(--barcode-mode)；加 --on-shelf-only 切换仅拉在架');
  console.error('   --monitor-time: 兴勤分时段清单；不传时按当前时间自动判断(8点→9, 15点→16, 18点→19)');
  process.exit(1);
}

// 按当前北京时间推断监控时段
function inferMonitorTime() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const hour = now.getUTCHours();
  if (hour === 8) return '9';
  if (hour === 15) return '16';
  if (hour === 18) return '19';
  return null;
}

const effectiveMonitorTime = monitorTime === 'auto' ? inferMonitorTime() : monitorTime;

// ============ 配置加载 ============
const SCRIPTS_DIR = __dirname;
const BRANDS_CONFIG = path.join(SCRIPTS_DIR, 'brands-config.json');
const KUNLUN_CREDS = path.join(SCRIPTS_DIR, 'kunlun-credentials.json');

// 根据品牌和时段选择监控清单文件；分时段文件不存在时回退到主文件
// 当前仅兴勤(xq)开启分时段清单
function resolveMonitorFile(brand) {
  const baseFile = brand.monitorFile;
  if (!effectiveMonitorTime || brandKey !== 'xq') {
    return baseFile;
  }
  const slotFile = baseFile.replace(/\.json$/, `-${effectiveMonitorTime}.json`);
  const slotPath = path.join(SCRIPTS_DIR, slotFile);
  if (fs.existsSync(slotPath)) {
    console.log(`[orchestrator] 使用分时段清单: ${slotFile} (时段=${effectiveMonitorTime}点)`);
    return slotFile;
  }
  console.warn(`[orchestrator] 分时段清单不存在: ${slotFile}，回退到 ${baseFile}`);
  return baseFile;
}

// token JSON 文件与 kunlunCredKey 的映射（按品牌隔离，与 cron harvest 目标一致）
const TOKEN_FILE_MAP = {
  'csnc-kunlun': path.join(SCRIPTS_DIR, '..', 'kunlun-token.json'),
  'xq-kunlun': path.join(SCRIPTS_DIR, '..', 'kunlun-token-xq.json'),
};

const brandsConfig = JSON.parse(fs.readFileSync(BRANDS_CONFIG, 'utf8'));
const kunlunCreds = JSON.parse(fs.readFileSync(KUNLUN_CREDS, 'utf8'));

const brand = brandsConfig.brands[brandKey];
if (!brand) {
  console.error(`❌ 品牌 [${brandKey}] 不存在于 brands-config.json`);
  console.error(`   可用品牌: ${Object.keys(brandsConfig.brands).join(', ')}`);
  process.exit(1);
}

const kunlunCred = kunlunCreds.credentials[brand.kunlunCredKey];
if (!kunlunCred) {
  console.error(`❌ 昆仑凭证 [${brand.kunlunCredKey}] 不存在于 kunlun-credentials.json`);
  process.exit(1);
}

// 按品牌和时段解析最终监控清单文件名（兴勤分时段）
const effectiveMonitorFile = resolveMonitorFile(brand);

console.log(`\n=========== 品牌 [${brandKey}] ${brand.brandName} ===========`);
console.log(`昆仑凭证: ${brand.kunlunCredKey}`);
console.log(`鲸品云凭证: ${brand.credentialKey}`);
console.log(`门店数: ${brand.stores.length}`);
console.log(`Webhook 关键词: ${brand.dingtalkKeyword}`);
console.log(`Monitor: ${effectiveMonitorFile}${effectiveMonitorTime ? ` (时段=${effectiveMonitorTime}点)` : ''}`);
console.log(`取数口径: ${onShelfOnly ? '仅拉在架(status[0,1],加--on-shelf-only开启)' : '条码定向查询(--barcode-mode,默认)'}\n`);

// ============ 校验昆仑 cookie 文件存在 ============
const cookieFilePath = path.resolve(SCRIPTS_DIR, kunlunCred.cookieFile);
if (!fs.existsSync(cookieFilePath)) {
  console.error(`❌ 昆仑 cookie 文件不存在: ${cookieFilePath}`);
  console.error(`   请先从浏览器提取 cookie 保存到该路径（含 _m_h5_tk，约 2 小时有效）`);
  process.exit(1);
}

// ============ 校验昆仑 token 服务端活性（兜底：cookie 文件可能只是旧值） ============
const tokenFile = TOKEN_FILE_MAP[brand.kunlunCredKey];
if (!tokenFile) {
  console.error(`❌ 未配置 token 文件映射: ${brand.kunlunCredKey}`);
  process.exit(1);
}

// ============ 从 token 文件读取 ssot（唯一凭证源，harvest 任务直接写入此文件） ============
// 解决 kunlun-credentials.json 中 eleKunlunToken 与 token 文件脱节的问题
let tokenJsonSsot = null;
try {
  const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8').replace(/^\uFEFF/, ''));
  tokenJsonSsot = tokenData.ssot || null;
} catch (e) { /* 探活阶段会再报错，这里不阻断 */ }

const effectiveSsot = tokenJsonSsot || kunlunCred.eleKunlunToken;
if (tokenJsonSsot && kunlunCred.eleKunlunToken && tokenJsonSsot !== kunlunCred.eleKunlunToken) {
  console.log(`[orchestrator] ⚠ ssot 不一致: token文件=${tokenJsonSsot.slice(0, 12)}... vs credentials=${kunlunCred.eleKunlunToken.slice(0, 12)}...`);
  console.log(`[orchestrator]   → 以 token 文件为准（harvest 目标），建议同步更新 kunlun-credentials.json`);
}

async function ensureKunlunTokenAlive() {
  const firstStore = brand.stores[0];
  if (!firstStore) {
    throw new Error('品牌没有配置门店，无法探活');
  }
  console.log(`[orchestrator] 服务端 token 探活: ${brand.kunlunCredKey} (seller=${firstStore.sellerId}, store=${firstStore.storeId})`);

  let result = await probeToken(tokenFile, firstStore.sellerId, firstStore.storeId);

  // 如果服务端明确拒绝 token，尝试用 token JSON 重新同步 cookie 后再探一次
  if (!result.ok && result.token) {
    console.log(`[orchestrator] token 服务端拒绝，尝试从 ${path.basename(tokenFile)} 同步 cookie 后重试`);
    try {
      syncCookieFromToken(tokenFile, cookieFilePath);
      console.log(`[orchestrator] cookie 已同步到: ${cookieFilePath}`);
      result = await probeToken(tokenFile, firstStore.sellerId, firstStore.storeId);
    } catch (e) {
      throw new Error(`cookie 同步失败: ${e.message}`);
    }
  }

  if (!result.ok) {
    throw new Error(`昆仑 token 探活失败: ${result.err || JSON.stringify(result.ret)}`);
  }
  console.log(`[orchestrator] ✓ token 服务端探活通过`);
}

(async function main() {
  // ============ 生成品牌专属 stores 文件 ============
  const storesFile = path.join(SCRIPTS_DIR, `stores_${brandKey}.json`);
  const storesData = brand.stores.map(s => ({
    name: s.name, wid: s.wid, storeId: s.storeId, sellerId: s.sellerId,
  }));
  fs.writeFileSync(storesFile, JSON.stringify(storesData, null, 2), 'utf8');
  console.log(`[orchestrator] 写入门店配置: ${storesFile} (${storesData.length} 家)`);

  // 取数前先做服务端探活，避免本地 h5tk 时间戳显示新鲜但服务端已拒
  // SKIP_PROBE=1 可临时跳过探活（适用于探活接口瞬时抖动但取数正常的场景）
  if (!dryRun && !process.env.SKIP_PROBE) {
    await ensureKunlunTokenAlive();
  } else {
    console.log(`[orchestrator] [${dryRun ? 'DRY-RUN' : 'SKIP_PROBE'}] 跳过服务端 token 探活`);
  }

  // ============ Step 1: 调用 fetch_store_items.py ============
  const itemsFile = path.join(SCRIPTS_DIR, `items_${brandKey}.json`);
  const FETCH_SCRIPT = path.join(
    process.env.QODER_HOME || 'C:/Users/eleme/.qoderwork',
    'skills', 'kunlun-store-monitor-api', 'scripts', 'fetch_store_items.py'
  );

  console.log(`\n[orchestrator] === Step 1: 昆仑取数 ===`);
  console.log(`  script: ${FETCH_SCRIPT}`);
  console.log(`  token:  ${effectiveSsot.slice(0, 12)}... (${brand.kunlunCredKey}, source=${tokenJsonSsot ? 'token-file' : 'credentials-fallback'})`);
  console.log(`  cookie: ${cookieFilePath}`);
  console.log(`  output: ${itemsFile}`);

  if (!dryRun) {
    const fetchArgs = [
      FETCH_SCRIPT,
      '--config', storesFile,
      '--cookie', cookieFilePath,
      '--kunlun-token', effectiveSsot,
      '--output', itemsFile,
      '--page-workers', '1',
      '--store-workers', '1',
      '--verify-barcodes', path.join(SCRIPTS_DIR, effectiveMonitorFile),
    ];
    if (onShelfOnly) fetchArgs.push('--on-shelf-only');  // 仅拉在架，下架品由差集兜底
    // 条码定向查询模式（默认启用，比全量翻页快6.4x，且能检出下架品）
    // TOKEN_EXPIRED 时 fetch_store_items.py 会自动兜底回退全量扫描
    if (!onShelfOnly) {
      fetchArgs.push('--barcode-mode', path.join(SCRIPTS_DIR, effectiveMonitorFile));
    }
    const fetchRes = spawnSync('python', fetchArgs, { stdio: 'inherit' });

    if (fetchRes.status !== 0) {
      console.error(`\n❌ fetch_store_items.py 执行失败，退出码 ${fetchRes.status}`);
      process.exit(fetchRes.status || 2);
    }
  } else {
    console.log(`  [DRY-RUN] 跳过实际执行`);
  }

  // ============ Step 2: 调用 cron-push-v2.js ============
  const monitorFile = path.join(SCRIPTS_DIR, effectiveMonitorFile);
  if (!fs.existsSync(monitorFile)) {
    console.error(`❌ 监控清单文件不存在: ${monitorFile}`);
    process.exit(3);
  }

  console.log(`\n[orchestrator] === Step 2: 缺货筛选 + 钉钉推送 + sync-render ===`);
  console.log(`  webhook: ${brand.dingtalkWebhook.slice(0, 60)}...`);
  console.log(`  monitor: ${monitorFile}`);

  const pushArgs = [
    path.join(SCRIPTS_DIR, 'cron-push-v2.js'),
    '--items', itemsFile,
    '--monitor', monitorFile,
  ];
  // ⚠️ --sync-render 必传：cron-push-v2.js 要求 Render 任务创建成功后才推送钉钉卡片。
  //   重试/应急路径也必须传此参数，否则课长 H5 操作会 404 NOT_FOUND。
  pushArgs.push('--sync-render');
  if (dryRun) pushArgs.push('--dry-run');

  if (!dryRun) {
    const pushRes = spawnSync('node', pushArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        DING_WEBHOOK: brand.dingtalkWebhook,   // 关键：品牌专属 webhook，杜绝硬编码错群
      },
    });
    if (pushRes.status !== 0) {
      console.error(`\n❌ cron-push-v2.js 执行失败，退出码 ${pushRes.status}`);
      process.exit(pushRes.status || 4);
    }
  } else {
    console.log(`  [DRY-RUN] 命令: node ${pushArgs.join(' ')}`);
    console.log(`  [DRY-RUN] DING_WEBHOOK=${brand.dingtalkWebhook.slice(0, 60)}...`);
  }

  console.log(`\n[orchestrator] 🏁 品牌 [${brandKey}] 处理完成\n`);
})().catch(e => {
  console.error(`\n❌ run-brand 失败: ${e.message}`);
  process.exit(5);
});
