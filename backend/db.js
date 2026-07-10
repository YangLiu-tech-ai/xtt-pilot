/**
 * 新通途·生鲜出勤补品闭环 MVP - 数据库 schema
 * SQLite 单文件 · WAL 模式
 *
 * ⚠️ 必须用 WAL 模式：Render 持久磁盘是网络文件系统，DELETE 模式下 CREATE
 *    TABLE 等写操作要直接对主库文件加锁，网络盘对该锁支持不可靠 → "database
 *    is locked"。WAL 模式把写入引到 -wal 文件，规避主库文件锁，反而能正常运行。
 *    残留 -shm(纯派生的共享内存索引)在启动时清理(见 render-start.js)，SQLite
 *    打开时会自动重建；-wal(含未落库数据)在清理前先合并进主库，保证数据不丢。
 */
const { Database } = require('node-sqlite3-wasm');
const path = require('path');
const fs = require('fs');

// —— 关键 monkey-patch:绕过 node-sqlite3-wasm 在 Render 网络盘上必"database is locked" 的 bug ——
// 根因锁定(Render 日志诊断):node-sqlite3-wasm 用 fs.mkdirSync('xxx.lock') 做 POSIX
// 兼容文件锁,但 Render 持久磁盘(/var/data)是网络文件系统,对该锁机制支持有问题
// (即使从零新建的空库 PRAGMA 也立刻 "database is locked"),mkdirSync 在 .lock
// 目录上总是失败或返回 EEXIST → SQLite 拿到 SQLITE_BUSY → 抛错。
// 我们是 Render Starter 单实例 (WEB_CONCURRENCY=1),没有并发进程,完全不需要锁。
// 故在 require Database 后立刻 patch fs.mkdirSync/rmdirSync,把 .lock 目录操作变
// no-op。这样后续 new Database / PRAGMA / CREATE TABLE 都能正常执行。
// ⚠️ 仅 patch .lock 后缀路径,不影响其他 mkdirSync/rmdirSync 调用。
const origMkdirSync = fs.mkdirSync;
const origRmdirSync = fs.rmdirSync;
fs.mkdirSync = function patchedMkdirSync(p, ...args) {
  if (typeof p === 'string' && p.endsWith('.lock')) {
    // 锁目录:no-op,假装成功(若已存在也无所谓)
    try { return origMkdirSync.call(fs, p, ...args); } catch (_) { return undefined; }
  }
  return origMkdirSync.call(fs, p, ...args);
};
fs.rmdirSync = function patchedRmdirSync(p, ...args) {
  if (typeof p === 'string' && p.endsWith('.lock')) {
    try { return origRmdirSync.call(fs, p, ...args); } catch (_) { return undefined; }
  }
  return origRmdirSync.call(fs, p, ...args);
};
console.log('[db] fs.mkdirSync/rmdirSync monkey-patched: .lock 目录操作已被 no-op (Render 网络盘锁兼容)');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'mvp.db');

// —— 启动前磁盘状态诊断（用于定位 Render 网络盘上数据库锁问题）——
try {
  const mainExists = fs.existsSync(DB_PATH);
  const walExists = fs.existsSync(DB_PATH + '-wal');
  const shmExists = fs.existsSync(DB_PATH + '-shm');
  const journalExists = fs.existsSync(DB_PATH + '-journal');
  const mainSize = mainExists ? fs.statSync(DB_PATH).size : -1;
  const walSize = walExists ? fs.statSync(DB_PATH + '-wal').size : -1;
  console.log(`[db] DB_PATH=${DB_PATH}`);
  console.log(`[db] 磁盘状态: main=${mainSize}B wal=${walExists?walSize+'B':'absent'} shm=${shmExists?'present':'absent'} journal=${journalExists?'present':'absent'}`);
} catch (e) {
  console.warn('[db] disk state inspect failed:', e.message);
}

// —— 打开数据库（含"主库损坏自动重建"兜底）——
// 历史踩坑:Render 网络盘上,前几次失败部署(如 a9e6d76 用 copyFileSync)可能把
// 主库写成 SQLite 无法识别/锁定的不一致状态。即使 -wal/-shm/-journal 都清了,
// 打开后 PRAGMA 或 CREATE TABLE 仍会 "database is locked"。
// 兜底策略:
//   (1) 若主库文件太小(< 4KB,基本是空库或损坏残留),主动删掉重建;
//   (2) 若 new Database() 抛 locked 类错误,删掉旧文件重试一次(代价:丢历史数据,
//       但有本地 backups 兜底,比服务起不来强);
//   (3) PRAGMA 加 busy_timeout 重试;
//   (4) 仍失败则放弃兜底让进程崩掉,靠 Render 自动重启。
let db;
const openFresh = () => {
  try { if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch (_) {}
  return new Database(DB_PATH);
};
try {
  const preSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  if (preSize > 0 && preSize < 4096) {
    console.warn(`[db] 主库文件异常小(${preSize}B),疑似损坏残留,删除重建: ${DB_PATH}`);
    db = openFresh();
  } else {
    try {
      db = new Database(DB_PATH);
    } catch (openErr) {
      const msg = (openErr && openErr.message) || String(openErr);
      if (/locked|busy/i.test(msg)) {
        console.warn(`[db] 首次打开抛locked,删文件重建: ${msg}`);
        db = openFresh();
      } else {
        throw openErr;
      }
    }
    // 关键:打开成功后做健康检查——用一个轻量 PRAGMA 探测 SQLite 是否真能读写。
    // 历史踩坑:Render 网络盘上,new Database() 可能不抛错但后续 exec 仍"database
    // is locked"(主库文件已被前几次部署损坏)。此处在 exec 大块建表前先探一下,
    // 失败就删掉重建,代价是丢历史数据(有本地 backups 兜底)。
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('PRAGMA journal_mode').get();
    } catch (probeErr) {
      const msg = (probeErr && probeErr.message) || String(probeErr);
      if (/locked|busy|corrupt|malformed/i.test(msg)) {
        console.warn(`[db] 健康检查失败(主库不可用),删文件重建: ${msg}`);
        try { db.close(); } catch (_) {}
        db = openFresh();
        console.warn('[db] 重建成功(本地 backups 仍可补历史数据)');
      } else {
        throw probeErr;
      }
    }
  }
} catch (e) {
  console.error('[db] 数据库打开兜底均失败,无法继续:', e.message);
  process.exit(2);
}

// —— PRAGMA:try/catch 兜底,失败降级为 warning 让启动继续 ——
// 健康检查已在前面设置过 busy_timeout = 5000,后续 SQL 遇锁会等 5 秒重试。
// 这里只设 journal_mode 和 foreign_keys,失败不阻塞启动。
try {
  const mode = db.prepare('PRAGMA journal_mode = WAL').get();
  console.log('[db] journal_mode =', JSON.stringify(mode));
} catch (e) {
  console.warn('[db] PRAGMA journal_mode=WAL failed (non-fatal, continuing):', e.message);
}
try {
  db.exec('PRAGMA foreign_keys = ON');
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
