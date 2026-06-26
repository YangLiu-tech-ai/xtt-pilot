/**
 * D5 Pilot Seed: 淘小胖龙湖 真实缺货数据导入
 *
 * 两种模式:
 *   1. node seed-pilot.js              → 使用内置的示例数据 (可替换)
 *   2. node seed-pilot.js items.json   → 从 JSON 文件导入缺货商品
 *
 * JSON 格式: [{barcode, item_name, category, yesterday_sales, stock, suggest_price}]
 * (priority 由脚本根据 yesterday_sales 自动判断)
 *
 * 使用前确保:
 *   1. server.js 已停止（避免 DB locked）
 *   2. 如 server 在运行，先 kill 再 seed
 */
const fs = require('fs');
const path = require('path');
const db = require('../backend/db');
const { issue } = require('../backend/token');

// ============ 门店配置 ============
const STORE = {
  store_id: '1284510785',
  store_name: '淘小胖·龙湖天街',
  brand: '淘小胖',
  manager_name: '刘阳',
  manager_dingtalk_id: 'd12yidm',
  manager_phone: '',
  is_pilot: 1,
};

// ============ 优先级自动判断 ============
// 核心引流品(P0): 昨日销 ≥ 20单
// 爆好价品(P1):   昨日销 10~19单
// 常规品(P2):     昨日销 < 10单
function autoPriority(yesterdaySales) {
  if (yesterdaySales >= 20) return 'P0';
  if (yesterdaySales >= 10) return 'P1';
  return 'P2';
}

// ============ 加载数据 ============
function loadItems() {
  const jsonPath = process.argv[2];
  if (jsonPath) {
    console.log(`[seed-pilot] 从文件加载: ${jsonPath}`);
    const raw = fs.readFileSync(path.resolve(jsonPath), 'utf-8');
    return JSON.parse(raw);
  }

  // 默认示例数据 (淘小胖龙湖常见缺货品)
  console.log('[seed-pilot] 使用内置示例数据 (可通过 node seed-pilot.js items.json 替换)');
  return [
    { barcode: '6901234560019', item_name: '红富士苹果 500g',      category: '水果',   yesterday_sales: 42, stock: 0, suggest_price: 9.9  },
    { barcode: '6901234560026', item_name: '东北大米 5kg',          category: '粮油',   yesterday_sales: 28, stock: 2, suggest_price: 34.9 },
    { barcode: '6901234560033', item_name: '三元鲜牛奶 950ml',     category: '乳品',   yesterday_sales: 35, stock: 0, suggest_price: 12.9 },
    { barcode: '6901234560040', item_name: '广东菜心 350g',         category: '蔬菜',   yesterday_sales: 55, stock: 0, suggest_price: 6.9  },
    { barcode: '6901234560057', item_name: '海南金煌芒 2只装',      category: '水果',   yesterday_sales: 15, stock: 0, suggest_price: 19.9 },
    { barcode: '6901234560064', item_name: '蒙牛纯甄 200g×12',    category: '乳品',   yesterday_sales: 22, stock: 3, suggest_price: 49.9 },
    { barcode: '6901234560071', item_name: '海天酱油 500ml',       category: '调味品', yesterday_sales: 8,  stock: 5, suggest_price: 8.9  },
    { barcode: '6901234560088', item_name: '金龙鱼菜籽油 1.8L',    category: '粮油',   yesterday_sales: 12, stock: 0, suggest_price: 29.9 },
    { barcode: '6901234560095', item_name: '云南小粒咖啡豆 250g',  category: '冲饮',   yesterday_sales: 6,  stock: 0, suggest_price: 39.9 },
    { barcode: '6901234560102', item_name: '伊利金典纯牛奶 250ml×12', category: '乳品', yesterday_sales: 30, stock: 1, suggest_price: 59.9 },
  ];
}

