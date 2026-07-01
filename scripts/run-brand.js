#!/usr/bin/env node
/**
 * run-brand.js — 品牌级编排器（多品牌多账号安全隔离）
 *
 * 用法:
 *   node run-brand.js --brand <brandKey> [--dry-run] [--no-sync-render]
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

// ============ 参数 ============
const argv = process.argv.slice(2);
function getArg(flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const brandKey = getArg('--brand', null);
const dryRun = argv.includes('--dry-run');
const skipSync = argv.includes('--no-sync-render');

if (!brandKey) {
  console.error('❌ 用法: node run-brand.js --brand <brandKey> [--dry-run] [--no-sync-render]');
  process.exit(1);
}

// ============ 配置加载 ============
const SCRIPTS_DIR = __dirname;
const BRANDS_CONFIG = path.join(SCRIPTS_DIR, 'brands-config.json');
const KUNLUN_CREDS = path.join(SCRIPTS_DIR, 'kunlun-credentials.json');

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

console.log(`\n=========== 品牌 [${brandKey}] ${brand.brandName} ===========`);
console.log(`昆仑凭证: ${brand.kunlunCredKey}`);
console.log(`鲸品云凭证: ${brand.credentialKey}`);
console.log(`门店数: ${brand.stores.length}`);
console.log(`Webhook 关键词: ${brand.dingtalkKeyword}`);
console.log(`Monitor: ${brand.monitorFile}\n`);

// ============ 校验昆仑 cookie 文件存在 ============
const cookieFilePath = path.resolve(SCRIPTS_DIR, kunlunCred.cookieFile);
if (!fs.existsSync(cookieFilePath)) {
  console.error(`❌ 昆仑 cookie 文件不存在: ${cookieFilePath}`);
  console.error(`   请先从浏览器提取 cookie 保存到该路径（含 _m_h5_tk，约 2 小时有效）`);
  process.exit(1);
}

// ============ 生成品牌专属 stores 文件 ============
const storesFile = path.join(SCRIPTS_DIR, `stores_${brandKey}.json`);
const storesData = brand.stores.map(s => ({
  name: s.name, wid: s.wid, storeId: s.storeId, sellerId: s.sellerId,
}));
fs.writeFileSync(storesFile, JSON.stringify(storesData, null, 2), 'utf8');
console.log(`[orchestrator] 写入门店配置: ${storesFile} (${storesData.length} 家)`);

// ============ Step 1: 调用 fetch_store_items.py ============
const itemsFile = path.join(SCRIPTS_DIR, `items_${brandKey}.json`);
const FETCH_SCRIPT = path.join(
  process.env.QODER_HOME || 'C:/Users/eleme/.qoderwork',
  'skills', 'kunlun-store-monitor-api', 'scripts', 'fetch_store_items.py'
);

console.log(`\n[orchestrator] === Step 1: 昆仑取数 ===`);
console.log(`  script: ${FETCH_SCRIPT}`);
console.log(`  token:  ${kunlunCred.eleKunlunToken.slice(0, 12)}... (${brand.kunlunCredKey})`);
console.log(`  cookie: ${cookieFilePath}`);
console.log(`  output: ${itemsFile}`);

if (!dryRun) {
  const fetchRes = spawnSync('python', [
    FETCH_SCRIPT,
    '--config', storesFile,
    '--cookie', cookieFilePath,
    '--kunlun-token', kunlunCred.eleKunlunToken,
    '--output', itemsFile,
    '--page-workers', '3',
    '--store-workers', String(Math.min(6, storesData.length)),
  ], { stdio: 'inherit' });

  if (fetchRes.status !== 0) {
    console.error(`\n❌ fetch_store_items.py 执行失败，退出码 ${fetchRes.status}`);
    process.exit(fetchRes.status || 2);
  }
} else {
  console.log(`  [DRY-RUN] 跳过实际执行`);
}

// ============ Step 2: 调用 cron-push-v2.js ============
const monitorFile = path.join(SCRIPTS_DIR, brand.monitorFile);
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
if (!skipSync) pushArgs.push('--sync-render');
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
