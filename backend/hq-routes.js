/**
 * HQ 总部端 Express 路由
 *
 * 挂载方式（在 backend/server.js 末尾追加）：
 *   const hqRoutes = require('./hq-routes');
 *   hqRoutes.mount(app, db);
 *
 * 所有路由前缀 /api/hq/，与店长端 /v1/* 完全隔离。
 * brand 隔离通过 JWT payload + SQL WHERE brand = ? 双重保障。
 */

const {
  issueMagicLink,
  issueSession,
  consumeMagicLink,
  hqAuth,
} = require('./hq-token');

const {
  sendMorningAlert,
  sendTaskAssigned,
  sendTaskCompleted,
  BRAND_CONFIG,
} = require('./hq-notifier');

function mount(app, db) {

  // ========== 工具函数 ==========
  function getShopMeta(shopId) {
    return db.prepare(`SELECT * FROM hq_shops_meta WHERE shop_id = ?`).get([shopId]);
  }

  function getBrandShops(brand, authorizedShopIds = []) {
    if (authorizedShopIds.length > 0) {
      const placeholders = authorizedShopIds.map(() => '?').join(',');
      return db.prepare(
        `SELECT * FROM hq_shops_meta WHERE brand = ? AND shop_id IN (${placeholders}) AND is_active = 1`
      ).all([brand, ...authorizedShopIds]);
    }
    return db.prepare(
      `SELECT * FROM hq_shops_meta WHERE brand = ? AND is_active = 1`
    ).all([brand]);
  }

  // ========== Auth ==========

  /**
   * 测试用：手动签发 magic-link，模拟群消息按钮链接
   * 生产由 hq-notifier.sendMorningAlert 自动签发
   * curl POST /api/hq/auth/issue-magic { brand: 'csnc' }
   */
  app.post('/api/hq/auth/issue-magic', (req, res) => {
    const { brand, userId } = req.body || {};
    if (!brand || !BRAND_CONFIG[brand]) {
      return res.status(400).json({ ok: false, err: 'INVALID_BRAND' });
    }
    const { token, exp } = issueMagicLink({ brand, userId });
    const link = `${BRAND_CONFIG[brand].hq_base_url}/?t=${encodeURIComponent(token)}`;
    res.json({ ok: true, token, link, exp });
  });

  /**
   * Magic-link exchange：前端从 URL ?t= 拿到 magic-link 后调本接口换长 session
   */
  app.post('/api/hq/auth/magic-login', (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, err: 'TOKEN_REQUIRED' });

    const result = consumeMagicLink(db, token);
    if (!result.ok) return res.status(401).json({ ok: false, err: result.reason });

    const { brand } = result.payload;
    // 拉品牌的 admin 账号作为运营身份（MVP 简化）
    const user = db.prepare(`
      SELECT id, display_name, role, authorized_shop_ids
      FROM hq_users
      WHERE brand = ?
      ORDER BY id ASC LIMIT 1
    `).get([brand]);

    if (!user) return res.status(403).json({ ok: false, err: 'NO_HQ_USER' });

    db.prepare(`UPDATE hq_users SET last_login_at = datetime('now','+8 hours') WHERE id = ?`).run([user.id]);

    const shopIds = JSON.parse(user.authorized_shop_ids || '[]');
    const session = issueSession({
      brand,
      userId: String(user.id),
      shopIds,
    });

    res.json({
      ok: true,
      sessionToken: session.token,
      exp: session.exp,
      brand,
      displayName: user.display_name,
      role: user.role,
      brandConfig: {
        displayName: BRAND_CONFIG[brand].display_name,
      },
    });
  });

  // ========== Dashboard ==========

  /**
   * 品牌健康度首屏：返回品牌汇总 + 门店排行
   * GET /api/hq/dashboard
   * Header: x-hq-token
   *
   * MVP 阶段使用 mock 计算：实际需要从 ODPS dws_tcls_itm_online_minutes_1d 拉取
   * 当前用 tasks 表派生（缺货 SKU 数 = 该 store 当日 PENDING+EXECUTING 任务数）
   */
  app.get('/api/hq/dashboard', hqAuth(), (req, res) => {
    const { brand } = req.hqUser;
    const shops = getBrandShops(brand, req.hqUser.shopIds);
    const today = new Date().toISOString().slice(0, 10);

    const shopRows = shops.map(shop => {
      const taskStats = db.prepare(`
        SELECT
          SUM(CASE WHEN status IN ('PENDING','EXECUTING') THEN 1 ELSE 0 END) as missing,
          SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done,
          COALESCE(SUM(yesterday_sales * suggest_price), 0) as loss_gmv_est
        FROM tasks
        WHERE store_id = ? AND date(created_at) = date('now','+8 hours')
      `).get([shop.shop_id]);

      // MVP 简化口径：假设出勤率 = 1 - missing / 100（实际接 ODPS 后替换）
      const missingCnt = taskStats?.missing || 0;
      const attendanceRate = Math.max(0, 1 - missingCnt / 100);

      let light = 'grn';
      if (attendanceRate < shop.attendance_threshold_red) light = 'red';
      else if (attendanceRate < shop.attendance_threshold_yellow) light = 'yel';

      return {
        shop_id: shop.shop_id,
        shop_short_name: shop.shop_short_name,
        attendance_rate: attendanceRate,
        missing_sku_cnt: missingCnt,
        light,
        loss_gmv: taskStats?.loss_gmv_est || 0,
      };
    });

    shopRows.sort((a, b) => b.attendance_rate - a.attendance_rate);

    const summary = {
      attendance_rate: shopRows.length
        ? shopRows.reduce((s, r) => s + r.attendance_rate, 0) / shopRows.length
        : 1,
      missing_sku: shopRows.reduce((s, r) => s + r.missing_sku_cnt, 0),
      loss_gmv: shopRows.reduce((s, r) => s + r.loss_gmv, 0),
      red_shops: shopRows.filter(r => r.light === 'red').length,
      yellow_shops: shopRows.filter(r => r.light === 'yel').length,
    };

    res.json({
      ok: true,
      brand,
      brand_display_name: BRAND_CONFIG[brand].display_name,
      date: today,
      summary,
      shops: shopRows,
      last_updated_at: new Date().toISOString(),
    });
  });

  /**
   * 单店未出勤 SKU 明细 + 各任务状态
   * GET /api/hq/shops/:shopId/missing-skus
   */
  app.get('/api/hq/shops/:shopId/missing-skus', hqAuth(), (req, res) => {
    const { brand, shopIds } = req.hqUser;
    const { shopId } = req.params;

    // 数据权限校验
    const shop = getShopMeta(shopId);
    if (!shop || shop.brand !== brand) {
      return res.status(403).json({ ok: false, err: 'SHOP_NOT_IN_BRAND' });
    }
    if (shopIds.length > 0 && !shopIds.includes(shopId)) {
      return res.status(403).json({ ok: false, err: 'SHOP_NOT_AUTHORIZED' });
    }

    const items = db.prepare(`
      SELECT
        id as task_id,
        sku, barcode, item_name, category,
        suggest_price, yesterday_sales, stock,
        monthly_sales, current_price, activity_price,
        status, source, assigned_by, assigned_at,
        created_at, pushed_at, acted_at
      FROM tasks
      WHERE store_id = ?
        AND date(created_at) = date('now','+8 hours')
      ORDER BY
        CASE status WHEN 'PENDING' THEN 0 WHEN 'EXECUTING' THEN 1 ELSE 2 END,
        yesterday_sales DESC
    `).all([shopId]);

    res.json({
      ok: true,
      shop: {
        shop_id: shop.shop_id,
        shop_short_name: shop.shop_short_name,
        shop_full_name: shop.shop_full_name,
        store_manager_mobile: shop.store_manager_mobile,
      },
      items,
    });
  });

  /**
   * SKU 跨店在架矩阵
   * GET /api/hq/skus/:barcode/cross-shop
   */
  app.get('/api/hq/skus/:barcode/cross-shop', hqAuth(), (req, res) => {
    const { brand, shopIds } = req.hqUser;
    const { barcode } = req.params;

    const shops = getBrandShops(brand, shopIds);
    const shopIdList = shops.map(s => s.shop_id);

    // 从 tasks 表反推（MVP 简化）：当前任务状态 → 在架/缺货
    const placeholders = shopIdList.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT store_id, item_name, stock, monthly_sales,
             status, MAX(created_at) as last_seen
      FROM tasks
      WHERE barcode = ? AND store_id IN (${placeholders})
      GROUP BY store_id
    `).all([barcode, ...shopIdList]);

    const byShop = Object.fromEntries(rows.map(r => [r.store_id, r]));
    const matrix = shops.map(s => {
      const r = byShop[s.shop_id];
      return {
        shop_id: s.shop_id,
        shop_short_name: s.shop_short_name,
        online: !r || r.status === 'DONE',  // 无任务 = 默认在架
        stock: r?.stock || 0,
        monthly_sales: r?.monthly_sales || 0,
        last_seen: r?.last_seen,
      };
    });

    const itemName = rows.find(r => r.item_name)?.item_name || '未知商品';

    res.json({
      ok: true,
      barcode,
      item_name: itemName,
      shops: matrix,
    });
  });

  // ========== 派活 ==========

  /**
   * 总部派活：勾选 SKU → 建 task → 钉钉群 @ 店长
   * POST /api/hq/tasks/assign
   * body: { items: [{ shop_id, barcode, item_name?, yesterday_sales?, suggest_price? }] }
   */
  app.post('/api/hq/tasks/assign', hqAuth(), async (req, res) => {
    const { brand, shopIds, userId } = req.hqUser;
    const items = (req.body?.items || []);
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, err: 'EMPTY_ITEMS' });
    }
    if (items.length > 200) {
      return res.status(400).json({ ok: false, err: 'TOO_MANY_ITEMS' });
    }

    const created = [];
    const skipped = [];
    const byShop = {};
    const nowIso = new Date().toISOString();

    // 按 shop_id 分组
    for (const it of items) {
      const shop = getShopMeta(it.shop_id);
      if (!shop || shop.brand !== brand) {
        skipped.push({ ...it, reason: 'SHOP_NOT_IN_BRAND' });
        continue;
      }
      if (shopIds.length > 0 && !shopIds.includes(it.shop_id)) {
        skipped.push({ ...it, reason: 'SHOP_NOT_AUTHORIZED' });
        continue;
      }
      if (!byShop[it.shop_id]) byShop[it.shop_id] = { shop, items: [] };
      byShop[it.shop_id].items.push(it);
    }

    // 逐店事务化创建任务
    const insertStmt = db.prepare(`
      INSERT INTO tasks
        (batch_id, store_id, store_name, sku, barcode, item_name,
         category, priority, suggest_price, yesterday_sales,
         stock, monthly_sales, status, source, assigned_by, assigned_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'hq_assigned', ?, ?)
    `);
    const batchId = `HQ-${brand}-${Date.now()}`;

    for (const shopId in byShop) {
      const { shop, items: shopItems } = byShop[shopId];
      const insertedItems = [];

      for (const it of shopItems) {
        try {
          const info = insertStmt.run([
            batchId,
            shopId,
            shop.shop_full_name,
            it.sku || it.barcode || `HQ-${Date.now()}`,
            it.barcode || '',
            it.item_name || '未命名商品',
            it.category || '',
            it.priority || 'P1',
            it.suggest_price || 0,
            it.yesterday_sales || 0,
            it.stock || 0,
            it.monthly_sales || 0,
            userId || 'hq_unknown',
            nowIso,
          ]);
          const taskId = info.lastInsertRowid;
          insertedItems.push({
            task_id: taskId,
            shop_id: shopId,
            barcode: it.barcode,
            item_name: it.item_name,
            yesterday_loss_gmv: (it.yesterday_sales || 0) * (it.suggest_price || 0),
          });
          created.push({
            task_id: taskId,
            shop_id: shopId,
            barcode: it.barcode,
          });

          db.prepare(`INSERT INTO task_logs (task_id, event, detail) VALUES (?, ?, ?)`)
            .run([taskId, 'hq_assigned', JSON.stringify({ assigned_by: userId, brand })]);
        } catch (e) {
          skipped.push({ ...it, reason: 'INSERT_FAIL: ' + e.message });
        }
      }

      // 发钉钉群通知 @ 该店店长
      if (insertedItems.length > 0) {
        try {
          await sendTaskAssigned(brand, shop, insertedItems, `HQ运营·${userId || 'test'}`);
        } catch (e) {
          console.error('[hq-routes] dingtalk push failed for shop', shopId, e.message);
          // 不影响 task 创建成功
        }
      }
    }

    res.json({
      ok: true,
      batch_id: batchId,
      created_cnt: created.length,
      skipped_cnt: skipped.length,
      created,
      skipped,
    });
  });

  /**
   * 派单任务列表（含 SLA 计算）
   * GET /api/hq/tasks?status=PENDING&shop_id=xxx&days=7
   */
  app.get('/api/hq/tasks', hqAuth(), (req, res) => {
    const { brand, shopIds } = req.hqUser;
    const { status, shop_id, days = 7 } = req.query;

    const shops = getBrandShops(brand, shopIds);
    const allowedShopIds = shops.map(s => s.shop_id);
    if (allowedShopIds.length === 0) return res.json({ ok: true, tasks: [] });

    let sql = `
      SELECT t.id as task_id, t.store_id, t.store_name,
             t.barcode, t.item_name, t.status, t.source,
             t.assigned_by, t.assigned_at, t.pushed_at, t.acted_at,
             t.created_at
      FROM tasks t
      WHERE t.store_id IN (${allowedShopIds.map(() => '?').join(',')})
        AND t.source = 'hq_assigned'
        AND date(t.created_at) >= date('now','+8 hours', '-${parseInt(days, 10)} days')
    `;
    const params = [...allowedShopIds];
    if (status) {
      sql += ` AND t.status = ?`;
      params.push(status);
    }
    if (shop_id) {
      sql += ` AND t.store_id = ?`;
      params.push(shop_id);
    }
    sql += ` ORDER BY t.assigned_at DESC LIMIT 500`;

    const rows = db.prepare(sql).all(params);

    // 计算 SLA：assigned_at → acted_at
    const tasks = rows.map(r => {
      let sla_minutes = null;
      if (r.assigned_at && r.acted_at) {
        sla_minutes = Math.round((new Date(r.acted_at) - new Date(r.assigned_at)) / 60000);
      }
      return { ...r, sla_minutes };
    });

    res.json({ ok: true, count: tasks.length, tasks });
  });

  // ========== 群推触发（手动 / cron） ==========

  /**
   * 触发指定品牌的早盘告警群推（含 magic-link）
   * POST /api/hq/internal/push-morning-alert
   * Header: x-internal-key
   * body: { brand: 'csnc' | 'xq' | 'txp' }
   */
  app.post('/api/hq/internal/push-morning-alert', async (req, res) => {
    const internalKey = req.headers['x-internal-key'];
    if (internalKey !== (process.env.MVP_INTERNAL_KEY || 'worker-key-2026')) {
      return res.status(403).json({ ok: false, err: 'FORBIDDEN' });
    }
    const { brand } = req.body || {};
    if (!brand || !BRAND_CONFIG[brand]) {
      return res.status(400).json({ ok: false, err: 'INVALID_BRAND' });
    }

    // 复用 dashboard 计算 summary
    const shops = getBrandShops(brand);
    const stats = shops.map(shop => {
      const r = db.prepare(`
        SELECT
          SUM(CASE WHEN status IN ('PENDING','EXECUTING') THEN 1 ELSE 0 END) as missing,
          COALESCE(SUM(yesterday_sales * suggest_price), 0) as loss
        FROM tasks
        WHERE store_id = ? AND date(created_at) = date('now','+8 hours')
      `).get([shop.shop_id]) || {};
      const missing = r.missing || 0;
      const rate = Math.max(0, 1 - missing / 100);
      let light = 'grn';
      if (rate < shop.attendance_threshold_red) light = 'red';
      else if (rate < shop.attendance_threshold_yellow) light = 'yel';
      return { rate, missing, loss: r.loss || 0, light };
    });

    const summary = {
      attendance_rate: stats.length ? stats.reduce((s, r) => s + r.rate, 0) / stats.length : 1,
      missing_sku: stats.reduce((s, r) => s + r.missing, 0),
      loss_gmv: stats.reduce((s, r) => s + r.loss, 0),
      red_shops: stats.filter(r => r.light === 'red').length,
      yellow_shops: stats.filter(r => r.light === 'yel').length,
    };

    try {
      const result = await sendMorningAlert(brand, summary);
      res.json({ ok: true, brand, summary, dingtalk: result });
    } catch (e) {
      res.status(500).json({ ok: false, err: e.message });
    }
  });

  console.log('[hq-routes] mounted: /api/hq/*');
}

module.exports = { mount };