// ============ 替代品模板 (基于类目自动生成) ============
const SUB_TEMPLATES = {
  '水果': [
    { suffix: 'A', name: '阿克苏苹果 500g', price: 11.9, stock: 20, score: 0.92 },
    { suffix: 'B', name: '黄元帅苹果 500g', price: 8.9,  stock: 15, score: 0.78 },
  ],
  '蔬菜': [
    { suffix: 'A', name: '芥兰 350g', price: 7.9, stock: 14, score: 0.85 },
    { suffix: 'B', name: '上海青 400g', price: 5.9, stock: 18, score: 0.72 },
  ],
  '乳品': [
    { suffix: 'A', name: '光明鲜牛奶 950ml', price: 13.9, stock: 12, score: 0.90 },
    { suffix: 'B', name: '君乐宝鲜牛奶 1L', price: 11.9, stock: 8, score: 0.76 },
  ],
  '粮油': [
    { suffix: 'A', name: '福临门菜籽油 1.8L', price: 27.9, stock: 10, score: 0.88 },
  ],
  '冲饮': [
    { suffix: 'A', name: '三顿半咖啡 超即溶', price: 42.9, stock: 6, score: 0.70 },
  ],
  '调味品': [
    { suffix: 'A', name: '李锦记酱油 500ml', price: 9.9, stock: 20, score: 0.85 },
  ],
};

// ============ 执行 Seed ============
(function seedPilot() {
  const items = loadItems();
  const BATCH_ID = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-PILOT';

  console.log(`[seed-pilot] 门店: ${STORE.store_id} ${STORE.store_name}`);
  console.log(`[seed-pilot] 商品: ${items.length} 件`);
  console.log(`[seed-pilot] batch: ${BATCH_ID}`);

  // 清旧
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
      'v1', '同类目·价格带±20%·30天动销>5', '1', 20, 5, '[]', '[]', 'pilot'
    ]);

  // 任务
  const insTask = db.prepare(`INSERT INTO tasks
    (batch_id,store_id,store_name,sku,barcode,item_name,category,priority,suggest_price,yesterday_sales,stock,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'PENDING')`);

  items.forEach((it, i) => {
    const sku = `PILOT${String(i + 1).padStart(3, '0')}`;
    const priority = it.priority || autoPriority(it.yesterday_sales);
    insTask.run([
      BATCH_ID, STORE.store_id, STORE.store_name,
      sku, it.barcode, it.item_name, it.category || '-',
      priority, it.suggest_price || 0, it.yesterday_sales || 0, it.stock || 0
    ]);
  });

  // 替代品 (基于类目自动匹配模板)
  const tasks = db.prepare('SELECT id, sku, category FROM tasks ORDER BY id').all();
  const insSub = db.prepare(`INSERT INTO substitutes
    (original_sku,store_id,sub_sku,sub_name,sub_price,sub_stock,score,rule_version)
    VALUES (?,?,?,?,?,?,?,'v1')`);

  let subCount = 0;
  tasks.forEach(t => {
    const templates = SUB_TEMPLATES[t.category] || [];
    templates.forEach(tmpl => {
      insSub.run([t.sku, STORE.store_id, `${t.sku}-${tmpl.suffix}`, tmpl.name, tmpl.price, tmpl.stock, tmpl.score]);
      subCount++;
    });
  });

  // 日志
  const insLog = db.prepare(`INSERT INTO task_logs (task_id,event,detail) VALUES (?,?,?)`);
  tasks.forEach(t => insLog.run([t.id, 'created', JSON.stringify({ source: 'pilot-seed', batch: BATCH_ID })]));

  // 签发 token
  const token = issue({ storeId: STORE.store_id, dingId: STORE.manager_dingtalk_id || 'pilot-manager' });

  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`  ✅ Pilot Seed 完成`);
  console.log(`  门店: ${STORE.store_name} (${STORE.store_id})`);
  console.log(`  任务: ${tasks.length} 件 PENDING`);
  console.log(`  替代品: ${subCount} 条`);
  console.log(`  Batch: ${BATCH_ID}`);
  console.log('');
  console.log(`  Token: ${token}`);
  console.log('');
  console.log(`  本地 H5: http://localhost:7788/h5/preview.html?token=${token}`);
  console.log(`  公网 H5: https://<tunnel-domain>/h5/preview.html?token=${token}`);
  console.log('═══════════════════════════════════════════════');
})();
