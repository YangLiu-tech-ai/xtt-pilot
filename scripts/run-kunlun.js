#!/usr/bin/env node
/**
 * run-kunlun.js — 一键 harvest+worker 入口（harvest-before-run 编排）
 *
 * 用法：
 *   node run-kunlun.js                              # 跑当前 token 能覆盖的全部门店
 *   ALLOWED_WIDS=1284510785 node run-kunlun.js      # 只跑淘小胖龙湖
 *   DRY_RUN=1 node run-kunlun.js                    # 预演
 *   SKIP_HARVEST=1 node run-kunlun.js               # 明确跳过临期告警（复用文件里的 token）
 *
 * 【harvest-before-run 编排（P1 修复）】
 *   token 真实生死不看文件 mtime，而看 h5tk 内嵌时间戳（h5tk.split('_')[1]，约 2h 有效）；
 *   更可靠的是 worker 运行时的"探活"——worker 会对每个 sellerId 用一次极低成本 pageQuery 探活，
 *   token 失效的品牌整轮跳过（任务保持 EXECUTING，不误报失败），并以退出码 3 上报 TOKEN_STALE。
 *   本脚本据此分两种结果：
 *     - worker 退出码 0：全部处理完成。
 *     - worker 退出码 3：有品牌 token 失效 → 打印明确的 HARVEST_NEEDED 信号 + 待执行 JS snippet，
 *       agent 应 harvest 覆盖对应 token 文件后，SKIP_HARVEST=1 重跑本脚本。
 *
 * 说明：Node 进程无法直连浏览器，harvest 由 QoderWork agent 用 builtin_browser MCP 完成。
 *   本脚本只负责"凭证健康预检 + 调 worker + 把 harvest 需求明确抛给 agent"。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const TOKEN_FILE = path.resolve(__dirname, '..', 'kunlun-token.json');
const TOKEN_FILE_XQ = process.env.KUNLUN_TOKEN_FILE_XQ || path.resolve(__dirname, '..', 'kunlun-token-xq.json');
const WORKER = path.resolve(__dirname, 'kunlun-worker-node.js');

// h5tk 有效期阈值（分钟）。h5tk 官方约 2h，保守设 90min 视为临期。
const H5TK_STALE_MIN = Number(process.env.H5TK_STALE_MIN) || 90;

function log(msg) { console.log('[run-kunlun]', msg); }
function err(msg, code = 1) { console.error('[run-kunlun] FAIL:', msg); process.exit(code); }

// agent 在浏览器昆仑 tab 上执行的 harvest JS（返回对象供 agent 写入 token 文件）
const HARVEST_SNIPPET = `(function(){
  var c = document.cookie || '';
  var m = c.match(/_m_h5_tk=([^;]+)/g) || [];
  var h5tk = m.length ? m[m.length-1].split('=')[1] : null;
  var me = c.match(/_m_h5_tk_enc=([^;]+)/g) || [];
  var enc = me.length ? me[me.length-1].split('=')[1] : '';
  var ssot = (typeof localStorage !== 'undefined' && localStorage.getItem('SKYWORK_KUNLUN_SSOT')) || null;
  return { h5tk: h5tk, ssot: ssot, enc: enc, url: location.href, ts: Date.now() };
})()`;

// 读取 token 文件并按 h5tk 内嵌时间戳判活（不用文件 mtime——文件新 ≠ token 活）
function inspectToken(file, label) {
  if (!fs.existsSync(file)) return { file, label, exists: false, stale: true, reason: 'missing' };
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return { file, label, exists: true, stale: true, reason: 'bad-json' }; }
  if (!obj.h5tk || !obj.ssot) return { file, label, exists: true, stale: true, reason: 'missing-field' };
  const h5tkTs = Number((obj.h5tk.split('_')[1] || '0')) || 0;
  const h5tkAgeMin = h5tkTs ? Math.round((Date.now() - h5tkTs) / 60000) : null;
  const stale = h5tkAgeMin == null ? false : h5tkAgeMin > H5TK_STALE_MIN;
  return { file, label, exists: true, stale, reason: stale ? `h5tk ${h5tkAgeMin}min(>${H5TK_STALE_MIN})` : 'ok', h5tkAgeMin };
}

// 打印需要 harvest 的明确信号（agent 消费）
function emitHarvestNeeded(reasonLabel, files) {
  log('==================== HARVEST_NEEDED ====================');
  log(`原因：${reasonLabel}`);
  log(`需要重新 harvest 的 token 文件：${files.join(', ')}`);
  log('agent 操作：在对应品牌的 boreas.kunlun.alibaba-inc.com tab 上执行以下 JS，把返回的 {h5tk,ssot,enc} 写入该 token 文件，再 SKIP_HARVEST=1 重跑本脚本：');
  log(HARVEST_SNIPPET);
  log('  - 成山/淘小胖 → ' + TOKEN_FILE);
  log('  - 兴勤       → ' + TOKEN_FILE_XQ);
  log('========================================================');
}

// 1) 运行前 token 健康预检（基于 h5tk 时间戳；真正判活以 worker 探活为准）
const inspections = [inspectToken(TOKEN_FILE, '成山/淘小胖'), inspectToken(TOKEN_FILE_XQ, '兴勤')];
for (const ins of inspections) {
  log(`token[${ins.label}] ${path.basename(ins.file)}: ${ins.exists ? ins.reason : '不存在'}`);
}
const staleFiles = inspections.filter(i => i.stale).map(i => i.file);
if (staleFiles.length && !process.env.SKIP_HARVEST) {
  emitHarvestNeeded('预检发现 token 临期/缺失（h5tk 时间戳判定）', staleFiles);
  if (!process.env.DRY_RUN) err('token 临期且未 SKIP_HARVEST，中止（agent 应 harvest 后重跑）', 3);
}

// 2) 调 worker（worker 会自行探活，token 失效的品牌跳过并以退出码 3 上报）
log(`调用 worker：${WORKER}`);
const env = Object.assign({}, process.env, {
  KUNLUN_TOKEN_FILE: TOKEN_FILE,
  KUNLUN_TOKEN_FILE_XQ: TOKEN_FILE_XQ,
});
const r = spawnSync('node', [WORKER], { stdio: 'inherit', env });

// 3) 结果分流
if (r.status === 3) {
  // worker 探活/中途发现 token 失效 → 明确要求 harvest 后重跑
  emitHarvestNeeded('worker 探活发现有品牌 token 失效（相关任务已保持 EXECUTING，未误报失败）', [TOKEN_FILE, TOKEN_FILE_XQ]);
  err('worker 上报 TOKEN_STALE（退出码3）：harvest 后 SKIP_HARVEST=1 重跑本脚本即可消化剩余任务', 3);
}
if (r.status !== 0) err(`worker 退出 ${r.status}`, r.status || 1);
log('完成');
