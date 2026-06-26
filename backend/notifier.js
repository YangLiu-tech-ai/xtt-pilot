/**
 * 新通途 MVP · 钉钉推送模块 (D5 pilot 版)
 *
 * 三种推送场景:
 *   1. pushShortageCard  - 课长: 今日缺货清单 ActionCard (清单入口)
 *   2. pushEscalateCard  - 商家运营: Agent 失败升级卡片
 *   3. pushDailySummary  - 商家运营: 每日补品汇总日报
 *
 * 钉钉机器人类型: 自定义机器人（Webhook）
 * 文档: https://open.dingtalk.com/document/orgapp/custom-robot-access
 *
 * 环境变量:
 *   DING_WEBHOOK_STORE   - 门店群机器人 webhook (推课长)
 *   DING_WEBHOOK_OPS     - 运营群机器人 webhook (推商家运营)
 */

const https = require('https');

// ============ 配置 ============
const WEBHOOK_STORE = process.env.DING_WEBHOOK_STORE || '';
const WEBHOOK_OPS   = process.env.DING_WEBHOOK_OPS || '';

// ============ 基础发送 ============
function sendDingTalk(webhookUrl, body) {
  return new Promise((resolve, reject) => {
    if (!webhookUrl) return reject(new Error('webhook URL 为空'));
    const data = JSON.stringify(body);
    const url = new URL(webhookUrl);

    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { resolve({ raw: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ============ 1. 课长: 缺货清单推送 ============
/**
 * @param {object} opts
 * @param {string} opts.webhook   - 门店群 webhook (或用默认 WEBHOOK_STORE)
 * @param {Array}  opts.tasks     - 缺货任务列表 [{item_name, barcode, yesterday_sales, stock}]
 * @param {string} opts.storeName - 门店名
 * @param {string} opts.h5Url     - H5 完整访问 URL (含 token)
 * @param {string} opts.dingId    - 课长钉钉 ID (@某人)
 */
async function pushShortageCard({ webhook, tasks, storeName, h5Url, dingId, bypassIP }) {
  const url = webhook || WEBHOOK_STORE;
  const count = tasks.length;
  const topItems = tasks.slice(0, 5);

  const lines = [
    `### 🛒 缺货补品 · ${storeName}`,
    `**${count} 件商品待处理**`,
    '',
    ...topItems.map((t, i) =>
      `${i + 1}. ${t.item_name} · 昨日${t.yesterday_sales}单 · 库存${t.stock}`
    ),
  ];
  if (count > 5) lines.push('', `… 还有 ${count - 5} 件`);
  lines.push('', '> 点击下方按钮一键处理 👇');
  if (bypassIP) {
    lines.push('', `> 首次打开如提示输入密码，请输入: **${bypassIP}**`);
  }

  const body = {
    msgtype: 'actionCard',
    actionCard: {
      title: `🛒 缺货补品 · ${storeName} · ${count}件`,
      text: lines.join('\n'),
      singleTitle: '📱 打开补品清单',
      singleURL: h5Url,
    },
    at: dingId ? { atUserIds: [dingId], isAtAll: false } : { isAtAll: false },
  };

  const result = await sendDingTalk(url, body);
  console.log(`[notifier] pushShortageCard → ${storeName} ${count}件, result:`, JSON.stringify(result));
  return result;
}

// ============ 2. 商家运营: 失败升级 ============
/**
 * @param {object} opts
 * @param {string} opts.webhook   - 运营群 webhook (或用默认 WEBHOOK_OPS)
 * @param {object} opts.task      - {id, item_name, barcode, error_msg, retry_count}
 * @param {object} opts.store     - {store_id, store_name, manager_name}
 */
async function pushEscalateCard({ webhook, task, store }) {
  const url = webhook || WEBHOOK_OPS;

  const lines = [
    `### ⚠️ 上架失败 · 需人工介入`,
    '',
    `**商品**: ${task.item_name} (${task.barcode})`,
    `**门店**: ${store.store_name}`,
    `**课长**: ${store.manager_name || '-'}（已操作，Agent执行失败）`,
    '',
    `**失败原因**: ${task.error_msg || '未知错误'}`,
    `**重试次数**: ${task.retry_count || 3} / 3`,
    '',
    '> 请在鲸品云手动处理 👇',
  ];

  const body = {
    msgtype: 'actionCard',
    actionCard: {
      title: `⚠️ ${task.item_name} 上架失败 · ${store.store_name}`,
      text: lines.join('\n'),
      singleTitle: '🔧 去鲸品云处理',
      singleURL: 'https://whale.tmall.com/',
    },
  };

  const result = await sendDingTalk(url, body);
  console.log(`[notifier] pushEscalateCard → task#${task.id} ${task.item_name}, result:`, JSON.stringify(result));
  return result;
}

// ============ 3. 商家运营: 日报汇总 ============
/**
 * @param {object} opts
 * @param {string} opts.webhook   - 运营群 webhook
 * @param {object} opts.summary   - {total, done, failed, shortage, executing, pending}
 * @param {string} opts.storeName - 门店名
 * @param {string} opts.date      - 日期字符串 YYYY-MM-DD
 * @param {string} opts.opsUrl    - 监控台 URL (可选)
 */
async function pushDailySummary({ webhook, summary, storeName, date, opsUrl }) {
  const url = webhook || WEBHOOK_OPS;
  const rate = summary.total > 0 ? ((summary.done / summary.total) * 100).toFixed(1) : '0.0';

  const lines = [
    `### 📊 补品日报 · ${storeName}`,
    `**日期**: ${date}`,
    '',
    `| 指标 | 数值 |`,
    `|------|------|`,
    `| 推送任务 | ${summary.total} |`,
    `| ✅ 已上架 | ${summary.done} |`,
    `| ⚠️ 失败 | ${summary.failed} |`,
    `| 🚫 缺货 | ${summary.shortage} |`,
    `| ⏳ 未处理 | ${summary.pending || 0} |`,
    `| **出勤恢复率** | **${rate}%** |`,
    '',
    rate >= 85 ? '> 达标 ✅ 继续保持' : '> ⚠️ 低于 85% 目标，请关注',
  ];

  const body = {
    msgtype: 'actionCard',
    actionCard: {
      title: `📊 补品日报 · ${storeName} · 恢复率${rate}%`,
      text: lines.join('\n'),
      singleTitle: '📈 查看监控台',
      singleURL: opsUrl || 'https://xxx.trycloudflare.com/h5/ops-preview.html',
    },
  };

  const result = await sendDingTalk(url, body);
  console.log(`[notifier] pushDailySummary → ${storeName} ${date} rate=${rate}%, result:`, JSON.stringify(result));
  return result;
}

module.exports = { pushShortageCard, pushEscalateCard, pushDailySummary, sendDingTalk };

// ============ CLI 测试模式 ============
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'test-shortage') {
    // node notifier.js test-shortage <webhook> [h5Url]
    const webhook = args[1];
    const h5Url = args[2] || 'https://example.trycloudflare.com/h5/preview.html?token=test';
    if (!webhook) { console.error('用法: node notifier.js test-shortage <webhook> [h5Url]'); process.exit(1); }

    pushShortageCard({
      webhook,
      storeName: '淘小胖·龙湖天街',
      h5Url,
      tasks: [
        { item_name: '红富士苹果 500g', barcode: '6901234560019', yesterday_sales: 42, stock: 0 },
        { item_name: '东北大米 5kg', barcode: '6901234560026', yesterday_sales: 28, stock: 2 },
        { item_name: '广东菜心 350g', barcode: '6901234560040', yesterday_sales: 55, stock: 0 },
        { item_name: '三元鲜牛奶 950ml', barcode: '6921168500101', yesterday_sales: 35, stock: 1 },
        { item_name: '海天酱油 500ml', barcode: '6902899880012', yesterday_sales: 18, stock: 3 },
      ],
    }).then(r => console.log('✅ Done:', r)).catch(e => console.error('❌', e.message));

  } else if (cmd === 'test-escalate') {
    const webhook = args[1];
    if (!webhook) { console.error('用法: node notifier.js test-escalate <webhook>'); process.exit(1); }

    pushEscalateCard({
      webhook,
      task: { id: 1, item_name: '红富士苹果 500g', barcode: '6901234560019', error_msg: '鲸品云超时无响应', retry_count: 3 },
      store: { store_id: '1284510785', store_name: '淘小胖·龙湖天街', manager_name: '王课长' },
    }).then(r => console.log('✅ Done:', r)).catch(e => console.error('❌', e.message));

  } else if (cmd === 'test-summary') {
    const webhook = args[1];
    if (!webhook) { console.error('用法: node notifier.js test-summary <webhook>'); process.exit(1); }

    pushDailySummary({
      webhook,
      storeName: '淘小胖·龙湖天街',
      date: new Date().toISOString().slice(0, 10),
      summary: { total: 15, done: 12, failed: 1, shortage: 1, pending: 1 },
    }).then(r => console.log('✅ Done:', r)).catch(e => console.error('❌', e.message));

  } else {
    console.log(`
新通途 MVP · 钉钉推送测试

用法:
  node notifier.js test-shortage <webhook> [h5Url]    测试缺货清单推送 (给课长)
  node notifier.js test-escalate <webhook>            测试失败升级推送 (给运营)
  node notifier.js test-summary  <webhook>            测试日报汇总推送 (给运营)

webhook 示例:
  https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx
`);
  }
}
