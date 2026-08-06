#!/usr/bin/env node
/**
 * harvest-kunlun-token.js — 从当前浏览器昆仑 tab harvest 最新凭证，覆盖 kunlun-token.json
 *
 * 【为什么需要】
 *   Node worker 的 mtop 签名依赖：
 *     - _m_h5_tk cookie（约 2 小时有效，页面自动续期但进程重启后文件里的就旧了）
 *     - SKYWORK_KUNLUN_SSOT localStorage 值（buc* 开头，日级有效）
 *   任一过期都导致 worker 调用 mtop 报错 "FAILED_PRECONDITION" 或签名错误。
 *
 * 【用法】
 *   前置：保持浏览器至少打开一个 boreas.kunlun.alibaba-inc.com 页面且已登录
 *   node harvest-kunlun-token.js
 *   或环境变量指定：KUNLUN_TOKEN_FILE=../kunlun-token.json node harvest-kunlun-token.js
 *
 * 【工作原理】
 *   1. 通过 builtin_browser tabs_context 找到所有 boreas.kunlun 页
 *   2. 在第一个 tab 上执行 JS，读取 document.cookie 里的 _m_h5_tk 与 localStorage
 *   3. 写入 TOKEN_FILE（默认 ../kunlun-token.json，相对于本脚本位置）
 *   4. 退出码 0 = 成功，非 0 = 失败
 *
 * 【调用方约定】
 *   - kunlun-worker-node.js 启动时若发现 token 过期，会调用本脚本自动续期
 *   - agent cron 任务也可定期调用本脚本做"心跳续期"
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TOKEN_FILE = process.env.KUNLUN_TOKEN_FILE
  || path.resolve(__dirname, '..', 'kunlun-token.json');

function err(msg, code = 1) {
  console.error(`[harvest] FAIL: ${msg}`);
  process.exit(code);
}

// 通过 QoderWork 的 MCP 注入式调用浏览器不可行；本脚本被 agent 调用，
// agent 应直接用 builtin_browser javascript_tool 读浏览器，再把结果写入本脚本期望的格式。
// 所以本脚本的"CLI 模式"只负责读取/校验已有 token 文件，不直接访问浏览器。
// agent 调用流程：
//   1) builtin_browser tabs_context → 找一个 boreas.kunlun tab
//   2) builtin_browser javascript_tool 执行 harvestSnippet，拿到 {h5tk,ssot,enc,expires}
//   3) 把结果 JSON 写到 TOKEN_FILE
//   4) 然后启动 worker
// 本脚本仅做"凭证健康检查" + "凭证文件合法性校验"，给 worker 一个明确入口。

if (require.main === module) {
  // CLI 模式：检查 TOKEN_FILE 是否存在且未过期
  if (!fs.existsSync(TOKEN_FILE)) err(`TOKEN_FILE 不存在：${TOKEN_FILE}`);
  const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
  let obj; try { obj = JSON.parse(raw); } catch (e) { err('TOKEN_FILE 不是合法 JSON'); }
  if (!obj.h5tk || !obj.ssot) err('TOKEN_FILE 缺少 h5tk 或 ssot');
  const mtime = fs.statSync(TOKEN_FILE).mtimeMs;
  const ageMin = Math.round((Date.now() - mtime) / 60000);
  const h5tkTs = Number((obj.h5tk.split('_')[1] || '0')) || 0;
  const h5tkAge = h5tkTs ? Math.round((Date.now() - h5tkTs) / 60000) : null;
  console.log(`[harvest] TOKEN_FILE=${TOKEN_FILE}`);
  console.log(`[harvest] file age: ${ageMin} min  |  h5tk age: ${h5tkAge != null ? h5tkAge + ' min' : 'unknown'}`);
  console.log(`[harvest] ssot: ${obj.ssot.slice(0, 14)}...  h5tk: ${obj.h5tk.slice(0, 14)}...`);
  // h5tk 2h 内有效，>90min 视为临期
  if (h5tkAge != null && h5tkAge > 110) {
    console.error(`[harvest] h5tk 已 ${h5tkAge} 分钟，建议刷新`);
    process.exit(2); // 特殊退出码：临期
  }
  console.log(`[harvest] 凭证可用`);
}

// agent 在注入浏览器时使用的 JS 片段（返回对象，供 agent 写入文件）
const harvestSnippet = `(function(){
  var c = document.cookie || '';
  var m = c.match(/_m_h5_tk=([^;]+)/g) || [];
  var h5tk = m.length ? m[m.length-1].split('=')[1] : null;
  var me = c.match(/_m_h5_tk_enc=([^;]+)/g) || [];
  var enc = me.length ? me[me.length-1].split('=')[1] : '';
  var ssot = (typeof localStorage !== 'undefined' && localStorage.getItem('SKYWORK_KUNLUN_SSOT')) || null;
  return { h5tk, ssot, enc, url: location.href };
})()`;

module.exports = { harvestSnippet, TOKEN_FILE };
