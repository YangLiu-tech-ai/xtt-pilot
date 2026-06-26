/**
 * 鲸品云适配器 - 四档模式
 *
 *   dry      (默认): 仅记录批次 JSONL，不调真实鲸品云。立即返回成功 → task DONE，
 *                  生产排盘后用 scripts/build-batch-xlsx.js 转 Excel，人工审核后再上架。
 *                  ★ 默认模式 = 绝不动真实数据。
 *   simulate         : 老的随机 80% 成功桩 (XTT001 强制失败演示@课长链路)，给状态机自测用。
 *   preview          : 模拟真实鲸品云操作全流程，生成操作计划 JSON（导航→搜索→填价→确认前截止），
 *                  输出 whale-preview/ 目录下的 operation plan，供人工审核后决定是否执行 real。
 *                  相当于"走到最后一步但不点提交"。
 *   real             : D2.5 之后再开。当前直接抛错，避免误触。
 *
 * 环境变量：
 *   WHALE_MODE=dry|simulate|preview|real      (默认 dry)
 *   WHALE_BATCH_DIR=...               (默认 ../outputs/whale-batches，自动按 YYYY-MM-DD 分目录)
 *   WHALE_PREVIEW_DIR=...             (默认 ../whale-preview，preview 模式输出)
 *
 * 调用方 (worker.js)：
 *   const { executeOnWhale } = require('../backend/whaleAdapter');
 *   const r = await executeOnWhale(task); // {ok, error?, batchFile?, entry?, plan?}
 */
const fs = require('fs');
const path = require('path');

const MODE = (process.env.WHALE_MODE || 'dry').toLowerCase();
const BATCH_DIR = process.env.WHALE_BATCH_DIR
  || path.resolve(__dirname, '..', 'whale-batches');
const PREVIEW_DIR = process.env.WHALE_PREVIEW_DIR
  || path.resolve(__dirname, '..', 'whale-preview');

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

async function executePreview(task) {
  // 写入批次记录（同 dry）
  const { file, entry } = writeBatchRow(task);
  entry.mode = 'preview';

  // 生成鲸品云操作计划（模拟真实操作流程到最后一步）
  const plan = {
    mode: 'preview',
    generated_at: new Date().toISOString(),
    task_id: task.id,
    store_id: task.store_id,
    sku: task.sku,
    barcode: task.barcode,
    item_name: task.item_name,
    action: task.action || 'shelf',
    target_price: task.actual_price,
    substitute_sku: task.substitute_sku || null,

    // 鲸品云操作步骤（模拟）
    steps: [
      {
        step: 1,
        action: 'navigate',
        url: 'https://whale.tmall.com/',
        description: '打开鲸品云首页',
        status: 'simulated',
      },
      {
        step: 2,
        action: 'select_store',
        store_id: task.store_id,
        description: `切换到门店: ${task.store_id}`,
        status: 'simulated',
      },
      {
        step: 3,
        action: 'search_item',
        query: task.barcode || task.sku,
        description: `搜索商品: ${task.barcode} (${task.item_name})`,
        status: 'simulated',
      },
      {
        step: 4,
        action: task.action === 'substitute' ? 'add_substitute' : 'set_shelf',
        detail: task.action === 'substitute'
          ? { substitute_sku: task.substitute_sku, price: task.actual_price }
          : { price: task.actual_price, quantity: 999 },
        description: task.action === 'substitute'
          ? `设置替代品: ${task.substitute_sku}, 定价 ¥${task.actual_price}`
          : `设置上架: 定价 ¥${task.actual_price}, 库存 999`,
        status: 'simulated',
      },
      {
        step: 5,
        action: 'review_confirm_page',
        description: '进入确认页面，核对商品信息、价格、库存',
        status: 'simulated',
      },
      {
        step: 6,
        action: '⛔ STOP_BEFORE_SUBMIT',
        description: '★ 停止：不点击"确认提交"按钮。等待人工审核后再执行 real 模式。',
        status: 'BLOCKED',
      },
    ],

    // 人工审核清单
    review_checklist: [
      `确认商品: ${task.item_name} (${task.barcode})`,
      `确认门店: ${task.store_id}`,
      `确认价格: ¥${task.actual_price}`,
      task.action === 'substitute' ? `确认替代品: ${task.substitute_sku}` : '确认操作: 上架',
      '确认后将 WHALE_MODE 切换为 real 并重新执行',
    ],
  };

  // 输出 preview plan 文件
  const previewDir = path.join(PREVIEW_DIR, todayLocal());
  fs.mkdirSync(previewDir, { recursive: true });
  const planFile = path.join(previewDir, `${task.id}_${task.store_id}_${task.barcode}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), 'utf8');

  console.log(`[whaleAdapter:preview] plan written → ${planFile}`);
  return { ok: true, mode: 'preview', batchFile: file, planFile, plan };
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
    case 'preview':  return executePreview(task);
    case 'real':     return executeReal(task);
    case 'dry':
    default:         return executeDry(task);
  }
}

console.log(`[whaleAdapter] mode=${MODE} batchDir=${BATCH_DIR} previewDir=${PREVIEW_DIR}`);

module.exports = { executeOnWhale, MODE, BATCH_DIR, PREVIEW_DIR };
