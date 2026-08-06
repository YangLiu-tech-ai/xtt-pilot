#!/usr/bin/env node
/**
 * sync-ssot.js — 将浏览器最新 ssot 同步到 token 文件
 *
 * 用法:
 *   node scripts/sync-ssot.js --ssot <newSsot> [--token kunlun-token.json,kunlun-token-xq.json]
 *
 * 逻辑:
 *   1. 读取 --ssot 参数（由 cron agent 从浏览器 localStorage 获取）
 *   2. 逐个读取 token 文件，比对 ssot 字段
 *   3. 若不同，仅更新 ssot 字段（保留 h5tk/enc 不动），写回文件
 *   4. 输出同步结果摘要
 *
 * 退出码:
 *   0 = 成功（含"无需更新"）
 *   1 = 异常
 *   2 = 参数错误
 */
const fs = require('fs');
const path = require('path');

function getArg(argv, flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const argv = process.argv.slice(2);
const newSsot = getArg(argv, '--ssot', '');
const tokenFilesArg = getArg(argv, '--token', 'kunlun-token.json,kunlun-token-xq.json');

if (!newSsot) {
  console.error('[sync-ssot] 缺少 --ssot 参数');
  process.exit(2);
}

// 基本校验：ssot 应以 buc 开头，长度 > 20
if (!newSsot.startsWith('buc') || newSsot.length < 20) {
  console.error(`[sync-ssot] ssot 格式异常（应以 buc 开头，长度>20）: ${newSsot.substring(0, 10)}...`);
  process.exit(2);
}

const tokenFiles = tokenFilesArg.split(',').map(f => f.trim());
let updated = 0;
let skipped = 0;
let failed = 0;

for (const file of tokenFiles) {
  const filePath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(filePath)) {
    console.error(`[sync-ssot] 文件不存在，跳过: ${file}`);
    failed++;
    continue;
  }

  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`[sync-ssot] 解析失败，跳过: ${file} (${e.message})`);
    failed++;
    continue;
  }

  if (obj.ssot === newSsot) {
    console.log(`[sync-ssot] ${file}: ssot 一致，无需更新`);
    skipped++;
    continue;
  }

  const oldPrefix = obj.ssot ? obj.ssot.substring(0, 14) : 'null';
  obj.ssot = newSsot;
  obj.ssotSyncedAt = new Date().toISOString();

  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
    console.log(`[sync-ssot] ${file}: ssot 已更新 ${oldPrefix}... → ${newSsot.substring(0, 14)}...`);
    updated++;
  } catch (e) {
    console.error(`[sync-ssot] 写入失败: ${file} (${e.message})`);
    failed++;
  }
}

console.log(`[sync-ssot] 完成: updated=${updated}, skipped=${skipped}, failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
