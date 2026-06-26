#!/usr/bin/env node
/**
 * 日报汇总推送：每天傍晚统计当日处理情况 → 推送到运营群
 * 
 * 环境变量：
 *   MVP_API          - Render 后端地址
 *   DING_WEBHOOK     - 钉钉运营群 webhook（当前复用测试群）
 * 
 * 用法：
 *   node scripts/cron-daily-report.js
 */
const https = require('https');
const http = require('http');

const API = process.env.MVP_API || 'https://xtt-pilot.onrender.com';
const WEBHOOK = process.env.DING_WEBHOOK || 'https://oapi.dingtalk.com/robot/send?access_token=b92c7d5f0c3a4447294f310afbaa99ce09ae3ce1b15a470e029dd8f38a60fa86';

const PILOT_STORE = '1284510785';
const PILOT_STORE_NAME = '淘小胖·龙湖天街';
const PILOT_DING_ID = 'd12yidm';

function request(method, urlStr, body) {
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

function todayCST() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const today = todayCST();
  console.log(`[daily-report] ${today} 开始生成日报`);

  // 1. 签发 token 查询任务
  const tokenRes = await request('POST', `${API}/v1/auth/issue`, {
    storeId: PILOT_STORE,
    dingId: 'report-bot',
  });
  if (!tokenRes.data.ok) {
    console.error('[daily-report] token签发失败:', tokenRes.data);
    process.exit(1);
  }
  const token = tokenRes.data.token;

  // 2. 查询所有任务（包括已处理的）
  // 注意：当前 API 只返回非 VERIFIED 的任务，这里直接用 health 统计
  const healthRes = await request('GET', `${API}/v1/health`, null);
  if (!healthRes.data.ok) {
    console.error('[daily-report] health查询失败:', healthRes.data);
    process.exit(1);
  }

  const stats = healthRes.data.stats || [];
  const summary = { total: 0, done: 0, failed: 0, shortage: 0, pending: 0, executing: 0 };
  for (const s of stats) {
    summary.total += s.n;
    switch (s.status) {
      case 'DONE': summary.done += s.n; break;
      case 'FAILED': summary.failed += s.n; break;
      case 'SHORTAGE': summary.shortage += s.n; break;
      case 'PENDING': summary.pending += s.n; break;
      case 'EXECUTING': summary.executing += s.n; break;
    }
  }

  const rate = summary.total > 0
    ? ((summary.done / summary.total) * 100).toFixed(1)
    : '0.0';

  console.log(`[daily-report] 统计: total=${summary.total} done=${summary.done} failed=${summary.failed} shortage=${summary.shortage} pending=${summary.pending}`);
  console.log(`[daily-report] 出勤恢复率: ${rate}%`);

  // 3. 推送日报
  const lines = [
    `### 推送: 补品日报 · ${PILOT_STORE_NAME}`,
    `**日期**: ${today}`,
    '',
    `| 指标 | 数值 |`,
    `|------|------|`,
    `| 推送任务 | ${summary.total} |`,
    `| ✅ 已上架 | ${summary.done} |`,
    `| ⏳ 执行中 | ${summary.executing} |`,
    `| ⚠️ 失败 | ${summary.failed} |`,
    `| 🚫 缺货标记 | ${summary.shortage} |`,
    `| 📋 未处理 | ${summary.pending} |`,
    `| **出勤恢复率** | **${rate}%** |`,
    '',
    parseFloat(rate) >= 85 ? '> 达标 ✅ 继续保持' : '> ⚠️ 低于85%目标，请关注',
  ];

  const cardBody = {
    msgtype: 'actionCard',
    actionCard: {
      title: `推送: 补品日报 · ${PILOT_STORE_NAME} · 恢复率${rate}%`,
      text: lines.join('\n'),
      singleTitle: '📈 查看详情',
      singleURL: `${API}/h5/ops-preview.html`,
    },
  };

  const pushRes = await request('POST', WEBHOOK, cardBody);
  console.log(`[daily-report] 推送结果:`, JSON.stringify(pushRes.data));

  if (pushRes.data.errcode === 0) {
    console.log(`[daily-report] ✅ 日报推送成功`);
  } else {
    console.error(`[daily-report] ❌ 推送失败:`, pushRes.data.errmsg);
  }
}

main().catch(e => {
  console.error('[daily-report] 执行异常:', e.message);
  process.exit(1);
});
