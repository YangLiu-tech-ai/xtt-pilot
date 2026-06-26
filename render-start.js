#!/usr/bin/env node
/**
 * Render.com 启动入口
 * 
 * Render 免费版重启时文件系统重置，所以每次冷启动自动 seed。
 * 启动流程：seed (如DB空) → 签发 pilot token → 启动 Express
 */

// 初始化 DB schema（db.js 导入时自动创建表）
const db = require('./backend/db');

// 检查是否需要 seed
const count = db.prepare('SELECT COUNT(*) as n FROM tasks').get().n;
if (count === 0) {
  console.log('[render-start] DB 为空，执行 seed...');
  require('./scripts/seed');
} else {
  console.log(`[render-start] DB 已有 ${count} 条任务，跳过 seed`);
}

// 签发 pilot token 并打印
const { issue } = require('./backend/token');
const pilotToken = issue({ storeId: '1284510785', dingId: 'pilot-manager' });
console.log(`[render-start] Pilot H5: /h5/preview.html?token=${pilotToken}`);

// 启动 server（server.js 内使用 process.env.PORT，Render 会注入）
require('./backend/server');
