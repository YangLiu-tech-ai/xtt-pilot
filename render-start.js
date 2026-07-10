#!/usr/bin/env node
/**
 * Render.com 启动入口
 *
 * 数据持久化在挂载磁盘（DB_PATH，如 /var/data/MVP.db）上。
 *
 * ⚠️ 关键背景：Render 持久磁盘是网络文件系统。
 *    - WAL 模式在网络盘能正常运行（旧版一直如此）。
 *    - 残留 -shm 会让 SQLite 打开时 "database is locked"，所以启动要删它。
 *    - 残留 -wal 是上次未 checkpoint 的写入；直接删会丢这部分数据，
 *      但旧版（只删 -wal/-shm 无转换）跑了很久都稳定能启动。
 *      本版本沿用旧版的极简清理；防丢数据改由 server.js 的定时
 *      checkpoint（每 60 秒）+ 优雅退出（SIGTERM 时 checkpoint）承担，
 *      把"WAL 未落库量"控制在 1 分钟以内。
 *
 * 启动流程（极简，与旧版已验证能跑的行为完全一致）：
 *   1) unlinkSync 删除网络盘上残留的 -wal / -shm / -journal。
 *   2) require db.js（WAL 模式打开；SQLite 自动新建 -shm/-wal）。
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'backend', 'mvp.db');

// —— 极简清理：只删残留 -wal/-shm/-journal，与旧版行为完全一致 ——
for (const f of [DB_PATH + '-wal', DB_PATH + '-shm', DB_PATH + '-journal']) {
  try {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      console.log(`[render-start] cleaned residual: ${f}`);
    }
  } catch (e) {
    console.warn(`[render-start] failed to clean ${f}:`, e.message);
  }
}

// —— 初始化 DB schema（db.js 以 WAL 模式打开）——
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
