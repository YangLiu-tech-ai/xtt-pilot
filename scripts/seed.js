/**
 * D1 Seed: 锁定试点店「淘小胖龙湖 1284510785」
 * 注入：1 个门店 + 1 条替代品规则 + 5 个缺货商品 + 9 条替代品池
 *
 * 注意：node-sqlite3-wasm 的命名绑定 key 必须带前缀（@xxx/$xxx/:xxx），
 * 为简化与跨驱动兼容，本脚本全部 INSERT 改用位置参数 ?。
 */
const db = require('../backend/db');

const STORE = {
  store_id: '1284510785',
  store_name: '淘小胖龙湖',
  brand: '淘小胖',
  manager_name: '张三',
  manager_dingtalk_id: '',          // ← 课长真实 dingId 待填
  manager_phone: '',
  is_pilot: 1,
};

const RULE = {
  rule_version: 'v1',
  name: '同类目·价格带±20%·30天动销>5',
  category_match: '1',
  price_band_pct: 20,
  min_sales_30d: 5,
  brand_whitelist: '[]',
  brand_blacklist: '[]',
  created_by: 'system',
};

const BATCH_ID = '20260625-AM';
const ITEMS = [
  { sku: 'XTT001', barcode: '6901234567001', item_name: '红富士苹果 500g', category: '水果',  priority: 'P0', suggest_price: 9.9,  yesterday_sales: 18, stock: 0 },
  { sku: 'XTT002', barcode: '6901234567002', item_name: '爱媛果冻橙 1.5kg', category: '水果',  priority: 'P1', suggest_price: 29.9, yesterday_sales: 12, stock: 3 },
  { sku: 'XTT003', barcode: '6901234567003', item_name: '本地小白菜 400g', category: '蔬菜',  priority: 'P1', suggest_price: 4.9,  yesterday_sales: 8,  stock: 5 },
  { sku: 'XTT004', barcode: '6901234567004', item_name: '海南金煌芒 2 个装', category: '水果',  priority: 'P2', suggest_price: 19.9, yesterday_sales: 6,  stock: 0 },
  { sku: 'XTT005', barcode: '6901234567005', item_name: '广东菜心 350g',   category: '蔬菜',  priority: 'P2', suggest_price: 6.9,  yesterday_sales: 5,  stock: 0 },
];

const SUBS = [
  { o: 'XTT001', sub_sku: 'XTT101', sub_name: '阿克苏苹果 500g',    sub_price: 11.9, sub_stock: 20, score: 0.95 },
  { o: 'XTT001', sub_sku: 'XTT102', sub_name: '红蛇果 4 个装',       sub_price: 9.9,  sub_stock: 15, score: 0.82 },
  { o: 'XTT001', sub_sku: 'XTT103', sub_name: '黄元帅苹果 500g',     sub_price: 8.9,  sub_stock: 8,  score: 0.75 },
  { o: 'XTT002', sub_sku: 'XTT201', sub_name: '砂糖橘 1kg',          sub_price: 19.9, sub_stock: 12, score: 0.88 },
  { o: 'XTT002', sub_sku: 'XTT202', sub_name: '丑橘 1kg',            sub_price: 24.9, sub_stock: 6,  score: 0.79 },
  { o: 'XTT004', sub_sku: 'XTT401', sub_name: '台农芒果 1kg',        sub_price: 22.9, sub_stock: 10, score: 0.86 },
  { o: 'XTT004', sub_sku: 'XTT402', sub_name: '凯特芒 2 个装',       sub_price: 18.9, sub_stock: 5,  score: 0.74 },
  { o: 'XTT005', sub_sku: 'XTT501', sub_name: '芥兰 350g',           sub_price: 7.9,  sub_stock: 14, score: 0.80 },
  { o: 'XTT005', sub_sku: 'XTT502', sub_name: '上海青 400g',         sub_price: 5.9,  sub_stock: 18, score: 0.71 },
];

(function seed() {
  console.log('[seed] target store:', STORE.store_id, STORE.store_name);

  // 清旧（顺序：子表→父表）
  db.prepare('DELETE FROM task_logs').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM substitutes').run();
  db.prepare('DELETE FROM substitute_rules').run();
  db.prepare('DELETE FROM stores').run();

  // 门店
  db.prepare(`INSERT INTO stores
    (store_id,store_name,brand,manager_name,manager_dingtalk_id,manager_phone,is_pilot)
    VALUES (?,?,?,?,?,?,?)`).run([
      STORE.store_id, STORE.store_name, STORE.brand,
      STORE.manager_name, STORE.manager_dingtalk_id, STORE.manager_phone, STORE.is_pilot
    ]);

  // 规则
  db.prepare(`INSERT INTO substitute_rules
    (rule_version,name,category_match,price_band_pct,min_sales_30d,brand_whitelist,brand_blacklist,created_by)
    VALUES (?,?,?,?,?,?,?,?)`).run([
      RULE.rule_version, RULE.name, RULE.category_match,
      RULE.price_band_pct, RULE.min_sales_30d,
      RULE.brand_whitelist, RULE.brand_blacklist, RULE.created_by
    ]);

  // 任务
  const insTask = db.prepare(`INSERT INTO tasks
    (batch_id,store_id,store_name,sku,barcode,item_name,category,priority,suggest_price,yesterday_sales,stock,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'PENDING')`);
  ITEMS.forEach(it => insTask.run([
    BATCH_ID, STORE.store_id, STORE.store_name,
    it.sku, it.barcode, it.item_name, it.category, it.priority,
    it.suggest_price, it.yesterday_sales, it.stock
  ]));

  // 替代品
  const insSub = db.prepare(`INSERT INTO substitutes
    (original_sku,store_id,sub_sku,sub_name,sub_price,sub_stock,score,rule_version)
    VALUES (?,?,?,?,?,?,?,'v1')`);
  SUBS.forEach(s => insSub.run([
    s.o, STORE.store_id, s.sub_sku, s.sub_name, s.sub_price, s.sub_stock, s.score
  ]));

  // 操作日志（基于真实 task_id 避免 AUTOINCREMENT 偏移）
  const taskRows = db.prepare('SELECT id FROM tasks ORDER BY id').all();
  const insLog = db.prepare(`INSERT INTO task_logs (task_id,event,detail) VALUES (?,?,?)`);
  taskRows.forEach(row => insLog.run([
    row.id, 'created', JSON.stringify({ source: 'seed', batch: BATCH_ID })
  ]));

  const taskCount = db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  const subCount = db.prepare('SELECT COUNT(*) n FROM substitutes').get().n;
  console.log(`[seed] done. store=1 tasks=${taskCount} substitutes=${subCount}`);

  // 顺便签发 token 方便测试
  const { issue } = require('../backend/token');
  const token = issue({ storeId: STORE.store_id, dingId: 'test-manager' });
  console.log(`[seed] test token: ${token}`);
  console.log(`[seed] H5: http://localhost:7788/v1/tasks?token=${token}`);
})();
