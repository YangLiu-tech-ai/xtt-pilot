#!/usr/bin/env node
/**
 * 把 worker 在 dry 模式下写的 JSONL 批次文件 → 转成鲸品云官方模板的 CSV
 *
 * 用法：
 *   node scripts/build-batch-xlsx.js [date]
 *   node scripts/build-batch-xlsx.js 2026-06-25
 *
 * 输入：whale-batches/YYYY-MM-DD/{store_id}.{action}.jsonl  (worker dry 写入)
 * 输出：whale-batches/YYYY-MM-DD/_review/{store_id}.{action}.csv  (UTF-8 BOM)
 *
 * Excel 列：SKU编码（条码） / 门店ID / 上下架状态（1=上架, 0=下架）/ 备注
 *
 * ★ 这一步纯本地，依然不动真实数据。
 *   产物给人工 review，确认无误后再去 SKILL 走鲸品云批量页。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'whale-batches');
const DATE = process.argv[2] || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

const dayDir = path.join(ROOT, DATE);
if (!fs.existsSync(dayDir)) {
  console.error(`[build-batch] ❌ no batch dir for date ${DATE}: ${dayDir}`);
  process.exit(1);
}

const reviewDir = path.join(dayDir, '_review');
fs.mkdirSync(reviewDir, { recursive: true });

// 已知门店ID映射（来自 whale skill 的 SKILL.md + seed.js 试点店）
// 真实接入时门店ID取自鲸品云模板 Sheet2，这里先硬编码已知的，并在缺失时给警告
const KNOWN_STORE_IDS = {
  '1284510785': '182574953695397',     // 淘小胖龙湖 (临淮店模板中的 store_id)
  // TODO: 兴勤陈江/港惠、成山天街/京东MALL、淘小胖荥阳/宝龙
};

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const files = fs.readdirSync(dayDir).filter(f => f.endsWith('.jsonl'));
if (!files.length) {
  console.log(`[build-batch] no JSONL batches in ${dayDir}`);
  process.exit(0);
}

let totalRows = 0;
const summary = [];

for (const f of files) {
  const lines = fs.readFileSync(path.join(dayDir, f), 'utf8')
    .split('\n').filter(Boolean);
  if (!lines.length) continue;

  const rows = lines.map(l => JSON.parse(l));
  const sample = rows[0];
  const storeId = sample.store_id;
  const action = sample.action || 'shelf';
  const whaleStatus = action === 'shelf' || action === 'substitute' ? 1 : 0;  // shelf/substitute=上架, shortage=下架
  const whaleStoreId = KNOWN_STORE_IDS[storeId] || `<未配置-原始ID=${storeId}>`;

  // 去重 by barcode (worker 多次重试可能写同一条多次)
  const seen = new Set();
  const dedup = rows.filter(r => {
    const key = r.barcode || r.sku;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 替代品场景：用 substitute_sku 而非原 SKU
  const csvRows = dedup.map(r => ({
    sku_code: r.action === 'substitute' && r.substitute_sku ? r.substitute_sku : (r.barcode || r.sku),
    store_id: whaleStoreId,
    status: whaleStatus,
    remark: r.action === 'substitute'
      ? `替代品（原 ${r.sku}）`
      : (r.item_name || ''),
    item_name: r.item_name,           // 仅审核辅助列
    task_id: r.task_id,
    original_sku: r.sku,
  }));

  // 写 CSV (UTF-8 BOM 兼容 Excel 中文)
  const out = path.join(reviewDir, f.replace(/\.jsonl$/, '.csv'));
  const header = ['SKU编码', '门店ID', '上下架状态(1上0下)', '备注', '__商品名(审核列)', '__task_id', '__原SKU'].join(',');
  const body = csvRows.map(r => [
    csvEscape(r.sku_code), csvEscape(r.store_id), csvEscape(r.status),
    csvEscape(r.remark), csvEscape(r.item_name), csvEscape(r.task_id), csvEscape(r.original_sku),
  ].join(',')).join('\n');
  fs.writeFileSync(out, '\ufeff' + header + '\n' + body + '\n', 'utf8');

  totalRows += csvRows.length;
  summary.push({
    file: f,
    storeId, whaleStoreId,
    action, whaleStatus,
    rows: csvRows.length,
    csv: out,
    warn: whaleStoreId.startsWith('<未配置') ? '⚠️ 门店ID未映射' : null,
  });
}

console.log('\n=== [build-batch] 批次审核 CSV 已生成 ===\n');
summary.forEach(s => {
  console.log(`📦 ${s.file}`);
  console.log(`   门店: ${s.storeId} → 鲸品云 ID: ${s.whaleStoreId}`);
  console.log(`   动作: ${s.action} (whale status=${s.whaleStatus})`);
  console.log(`   条数: ${s.rows}`);
  console.log(`   CSV : ${s.csv}`);
  if (s.warn) console.log(`   ${s.warn}`);
  console.log('');
});
console.log(`Total rows: ${totalRows}\n`);
console.log('★ 下一步（人工）：审核 _review/*.csv → 拷贝条码列粘入鲸品云模板 Sheet1 → 上传');
console.log('  或调用 whale-batch-shelf-upload skill 完成自动化注入。');
