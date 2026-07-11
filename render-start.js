#!/usr/bin/env node
/**
 * Render.com 启动入口
 *
 * 数据持久化在挂载磁盘（DB_PATH，如 /var/data/MVP.db）上。
 *
 * ⚠️ 关键背景与"每次部署删库"根因修复：
 *    旧版 render-start.js 每次启动【无条件删除 -wal】，而 -wal 里正是上次还没
 *    checkpoint 进主库的写入；配合 server.js 曾一度删掉了周期/退出 checkpoint，
 *    结果 WAL 永远没机会落库、重启即被删 → 数据蒸发。这是删库的直接元凶。
 *
 *    本版本（better-sqlite3 原生驱动）改为：
 *      - 绝不删除 -wal / -shm / -journal。better-sqlite3 打开 WAL 库时会自动把
 *        -wal 里的已提交数据恢复/应用，SQLite 自身保证一致性。
 *      - 打开后主动做一次 wal_checkpoint(TRUNCATE)，把 -wal 合并进主库并截断，
 *        原生驱动在 Render 网络盘上可安全执行（这正是换驱动的目的）。
 *      - 运行期与退出时的落库由 server.js 的 PASSIVE checkpoint 承担。
 */

const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'backend', 'mvp.db');

// —— 不再删除任何 -wal/-shm/-journal 残留（删 -wal 会丢未落库数据，是历史删库根因）——
console.log('[render-start] WAL 安全模式：不删除 -wal/-shm/-journal，由 SQLite 自行恢复');

// —— 初始化 DB schema（db.js 以 WAL 模式打开；会自动恢复 -wal 中已提交数据）——
const db = require('./backend/db');

// —— 启动时把 WAL 合并进主库并截断（原生驱动在网络盘上可安全 TRUNCATE）——
try {
  const r = db.pragma('wal_checkpoint(TRUNCATE)');
  console.log('[render-start] 启动 checkpoint(TRUNCATE) 完成:', JSON.stringify(r));
} catch (e) {
  console.warn('[render-start] 启动 checkpoint 失败(非致命，继续):', e.message);
}

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
