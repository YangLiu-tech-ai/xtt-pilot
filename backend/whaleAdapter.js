/**
 * 鲸品云适配器 - 三档模式
 *
 *   dry      (默认): 仅记录批次 JSONL，不调真实鲸品云。立即返回成功 → task DONE，
 *                  生产排盘后用 scripts/build-batch-xlsx.js 转 Excel，人工审核后再上架。
 *                  ★ 默认模式 = 绝不动真实数据。
 *   simulate         : 老的随机 80% 成功桩 (XTT001 强制失败演示@课长链路)，给状态机自测用。
 *   real             : D2.5 之后再开。当前直接抛错，避免误触。
 *
 * 环境变量：
 *   WHALE_MODE=dry|simulate|real      (默认 dry)
 *   WHALE_BATCH_DIR=...               (默认 ../outputs/whale-batches，自动按 YYYY-MM-DD 分目录)
 *
 * 调用方 (worker.js)：
 *   const { executeOnWhale } = require('../backend/whaleAdapter');
 *   const r = await executeOnWhale(task); // {ok, error?, batchFile?, entry?}
 */
const fs = require('fs');
const path = require('path');

const MODE = (process.env.WHALE_MODE || 'dry').toLowerCase();
const BATCH_DIR = process.env.WHALE_BATCH_DIR
  || path.resolve(__dirname, '..', 'whale-batches');

function todayLocal() {
  // CST 日期: YYYY-MM-DD
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function ensureBatchDir() {
  const day = todayLocal();
  const dir = path.join(BATCH_DIR, day);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function batchFileFor(task) {
  // 一店一动作一文件 → 后续转 Excel 时按"门店+动作"独立批次
  const dir = ensureBatchDir();
  const fname = `${task.store_id}.${task.action || 'shelf'}.jsonl`;
  return path.join(dir, fname);
}

function writeBatchRow(task) {
  const file = batchFileFor(task);
  const entry = {
    ts: new Date().toISOString(),
    task_id: task.id,
    store_id: task.store_id,
    sku: task.sku,
    barcode: task.barcode,
    item_name: task.item_name,
    action: task.action || 'shelf',           // shelf | substitute
    substitute_sku: task.substitute_sku || null,
    actual_price: task.actual_price ?? null,
    retry_count: task.retry_count || 0,
    mode: 'dry',
  };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  return { file, entry };
}

/* === 模式实现 === */

async function executeDry(task) {
  const { file, entry } = writeBatchRow(task);
  return { ok: true, batchFile: file, entry, mode: 'dry' };
}

async function executeSimulate(task) {
  // 老的 simulate 桩：XTT001 强制失败，其余 80% 成功
  if (task.sku === 'XTT001') {
    return { ok: false, error: '鲸品云 SKU 校验失败：商品不存在', mode: 'simulate' };
  }
  const ok = ((task.id * 9301 + 49297) % 233280) / 233280 < 0.8;  // 准随机但可复现
  return ok
    ? { ok: true, mode: 'simulate' }
    : { ok: false, error: '鲸品云页面超时', mode: 'simulate' };
}

async function executeReal(task) {
  // 真实接入留到 D2.5：需要浏览器 MCP + Excel 模板填充 + DataTransfer 注入
  // 当前直接拒绝，避免任何意外触达真实鲸品云
  throw new Error(
    'WHALE_MODE=real is locked. Use dry to generate batch file, ' +
    'review Excel via scripts/build-batch-xlsx.js, then trigger whale skill manually.'
  );
}

async function executeOnWhale(task) {
  switch (MODE) {
    case 'simulate': return executeSimulate(task);
    case 'real':     return executeReal(task);
    case 'dry':
    default:         return executeDry(task);
  }
}

console.log(`[whaleAdapter] mode=${MODE} batchDir=${BATCH_DIR}`);

module.exports = { executeOnWhale, MODE, BATCH_DIR };
