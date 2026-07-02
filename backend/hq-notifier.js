/**
 * HQ 钉钉群机器人通知器
 *
 * 三个核心场景：
 *   1. 早盘告警卡片 → 各品牌运营群（含 magic-link 入口）
 *   2. 总部派单通知 → 各品牌运营群（@ 店长手机号）
 *   3. 处理完成回执 → 各品牌运营群
 *
 * MVP 阶段：三个品牌都指向同一个测试群 webhook
 *   HQ_WEBHOOK_TEST=https://oapi.dingtalk.com/robot/send?access_token=...
 *   关键词：推送
 * 后续切生产时改为：HQ_WEBHOOK_CSNC / HQ_WEBHOOK_XQ / HQ_WEBHOOK_TXP
 */

const { issueMagicLink } = require('./hq-token');

// ============ 配置 ============
const HQ_BASE_URL = process.env.HQ_BASE_URL || 'https://xtt-pilot.onrender.com';

// MVP 阶段统一走测试群 webhook
const TEST_WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=b92c7d5f0c3a4447294f310afbaa99ce09ae3ce1b15a470e029dd8f38a60fa86';

const BRAND_CONFIG = {
  csnc: {
    display_name: '成山农场',
    webhook: process.env.HQ_WEBHOOK_CSNC || TEST_WEBHOOK,
    hq_base_url: process.env.HQ_BASE_URL_CSNC || `${HQ_BASE_URL}/csnc`,
  },
  xq: {
    display_name: '兴勤超市',
    webhook: process.env.HQ_WEBHOOK_XQ || TEST_WEBHOOK,
    hq_base_url: process.env.HQ_BASE_URL_XQ || `${HQ_BASE_URL}/xq`,
  },
  txp: {
    display_name: '淘小胖',
    webhook: process.env.HQ_WEBHOOK_TXP || TEST_WEBHOOK,
    hq_base_url: process.env.HQ_BASE_URL_TXP || `${HQ_BASE_URL}/txp`,
  },
};

const STORE_H5_BASE = process.env.STORE_H5_BASE || 'https://xtt-pilot.onrender.com/h5/go.html';

// ============ 底层发送 ============
async function postToDingtalk(webhook, body) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.errcode !== 0) {
    console.error('[hq-notifier] dingtalk error:', json);
    throw new Error(`DINGTALK_ERR_${json.errcode}: ${json.errmsg}`);
  }
  return json;
}

// ============ 场景 1：早盘告警 + magic-link 入口 ============
/**
 * 在现有 10:00 / 16:00 昆仑出勤群推消息末尾追加按钮，
 * 或单独发一条带 magic-link 的导航卡。
 *
 * @param {string} brand 'csnc' | 'xq' | 'txp'
 * @param {object} summary { attendance_rate, missing_sku, loss_gmv, red_shops, yellow_shops }
 */
async function sendMorningAlert(brand, summary) {
  const cfg = BRAND_CONFIG[brand];
  if (!cfg) throw new Error(`unknown brand: ${brand}`);

  const { token } = issueMagicLink({ brand, userId: 'group-broadcast', shopIds: [] });
  const link = `${cfg.hq_base_url}/?t=${encodeURIComponent(token)}`;

  const md = [
    `### 推送 · ${cfg.display_name} 今日缺货告警`,
    '',
    `**整体出勤率**：${(summary.attendance_rate * 100).toFixed(1)}%`,
    `**未出勤 SKU**：${summary.missing_sku} 件`,
    `**预估缺货损失**：¥${summary.loss_gmv.toLocaleString()}`,
    `**红灯门店**：${summary.red_shops} 家 · 黄灯：${summary.yellow_shops} 家`,
    '',
    `[📱 查看明细 →](${link})`,
    '',
    `> 链接 5 分钟内有效，请尽快点击进入`,
  ].join('\n');

  return postToDingtalk(cfg.webhook, {
    msgtype: 'markdown',
    markdown: {
      title: `推送·${cfg.display_name}缺货告警`,
      text: md,
    },
  });
}

// ============ 场景 2：总部催办通知 @ 店长 ============
/**
 * @param {string} brand
 * @param {object} shopInfo { shop_id, shop_short_name, store_manager_mobile }
 * @param {Array<object>} items [{ item_name, yesterday_loss_gmv }]
 * @param {string} assignedBy 催办人显示名
 */
async function sendTaskAssigned(brand, shopInfo, items, assignedBy = 'HQ总部') {
  const cfg = BRAND_CONFIG[brand];
  if (!cfg) throw new Error(`unknown brand: ${brand}`);

  const totalLoss = items.reduce((s, it) => s + (it.yesterday_loss_gmv || 0), 0);
  const mobile = shopInfo.store_manager_mobile;
  const storeH5Link = `${STORE_H5_BASE}?shop=${shopInfo.shop_id}`;

  const skuLines = items.slice(0, 8).map(it =>
    `- ${it.item_name}（昨损 ¥${(it.yesterday_loss_gmv || 0).toFixed(0)}）`
  );
  if (items.length > 8) skuLines.push(`- ... 共 ${items.length} 件`);

  const md = [
    `### 推送 · 总部催办`,
    '',
    mobile ? `@${mobile}` : '',
    '',
    `**${shopInfo.shop_short_name}** 以下 **${items.length}** 件商品总部重点关注，请尽快处理`,
    `预估挽回损失 ¥${totalLoss.toFixed(0)}`,
    '',
    ...skuLines,
    '',
    `[立即处理 →](${storeH5Link})`,
    '',
    `> 催办人：${assignedBy} · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
  ].filter(Boolean).join('\n');

  return postToDingtalk(cfg.webhook, {
    msgtype: 'markdown',
    markdown: {
      title: `推送·总部催办`,
      text: md,
    },
    at: {
      atMobiles: mobile ? [mobile] : [],
      isAtAll: false,
    },
  });
}

// ============ 场景 3：处理完成回执 ============
async function sendTaskCompleted(brand, shopInfo, completedCnt, totalCnt) {
  const cfg = BRAND_CONFIG[brand];
  if (!cfg) throw new Error(`unknown brand: ${brand}`);

  const md = [
    `### 推送 · 派单处理回执`,
    '',
    `**${shopInfo.shop_short_name}** 店长已处理 **${completedCnt} / ${totalCnt}** 件`,
    completedCnt === totalCnt ? '✅ 全部完成' : `⏳ 还有 ${totalCnt - completedCnt} 件未处理`,
    '',
    `> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
  ].join('\n');

  return postToDingtalk(cfg.webhook, {
    msgtype: 'markdown',
    markdown: { title: '推送·派单回执', text: md },
  });
}

module.exports = {
  BRAND_CONFIG,
  sendMorningAlert,
  sendTaskAssigned,
  sendTaskCompleted,
};
