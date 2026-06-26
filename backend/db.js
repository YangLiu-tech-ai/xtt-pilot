/**
 * 新通途·生鲜出勤补品闭环 MVP - 数据库 schema
 * SQLite 单文件零运维 · WAL 模式
 */
const { Database } = require('node-sqlite3-wasm');
const path = require('path');

const DB_PATH = path.join(__dirname, 'mvp.db');
const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

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
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) {
    if (!e.message.includes('duplicate column')) console.warn('[db] migration skip:', e.message);
  }
}

console.log('[db] schema initialized at', DB_PATH);

module.exports = db;
