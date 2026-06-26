#!/usr/bin/env node
/**
 * 定时推送：查询 PENDING 任务 → 签发 token → 推送钉钉卡片给课长
 * 
 * 设计：通过 Render API 远程调用，不依赖本地 DB
 * 
 * 环境变量：
 *   MVP_API          - Render 后端地址 (default: https://xtt-pilot.onrender.com)
 *   MVP_INTERNAL_KEY - 内部接口密钥
 *   DING_WEBHOOK     - 钉钉测试群 webhook
 * 
 * 用法：
 *   node scripts/cron-push.js
 *   或通过 QoderWork 定时任务自动执行
 */
const https = require('https');
const http = require('http');

const API = process.env.MVP_API || 'https://xtt-pilot.onrender.com';
const INTERNAL_KEY = process.env.MVP_INTERNAL_KEY || 'worker-key-2026-prod';
const WEBHOOK = process.env.DING_WEBHOOK || 'https://oapi.dingtalk.com/robot/send?access_token=b92c7d5f0c3a4447294f310afbaa99ce09ae3ce1b15a470e029dd8f38a60fa86';

// 试点配置
const PILOT_STORE = '1284510785';
const PILOT_STORE_NAME = '淘小胖·龙湖天街';
const PILOT_DING_ID = 'd12yidm';

function request(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : '';
    const req = mod.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log(`[cron-push] ${new Date().toISOString()} 开始执行`);
  console.log(`[cron-push] API: ${API}`);

  // 1. 签发 token
  const tokenRes = await request('POST', `${API}/v1/auth/issue`, {
    storeId: PILOT_STORE,
    dingId: PILOT_DING_ID,
  });
  if (!tokenRes.data.ok) {
    console.error('[cron-push] token签发失败:', tokenRes.data);
    process.exit(1);
  }
  const token = tokenRes.data.token;
  console.log(`[cron-push] token签发成功, expIn: ${tokenRes.data.expIn}`);

  // 2. 查询待处理任务
  const tasksRes = await request('GET', `${API}/v1/tasks?token=${token}`, null);
  if (!tasksRes.data.ok) {
    console.error('[cron-push] 查询任务失败:', tasksRes.data);
    process.exit(1);
  }
  const tasks = tasksRes.data.tasks || [];
  const pendingTasks = tasks.filter(t => t.status === 'PENDING');
  console.log(`[cron-push] 总任务: ${tasks.length}, 待处理: ${pendingTasks.length}`);

  if (pendingTasks.length === 0) {
    console.log('[cron-push] 无待处理任务，跳过推送');
    return;
  }

  // 3. 构建 H5 链接
  const h5Url = `${API}/h5/preview.html?token=${token}`;

  // 4. 推送钉钉卡片
  const topItems = pendingTasks.slice(0, 5);
  const count = pendingTasks.length;
  const lines = [
    `### 缺货补品推送 · ${PILOT_STORE_NAME}`,
    `**${count} 件商品待处理**`,
    '',
    ...topItems.map((t, i) =>
      `${i + 1}. ${t.item_name} · 昨日${t.yesterday_sales}单 · 库存${t.stock}`
    ),
  ];
  if (count > 5) lines.push('', `… 还有 ${count - 5} 件`);
  lines.push('', '> 点击下方按钮一键处理');

  const cardBody = {
    msgtype: 'actionCard',
    actionCard: {
      title: `推送: 缺货补品 · ${PILOT_STORE_NAME} · ${count}件`,
      text: lines.join('\n'),
      singleTitle: '📱 打开补品清单',
      singleURL: h5Url,
    },
    at: { atUserIds: [PILOT_DING_ID], isAtAll: false },
  };

  const pushRes = await request('POST', WEBHOOK, cardBody);
  console.log(`[cron-push] 推送结果:`, JSON.stringify(pushRes.data));

  if (pushRes.data.errcode === 0) {
    console.log(`[cron-push] ✅ 成功推送 ${count} 件缺货商品到钉钉群`);
  } else {
    console.error(`[cron-push] ❌ 推送失败:`, pushRes.data.errmsg);
  }
}

main().catch(e => {
  console.error('[cron-push] 执行异常:', e.message);
  process.exit(1);
});
