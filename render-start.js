#!/usr/bin/env node
/**
 * Render.com 启动入口
 *
 * 数据持久化在挂载磁盘（DB_PATH，如 /var/data/MVP.db）上。
 *
 * ⚠️ 关键背景：Render 持久磁盘是网络文件系统。
 *    - DELETE 模式：CREATE TABLE 等写操作要直接锁主库文件，网络盘对该锁支持
 *      不可靠 → 启动即 "database is locked"（实测建表 exec 崩溃）。
 *    - WAL 模式：写入引到 -wal 文件、规避主库文件锁，反而能在网络盘正常运行
 *      （旧版一直如此）。唯一隐患是残留 -shm 会让打开时 locked。
 *    因此策略 = 用 WAL 模式(见 backend/db.js) + 启动时清理残留 -wal/-shm，
 *    但清理 -wal 前先把它 checkpoint 合并进主库，保证未落库数据不丢。
 *
 * 启动流程：
 *   1) 若存在 -wal（含上次未落库数据）：拷主库+-wal 到本地临时盘，checkpoint
 *      落库，再把合并后的主库拷回网络盘 —— 数据不丢。
 *   2) 删除网络盘上残留的 -wal / -shm / -journal（解除网络盘打开时的锁隐患）。
 *   3) require db，以 WAL 模式重新打开（SQLite 自动重建 -shm/-wal）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'backend', 'mvp.db');
const WAL = DB_PATH + '-wal';
const SHM = DB_PATH + '-shm';
const JOURNAL = DB_PATH + '-journal';

// —— 步骤 1：删 -wal 前先把它的数据合并进主库（仅当 -wal 存在且非空）——
try {
  if (fs.existsSync(DB_PATH) && fs.existsSync(WAL) && fs.statSync(WAL).size > 0) {
    console.log(`[render-start] 检测到 -wal (${fs.statSync(WAL).size} bytes)，在本地盘 checkpoint 合并...`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtt-walmerge-'));
    const tmpDb = path.join(tmpDir, 'merge.db');
    fs.copyFileSync(DB_PATH, tmpDb);
    fs.copyFileSync(WAL, tmpDb + '-wal');
    if (fs.existsSync(SHM)) fs.copyFileSync(SHM, tmpDb + '-shm');
    // 子进程在本地盘 checkpoint（本地盘 WAL 正常）；node-sqlite3-wasm 在 backend/node_modules
    const mergeScript = `
      const { Database } = require('node-sqlite3-wasm');
      const db = new Database(${JSON.stringify(tmpDb)});
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      console.log('[wal-merge] checkpoint done');
    `;
    execFileSync(process.execPath, ['-e', mergeScript], {
      cwd: path.join(__dirname, 'backend'),
      stdio: 'inherit',
    });
    // 合并后的主库(已含 -wal 数据)拷回网络盘
    fs.copyFileSync(tmpDb, DB_PATH);
    console.log('[render-start] -wal 数据已合并进主库并拷回磁盘');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
} catch (e) {
  console.warn('[render-start] -wal 合并失败（非致命，继续启动）:', e.message);
}

// —— 步骤 2：清理网络盘残留 -wal/-shm/-journal（数据已在主库；解除打开时 locked 隐患）——
for (const f of [WAL, SHM, JOURNAL]) {
  try {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      console.log(`[render-start] cleaned residual: ${f}`);
    }
  } catch (e) {
    console.warn(`[render-start] failed to clean ${f}:`, e.message);
  }
}

// —— 步骤 3：初始化 DB schema（db.js 以 DELETE 模式打开）——
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
