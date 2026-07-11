/**
 * 新通途·生鲜出勤补品闭环 MVP - 数据库 schema
 * SQLite 单文件 · WAL 模式 · better-sqlite3 原生驱动
 *
 * ⚠️ 驱动说明：本项目从 node-sqlite3-wasm 迁移到 better-sqlite3（原生编译）。
 *    历史根因：node-sqlite3-wasm 用 fs.mkdirSync('xxx.lock') 做 POSIX 兼容文件锁，
 *    Render 持久磁盘(/var/data)是网络文件系统，对该锁机制支持不可靠 → "database is
 *    locked"。为绕过它曾加了一堆 hack（monkey-patch fs.mkdirSync/rmdirSync、"文件<4KB
 *    删库重建"、"锁错误删库重建"），这些 hack 反而在 WAL 未落库时误删数据，是"每次部署
 *    删库"的元凶之一。better-sqlite3 是原生驱动，不使用 .lock 目录锁，在网络盘上可正常
 *    做 WAL checkpoint，故全部删除上述 hack。
 *
 * ⚠️ WAL 落库由 render-start.js（启动时 checkpoint TRUNCATE）+ server.js（周期/退出
 *    PASSIVE checkpoint）负责，本文件不再做任何删库/重建。
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'mvp.db');

// —— 启动前磁盘状态诊断（用于定位 Render 网络盘上数据库问题）——
try {
  const mainExists = fs.existsSync(DB_PATH);
  const walExists = fs.existsSync(DB_PATH + '-wal');
  const shmExists = fs.existsSync(DB_PATH + '-shm');
  const journalExists = fs.existsSync(DB_PATH + '-journal');
  const mainSize = mainExists ? fs.statSync(DB_PATH).size : -1;
  const walSize = walExists ? fs.statSync(DB_PATH + '-wal').size : -1;
  console.log(`[db] driver=better-sqlite3 DB_PATH=${DB_PATH}`);
  console.log(`[db] 磁盘状态: main=${mainSize}B wal=${walExists?walSize+'B':'absent'} shm=${shmExists?'present':'absent'} journal=${journalExists?'present':'absent'}`);
} catch (e) {
  console.warn('[db] disk state inspect failed:', e.message);
}

// —— 打开数据库（原生驱动，绝不删库重建；出错让进程崩掉靠 Render 自动重启）——
let db;
try {
  db = new Database(DB_PATH);
  db.pragma('busy_timeout = 5000');
} catch (e) {
  console.error('[db] 数据库打开失败,无法继续:', e.message);
  process.exit(2);
}

// —— PRAGMA:WAL 必须保持;失败降级为 warning 让启动继续 ——
try {
  const mode = db.pragma('journal_mode = WAL');
  console.log('[db] journal_mode =', JSON.stringify(mode));
} catch (e) {
  console.warn('[db] PRAGMA journal_mode=WAL failed (non-fatal, continuing):', e.message);
}
try {
  db.pragma('foreign_keys = ON');
} catch (e) {
  console.warn('[db] PRAGMA foreign_keys=ON failed (non-fatal, continuing):', e.message);
}

db.exec(`
  /* === 门店表：一对一触达的关键，绑课长钉钉 ID === */
  CREATE TABLE IF NOT EXISTS stores (
    store_id TEXT PRIMARY KEY,
    store_name TEXT NOT NULL,
    brand TEXT NOT NULL,                    -- 淘小胖/兴勤/成山农场
    manager_name TEXT,                      -- 课长姓名
    manager_dingtalk_id TEXT,               -- 课长钉钉 userId (一对一推送目标)
    manager_phone TEXT,
    is_pilot INTEGER DEFAULT 0,             -- 1=试点店
    created_at TEXT DEFAULT (datetime('now','+8 hours'))
  );

  /* === 任务表：每条 = 一店一 SKU 缺货上架任务 === */
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,                 -- 批次 (e.g. 20260625-AM)
    store_id TEXT NOT NULL,
    store_name TEXT NOT NULL,
    sku TEXT NOT NULL,
    barcode TEXT,
    item_name TEXT NOT NULL,
    category TEXT,
    priority TEXT DEFAULT 'P2',
    suggest_price REAL,
    image_url TEXT,
    yesterday_sales INTEGER DEFAULT 0,      -- 昨日销量（用于课长决策）
    stock INTEGER DEFAULT 0,
    status TEXT DEFAULT 'PENDING',          -- PENDING|EXECUTING|DONE|SHORTAGE|FAILED|VERIFIED|MANUAL
    action TEXT,                            -- shelf|shortage|substitute
    operator TEXT,                          -- 课长 dingtalk_id
    actual_price REAL,
    substitute_sku TEXT,
    retry_count INTEGER DEFAULT 0,          -- Worker 重试次数
    error_msg TEXT,
    pushed_at TEXT,                         -- 触达课长时间
    acted_at TEXT,                          -- 课长操作时间
    created_at TEXT DEFAULT (datetime('now','+8 hours')),
    updated_at TEXT DEFAULT (datetime('now','+8 hours')),
    FOREIGN KEY(store_id) REFERENCES stores(store_id)
  );

  CREATE INDEX IF NOT EXISTS idx_store_status ON tasks(store_id, status);
  CREATE INDEX IF NOT EXISTS idx_batch ON tasks(batch_id);
  CREATE INDEX IF NOT EXISTS idx_status ON tasks(status);

  /* === 操作日志（审计取证） === */
  CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    event TEXT NOT NULL,                    -- created|pushed|clicked|executing|done|failed|verified|escalated
    detail TEXT,                            -- JSON 字符串
    created_at TEXT DEFAULT (datetime('now','+8 hours')),
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  );
  CREATE INDEX IF NOT EXISTS idx_log_task ON task_logs(task_id);

  /* === 替代品规则（人工运维，版本化） === */
  CREATE TABLE IF NOT EXISTS substitute_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_version TEXT NOT NULL,             -- v1, v2 ...
    name TEXT NOT NULL,                     -- 同类目动销Top3 / 价格带±20% 等
    category_match TEXT,                    -- 必须同类目?
    price_band_pct REAL,                    -- 价格带±%
    min_sales_30d INTEGER DEFAULT 0,        -- 近30天最低销量
    brand_whitelist TEXT,                   -- JSON array
    brand_blacklist TEXT,                   -- JSON array
    is_active INTEGER DEFAULT 1,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now','+8 hours'))
  );

  /* === 替代品推荐池（Agent 按规则生成） === */
  CREATE TABLE IF NOT EXISTS substitutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_sku TEXT NOT NULL,
    store_id TEXT NOT NULL,                 -- 替代品池按门店维护
    sub_sku TEXT NOT NULL,
    sub_name TEXT NOT NULL,
    sub_price REAL,
    sub_stock INTEGER DEFAULT 0,
    score REAL DEFAULT 0,
    rule_version TEXT,                      -- 由哪个规则版本算出
    generated_at TEXT DEFAULT (datetime('now','+8 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_sub_lookup ON substitutes(original_sku, store_id);
`);

// === Migrations: 添加新字段 (兼容已有数据库) ===
const migrations = [
  'ALTER TABLE tasks ADD COLUMN monthly_sales INTEGER DEFAULT 0',
  'ALTER TABLE tasks ADD COLUMN current_price REAL',
  'ALTER TABLE tasks ADD COLUMN activity_price REAL',
  // === HQ 总部派单扩展 ===
  "ALTER TABLE tasks ADD COLUMN source TEXT DEFAULT 'system'",
  'ALTER TABLE tasks ADD COLUMN assigned_by TEXT',
  'ALTER TABLE tasks ADD COLUMN assigned_at TEXT',
  // === 线下无货原因（v2026.06） ===
  // shortage_reason: 1=品质不好 2=价格错误 3=暂未到货 4=已停售 5=线下售罄 6=其他
  'ALTER TABLE tasks ADD COLUMN shortage_reason INTEGER',
  'ALTER TABLE tasks ADD COLUMN shortage_reason_detail TEXT',
  // === 多品牌多账号隔离（v2026.07） ===
  // whale_shop_id: 鲸品云门店ID（每店不同），worker 按此字段查询/上架
  // credential_key: 凭证池索引键，worker 用它加载对应品牌的 refreshToken
  'ALTER TABLE tasks ADD COLUMN whale_shop_id TEXT',
  'ALTER TABLE tasks ADD COLUMN credential_key TEXT',
  // === 上架操作类型区分（v2026.07） ===
  // operated: worker 实际调了 onSale API 做了上架操作
  // already_on_sale: worker 查到 saleStatus=1，商品已在架，跳过操作
  "ALTER TABLE tasks ADD COLUMN operation_type TEXT",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) {
    if (!e.message.includes('duplicate column')) console.warn('[db] migration skip:', e.message);
  }
}

// === HQ 端建表 + 7 店初始化（幂等） ===
// hq-migration.sql 由 HQ 模块提供，CREATE TABLE IF NOT EXISTS + INSERT OR REPLACE
try {
  const fs = require('fs');
  const sqlPath = path.join(__dirname, 'hq-migration.sql');
  if (fs.existsSync(sqlPath)) {
    const raw = fs.readFileSync(sqlPath, 'utf-8');
    // 1) 逐行去掉 -- 单行注释 2) 拼回完整 SQL 3) 按 ; 切分
    const stripped = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    const statements = stripped
      .split(/;\s*/)
      .map((s) => s.trim())
      .filter((s) => s && !/^SELECT\b/i.test(s));
    for (const stmt of statements) {
      try { db.exec(stmt); } catch (e) {
        if (!/duplicate column|already exists/i.test(e.message)) {
          console.warn('[db][hq-migration] skip:', e.message.slice(0, 80));
        }
      }
    }
    const shopCnt = db.prepare('SELECT COUNT(*) as n FROM hq_shops_meta').get();
    console.log('[db][hq] migration done. hq_shops_meta count =', shopCnt?.n || 0);
  }
} catch (e) {
  console.warn('[db][hq] migration error:', e.message);
}

console.log('[db] schema initialized at', DB_PATH);

module.exports = db;
