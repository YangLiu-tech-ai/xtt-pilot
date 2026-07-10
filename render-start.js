#!/usr/bin/env node
/**
 * Render.com 启动入口
 *
 * 数据持久化在挂载磁盘（DB_PATH，如 /var/data/mvp.db）上。
 * 启动流程：安全恢复 WAL → checkpoint 落库 → seed (仅显式开启时) → 签发 pilot token → 启动 Express
 *
 * ⚠️ 重要教训：绝对不能在启动时删除 `-wal` / `-shm` 文件！
 *    WAL 模式下 `-wal` 保存的是「尚未 checkpoint 进主库的真实写入数据」，
 *    删除它 = 丢掉上次未优雅退出前积压的所有写入（这正是历史数据丢失的根因）。
 *    SQLite 打开数据库时会自动 replay/recover `-wal`，无需也不应手动清理。
 *    只有 rollback 模式遗留的 `-journal`（非 WAL）在确认无进程占用时才可安全清理。
 */

const fs = require('fs');
const path = require('path');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'backend', 'mvp.db');

// 仅清理 rollback 模式遗留的 -journal（WAL 模式不产生该文件；存在通常意味着上次为非 WAL 或异常）。
// 绝不触碰 -wal / -shm，避免丢失未 checkpoint 的数据。
try {
  const journal = DB_PATH + '-journal';
  if (fs.existsSync(journal)) {
    fs.unlinkSync(journal);
    console.log(`[render-start] removed stale rollback journal: ${journal}`);
  }
} catch (e) {
  console.warn('[render-start] failed to remove -journal (non-fatal):', e.message);
}

// 记录启动时是否存在 -wal（用于日志观测：说明上次退出未 checkpoint，数据靠 WAL 恢复）
try {
  if (fs.existsSync(DB_PATH + '-wal')) {
    const walSize = fs.statSync(DB_PATH + '-wal').size;
    console.log(`[render-start] found existing -wal (${walSize} bytes) — SQLite will recover it on open`);
  }
} catch (_) {}

// 初始化 DB schema（db.js 导入时自动创建表，并会 replay -wal）
const db = require('./backend/db');

// 打开后立即做一次 checkpoint，把 WAL 中已恢复的数据合并进主库文件，
// 确保磁盘上的主库 mvp.db 是最新的（截断 WAL）。
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log('[render-start] wal_checkpoint(TRUNCATE) done on startup');
} catch (e) {
  console.warn('[render-start] startup checkpoint failed (non-fatal):', e.message);
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
