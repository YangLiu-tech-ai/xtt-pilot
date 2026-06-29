-- ============================================================
-- HQ 总部运营监控移动端 - DB Migration
-- 兼容现有 xintongtu-mvp 的 SQLite schema（backend/mvp.db）
-- 执行方式: sqlite3 backend/mvp.db < hq-migration.sql
-- 幂等：可重复执行
-- ============================================================

-- ============ 1. tasks 表扩展（与店长端共用） ============
-- 新增字段标识任务来源 + 总部派单人 + 派单时间，用于 SLA 计算与统计
-- ALTER TABLE 在 SQLite 不支持 IF NOT EXISTS，用 try-pattern 在 db.js 里走

-- 由 backend/db.js 的 migrations 数组自动执行：
--   ALTER TABLE tasks ADD COLUMN source TEXT DEFAULT 'system';
--   ALTER TABLE tasks ADD COLUMN assigned_by TEXT;
--   ALTER TABLE tasks ADD COLUMN assigned_at TEXT;

-- ============ 2. hq_shops_meta：HQ 视角的门店元数据 ============
CREATE TABLE IF NOT EXISTS hq_shops_meta (
  shop_id                      TEXT PRIMARY KEY,
  brand                        TEXT NOT NULL,           -- 'csnc' | 'xq' | 'txp'
  shop_full_name               TEXT NOT NULL,
  shop_short_name              TEXT NOT NULL,
  store_manager_mobile         TEXT,                    -- 群机器人 @ 用
  store_manager_dingtalk_id    TEXT,                    -- 备用
  bd_userid                    TEXT,                    -- 归属小二钉钉 userid
  attendance_threshold_red     REAL DEFAULT 0.90,
  attendance_threshold_yellow  REAL DEFAULT 0.95,
  is_active                    INTEGER DEFAULT 1,
  created_at                   TEXT DEFAULT (datetime('now','+8 hours')),
  updated_at                   TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_hq_shops_brand ON hq_shops_meta(brand);

-- ============ 3. hq_users：总部运营白名单 ============
-- MVP 阶段简化为：钉钉群点 magic-link 即可登录，不强校验 userid
-- 后续可扩展为绑定钉钉 userid + 权限明细
CREATE TABLE IF NOT EXISTS hq_users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  brand               TEXT NOT NULL,           -- 'csnc' | 'xq' | 'txp'
  display_name        TEXT,
  dingtalk_userid     TEXT,                    -- 可空，MVP 阶段不强校验
  role                TEXT DEFAULT 'viewer',   -- 'admin' | 'supervisor' | 'viewer'
  authorized_shop_ids TEXT NOT NULL,           -- JSON array; 空 array 表示该 brand 全部
  created_at          TEXT DEFAULT (datetime('now','+8 hours')),
  last_login_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_users_brand ON hq_users(brand);

-- ============ 4. hq_magic_link_jti：magic-link token 防重放 ============
CREATE TABLE IF NOT EXISTS hq_magic_link_jti (
  jti           TEXT PRIMARY KEY,
  brand         TEXT NOT NULL,
  issued_at     TEXT DEFAULT (datetime('now','+8 hours')),
  consumed_at   TEXT,
  exp_at        TEXT NOT NULL,
  client_ip     TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_jti_exp ON hq_magic_link_jti(exp_at);

-- ============ 5. 7 店初始化数据 ============
-- store_manager_mobile 暂统一用测试手机号 18201062873，跑通链路后逐店替换

INSERT OR REPLACE INTO hq_shops_meta
  (shop_id, brand, shop_full_name, shop_short_name, store_manager_mobile) VALUES
  ('1137486501', 'xq',   '兴勤超市(陈江店)',              '陈江店',       '18201062873'),
  ('1328460101', 'xq',   '兴勤超市(港惠店)',              '港惠店',       '18201062873'),
  ('1262004557', 'csnc', '成山农场(龙湖天街店)',          '龙湖天街店',   '18201062873'),
  ('1265426893', 'csnc', '成山农场(曲江京东MALL店)',      '京东MALL店',   '18201062873'),
  ('1284510785', 'txp',  '淘小胖超市(龙湖店)',            '龙湖店',       '18201062873'),
  ('528662517',  'txp',  '淘小胖超市(荥阳店)',            '荥阳店',       '18201062873'),
  ('1316559920', 'txp',  '淘小胖鲜品馆(宝龙城市广场店)',   '宝龙城广店',   '18201062873');

-- ============ 6. 总部账号初始化（MVP: 测试账号） ============
-- 三品牌各建一个"全店权限"的测试账号
INSERT OR REPLACE INTO hq_users (brand, display_name, role, authorized_shop_ids) VALUES
  ('csnc', '成山总部-测试', 'admin', '[]'),
  ('xq',   '兴勤总部-测试', 'admin', '[]'),
  ('txp',  '淘小胖总部-测试', 'admin', '[]');
-- authorized_shop_ids = '[]' 约定为"该 brand 全部门店"

-- ============ Done ============
SELECT 'hq-migration done. shops=' || COUNT(*) FROM hq_shops_meta;
