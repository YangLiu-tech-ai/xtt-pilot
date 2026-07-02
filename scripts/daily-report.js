#!/usr/bin/env node
/**
 * daily-report.js — 门店操作日报生成器
 *
 * 用法:
 *   node daily-report.js --brand csnc [--date 2026-07-02]
 *
 * 输出:
 *   1) 控制台打印结构化 markdown 日报
 *   2) 写入 outputs/daily-report-<brand>-<date>.md 便于二次核对
 *
 * 说明:
 *   仅生成日报文本文件，供上游脚本（QoderWork cron via 小Q 频道）读取后转发。
 *   本脚本不直接推送到钉钉群，验证阶段全部走小Q发给刘阳。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const argv = process.argv.slice(2);
function getArg(flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const brandKey = getArg('--brand', 'csnc');
const dateArg = getArg('--date', null);

const SCRIPTS_DIR = __dirname;
const BRANDS_CONFIG = path.join(SCRIPTS_DIR, 'brands-config.json');
const API = process.env.MVP_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.MVP_INTERNAL_KEY || 'worker-key-2026-prod';

// 今天（Asia/Shanghai）
function todayCst() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}
const date = dateArg || todayCst();

// 加载品牌配置
const brandsConfig = JSON.parse(fs.readFileSync(BRANDS_CONFIG, 'utf8'));
const brand = brandsConfig.brands[brandKey];
if (!brand) {
  console.error(`❌ 品牌 [${brandKey}] 不存在`);
  process.exit(1);
}

// 简单 https/http GET
function apiGet(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathAndQuery, API);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'x-internal-key': INTERNAL_KEY },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse fail (${res.statusCode}): ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// 状态中文映射
const STATUS_CN = {
  PENDING: '待处理',
  EXECUTING: '执行中',
  DONE: '已完成',
  FAILED: '失败',
  SHORTAGE: '缺货',
  VERIFIED: '已验证',
  MANUAL: '人工',
};
const ACTION_CN = {
  shelf: '上架',
  shortage: '缺货',
  substitute: '替代',
};

function pct(a, b) {
  if (!b) return '0.0%';
  return `${(a * 100 / b).toFixed(1)}%`;
}

(async () => {
  console.log(`[daily-report] 品牌=${brandKey} 日期=${date}`);
  console.log(`[daily-report] API=${API}`);

  // 拉取每店明细
  const perStore = [];
  for (const store of brand.stores) {
    const resp = await apiGet(`/v1/internal/report/tasks-by-store?storeId=${store.wid}&date=${date}`);
    if (!resp.ok) {
      console.error(`❌ 拉取 ${store.name} 失败:`, resp.err);
      continue;
    }
    perStore.push({ store, ...resp });
  }

  // 汇总统计
  const brandTotal = { total: 0, DONE: 0, FAILED: 0, EXECUTING: 0, PENDING: 0, SHORTAGE: 0 };
  const perStoreSummary = [];
  for (const s of perStore) {
    const sum = s.summary || {};
    const line = {
      name: s.store.name,
      wid: s.store.wid,
      whaleShopId: s.store.whaleShopId,
      total: sum.total || 0,
      done: sum.DONE || 0,
      failed: sum.FAILED || 0,
      executing: sum.EXECUTING || 0,
      pending: sum.PENDING || 0,
      shortage: sum.SHORTAGE || 0,
    };
    perStoreSummary.push(line);
    brandTotal.total += line.total;
    brandTotal.DONE += line.done;
    brandTotal.FAILED += line.failed;
    brandTotal.EXECUTING += line.executing;
    brandTotal.PENDING += line.pending;
    brandTotal.SHORTAGE += line.shortage;
  }

  // 组织失败样例
  const failedSamples = [];
  for (const s of perStore) {
    const fails = (s.tasks || []).filter(t => t.status === 'FAILED').slice(0, 5);
    for (const f of fails) {
      failedSamples.push({
        store: s.store.name,
        sku: f.sku,
        barcode: f.barcode,
        name: f.item_name,
        error: f.error_msg,
        retry: f.retry_count,
        whaleShopId: f.whale_shop_id,
      });
    }
  }

  // 生成 markdown
  const lines = [];
  lines.push(`# ${brand.brandName} 门店操作日报`);
  lines.push(``);
  lines.push(`- 日期: ${date}`);
  lines.push(`- 品牌: ${brand.brandName} (${brandKey})`);
  lines.push(`- 生成时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  lines.push(`- 门店数: ${brand.stores.length}`);
  lines.push(``);
  lines.push(`## 一、总览`);
  lines.push(``);
  lines.push(`| 指标 | 数量 | 占比 |`);
  lines.push(`|------|------|------|`);
  lines.push(`| 任务总数 | ${brandTotal.total} | 100.0% |`);
  lines.push(`| 已完成 (DONE) | ${brandTotal.DONE} | ${pct(brandTotal.DONE, brandTotal.total)} |`);
  lines.push(`| 执行中 (EXECUTING) | ${brandTotal.EXECUTING} | ${pct(brandTotal.EXECUTING, brandTotal.total)} |`);
  lines.push(`| 待处理 (PENDING) | ${brandTotal.PENDING} | ${pct(brandTotal.PENDING, brandTotal.total)} |`);
  lines.push(`| 缺货 (SHORTAGE) | ${brandTotal.SHORTAGE} | ${pct(brandTotal.SHORTAGE, brandTotal.total)} |`);
  lines.push(`| 失败 (FAILED) | ${brandTotal.FAILED} | ${pct(brandTotal.FAILED, brandTotal.total)} |`);
  lines.push(``);
  lines.push(`## 二、分门店明细`);
  lines.push(``);
  lines.push(`| 门店 | whaleShopId | 总数 | 已完成 | 执行中 | 待处理 | 缺货 | 失败 |`);
  lines.push(`|------|------------|------|-------|-------|-------|------|------|`);
  for (const s of perStoreSummary) {
    lines.push(`| ${s.name} | ${s.whaleShopId} | ${s.total} | ${s.done} | ${s.executing} | ${s.pending} | ${s.shortage} | ${s.failed} |`);
  }
  lines.push(``);
  if (failedSamples.length) {
    lines.push(`## 三、失败样例（各店最多5条）`);
    lines.push(``);
    lines.push(`| 门店 | 商品 | 条码 | 重试 | 错误 |`);
    lines.push(`|------|------|------|------|------|`);
    for (const f of failedSamples) {
      const err = String(f.error || '').replace(/\|/g, '/').slice(0, 60);
      const name = String(f.name || '').slice(0, 20);
      lines.push(`| ${f.store} | ${name} | ${f.barcode || '-'} | ${f.retry} | ${err} |`);
    }
    lines.push(``);
  }
  lines.push(`## 四、隔离链路校验`);
  lines.push(``);
  lines.push(`本日报由 Render 后端 \`/v1/internal/report/tasks-by-store\` 接口拉取。`);
  lines.push(`每家门店的任务均携带独立 \`whale_shop_id\` + \`credential_key\`，worker 按凭证隔离执行。`);
  lines.push(`各店 whaleShopId 明细见「二、分门店明细」，可与 brands-config.json 逐条比对。`);
  lines.push(``);

  const md = lines.join('\n');
  console.log('\n' + md + '\n');

  // 写入 outputs 便于回溯
  const outDir = path.join(SCRIPTS_DIR, '..', '..', 'outputs');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* ignore */ }
  const outFile = path.join(outDir, `daily-report-${brandKey}-${date}.md`);
  fs.writeFileSync(outFile, md, 'utf8');
  console.log(`[daily-report] 写入: ${outFile}`);

  // 供上游脚本消费的结构化数据
  const json = {
    ok: true,
    brand: brandKey,
    brandName: brand.brandName,
    date,
    generatedAt: new Date().toISOString(),
    summary: brandTotal,
    stores: perStoreSummary,
    failedSamples,
    reportFile: outFile,
    markdown: md,
  };
  const jsonFile = path.join(outDir, `daily-report-${brandKey}-${date}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(json, null, 2), 'utf8');
  console.log(`[daily-report] JSON: ${jsonFile}`);

  process.exit(0);
})().catch((e) => {
  console.error('[daily-report] FATAL:', e.stack || e.message);
  process.exit(2);
});
