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
 *   1) 若网络盘上已存在主库文件：把它（连同可能存在的 -wal）拷到本地临时盘，
 *      在本地盘打开、checkpoint 落库、切换 journal_mode=DELETE，
 *      再把转换后的主库拷回网络盘 —— 数据不丢，且主库文件头永久变为 DELETE。
 *      ⚠️ 必须无条件执行（不能只在有 -wal 时才做）：主库文件头一旦是 WAL，
 *         在网络盘上被 db.js 打开的瞬间就会创建 -shm 并 locked。
 *   2) 删除网络盘上残留的 -wal / -shm / -journal。
 *   3) 正常 require db（此时主库已是 DELETE 模式，打开不再需要 -shm）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'backend', 'mvp.db');
const WAL = DB_PATH + '-wal';
const SHM = DB_PATH + '-shm';
const JOURNAL = DB_PATH + '-journal';

// —— 步骤 1：把网络盘主库无条件转换为 DELETE 模式（在本地盘操作，规避网络盘 shm 锁）——
// 只要主库文件存在就执行：因为主库文件头若为 WAL，一旦在网络盘被打开就会 locked。
try {
  if (fs.existsSync(DB_PATH)) {
    const walSize = fs.existsSync(WAL) ? fs.statSync(WAL).size : 0;
    console.log(`[render-start] 主库存在，在本地盘转换为 DELETE 模式（-wal ${walSize} bytes）...`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtt-dbconv-'));
    const tmpDb = path.join(tmpDir, 'conv.db');
    // 拷贝主库 + 可能存在的 -wal/-shm 到本地盘（本地盘 WAL/shm 正常工作）
    fs.copyFileSync(DB_PATH, tmpDb);
    if (fs.existsSync(WAL)) fs.copyFileSync(WAL, tmpDb + '-wal');
    if (fs.existsSync(SHM)) fs.copyFileSync(SHM, tmpDb + '-shm');
    // 子进程在本地盘：checkpoint 落库(若原为WAL) + 切 DELETE 模式(写入文件头)
    // 注意：node-sqlite3-wasm 安装在 backend/node_modules，故子进程 cwd 设为 backend。
    const convScript = `
      const { Database } = require('node-sqlite3-wasm');
      const db = new Database(${JSON.stringify(tmpDb)});
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { console.warn('[db-conv] checkpoint skip:', e.message); }
      db.exec('PRAGMA journal_mode = DELETE');
      const m = db.prepare('PRAGMA journal_mode').get();
      db.close();
      console.log('[db-conv] journal_mode now = ' + JSON.stringify(m));
    `;
    execFileSync(process.execPath, ['-e', convScript], {
      cwd: path.join(__dirname, 'backend'),
      stdio: 'inherit',
    });
    // 转换后的主库拷回网络盘（此时 tmpDb 文件头已是 DELETE，无 -wal/-shm）
    fs.copyFileSync(tmpDb, DB_PATH);
    console.log('[render-start] 主库已转换为 DELETE 模式并拷回磁盘');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  } else {
    console.log('[render-start] 主库不存在（全新部署），db.js 将以 DELETE 模式新建');
  }
} catch (e) {
  console.warn('[render-start] DELETE 模式转换失败（非致命，继续启动）:', e.message);
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
