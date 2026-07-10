#!/usr/bin/env node
/**
 * Render.com 启动入口
 *
 * 数据持久化在挂载磁盘（DB_PATH，如 /var/data/MVP.db）上。
 *
 * ⚠️ 关键背景：Render 持久磁盘是网络文件系统，SQLite WAL 模式依赖的
 *    -shm 共享内存 mmap 在网络盘上不可靠，会导致启动 "database is locked"。
 *    因此本项目已改用 DELETE journal 模式（见 backend/db.js），不再产生 -wal/-shm。
 *
 * 启动流程：
 *   1) 若网络盘上存在历史 -wal（上一版 WAL 模式遗留、含未落库数据），
 *      拷贝三件套到本地临时盘，用 WAL 打开做 checkpoint 落库，
 *      再切成 DELETE 模式，把合并后的主库拷回网络盘 —— 数据不丢。
 *   2) 删除网络盘上残留的 -wal / -shm / -journal（此时数据已合并进主库）。
 *   3) 正常 require db（DELETE 模式打开）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'backend', 'mvp.db');
const WAL = DB_PATH + '-wal';
const SHM = DB_PATH + '-shm';
const JOURNAL = DB_PATH + '-journal';

// —— 步骤 1：合并历史 -wal（仅当存在且非空时）——
try {
  if (fs.existsSync(WAL) && fs.statSync(WAL).size > 0) {
    console.log(`[render-start] 检测到历史 -wal (${fs.statSync(WAL).size} bytes)，在本地盘安全合并...`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtt-walmerge-'));
    const tmpDb = path.join(tmpDir, 'merge.db');
    // 拷贝三件套到本地盘（本地盘 WAL/shm 正常工作）
    fs.copyFileSync(DB_PATH, tmpDb);
    fs.copyFileSync(WAL, tmpDb + '-wal');
    if (fs.existsSync(SHM)) fs.copyFileSync(SHM, tmpDb + '-shm');
    // 用子进程在本地盘 checkpoint 落库 + 切 DELETE 模式（隔离，避免污染主进程）
    // 注意：node-sqlite3-wasm 安装在 backend/node_modules，故子进程 cwd 设为 backend。
    const mergeScript = `
      const { Database } = require('node-sqlite3-wasm');
      const db = new Database(${JSON.stringify(tmpDb)});
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('PRAGMA journal_mode = DELETE');
      db.close();
      console.log('[wal-merge] merged & switched to DELETE');
    `;
    execFileSync(process.execPath, ['-e', mergeScript], {
      cwd: path.join(__dirname, 'backend'),
      stdio: 'inherit',
    });
    // 合并后的主库拷回网络盘（此时 tmpDb 已是纯主库，无 -wal/-shm）
    fs.copyFileSync(tmpDb, DB_PATH);
    console.log('[render-start] 历史 -wal 已合并进主库并拷回磁盘');
    // 清理本地临时目录
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
} catch (e) {
  console.warn('[render-start] -wal 合并失败（非致命，继续启动）:', e.message);
}

// —— 步骤 2：清理网络盘上残留的 WAL/SHM/journal（数据已合并进主库）——
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
