#!/usr/bin/env node
/**
 * Render.com 启动入口
 * 
 * Render 免费版重启时文件系统重置，所以每次冷启动自动 seed。
 * 启动流程：清理 WAL 锁文件 → seed (如DB空) → 签发 pilot token → 启动 Express
 */

// 清理残留 SQLite WAL/SHM/journal 锁文件，防止 "database is locked" 启动崩溃
const fs = require('fs');
const path = require('path');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'backend', 'mvp.db');
for (const suffix of ['-wal', '-shm', '-journal']) {
  const f = DB_PATH + suffix;
  try { if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(`[render-start] cleaned stale lock file: ${f}`); } } catch (e) { console.warn(`[render-start] failed to clean ${f}:`, e.message); }
}

// 初始化 DB schema（db.js 导入时自动创建表）
const db = require('./backend/db');

// 检查是否需要 seed（默认关闭，避免冷启动覆盖真实推送数据；开发/测试环境显式设 SEED_ON_START=1 才跑）
const count = db.prepare('SELECT COUNT(*) as n FROM tasks').get().n;
const shouldSeed = process.env.SEED_ON_START === '1';
if (count === 0 && shouldSeed) {
  console.log('[render-start] DB 为空且 SEED_ON_START=1，执行 seed...');
  require('./scripts/seed');
} else if (count === 0) {
  console.log('[render-start] DB 为空，未设 SEED_ON_START=1，跳过 seed（生产模式）');
} else {
  console.log(`[render-start] DB 已有 ${count} 条任务，跳过 seed`);
}

// 签发 pilot token 并打印
const { issue } = require('./backend/token');
const pilotToken = issue({ storeId: '1284510785', dingId: 'pilot-manager' });
console.log(`[render-start] Pilot H5: /h5/preview.html?token=${pilotToken}`);

// 启动 server（server.js 内使用 process.env.PORT，Render 会注入）
require('./backend/server');
