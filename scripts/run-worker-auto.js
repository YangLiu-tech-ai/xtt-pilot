#!/usr/bin/env node
/**
 * run-worker-auto.js — 自动化 worker 启动器
 * 
 * 集成逻辑：
 *   1. 先尝试验证 token.tmp 里的 refresh_token 是否有效
 *   2. 若无效，通过 QoderWork 浏览器 MCP 从鲸品云 localStorage 提取新 token
 *   3. 写入 token.tmp
 *   4. 启动 worker-api.js
 * 
 * 此脚本供 QoderWork agent 调用；浏览器提取步骤需要 agent 协助完成。
 * 
 * 用法:
 *   node scripts/run-worker-auto.js
 * 
 * 环境变量:
 *   WHALE_SHOP_ID - 门店ID (default: 1579337942525061)
 *   SKIP_TOKEN_CHECK - 跳过预检直接启动 worker
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const WHALE_BASE_URL = process.env.WHALE_BASE_URL || 'https://whale.zwztf.net';
const BASIC_AUTH = 'Basic d2hhbGU6d2hhbGU=';
const TOKEN_FILE = path.join(__dirname, '..', 'token.tmp');
const WORKER_SCRIPT = path.join(__dirname, 'worker-api.js');

function request(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function validateToken(refreshToken) {
  if (!refreshToken) return false;
  try {
    const url = `${WHALE_BASE_URL}/api/auth/oauth/token?refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token&scope=server`;
    const data = await request(url, { method: 'POST', headers: { 'Authorization': BASIC_AUTH } });
    return !!data?.access_token;
  } catch {
    return false;
  }
}

function readTokenFile() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const content = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (content.startsWith('{')) {
      const obj = JSON.parse(content);
      return obj.refresh_token || null;
    }
    return content || null;
  } catch {
    return null;
  }
}

async function main() {
  console.log('[run-worker-auto] 启动...');

  if (process.env.SKIP_TOKEN_CHECK) {
    console.log('[run-worker-auto] SKIP_TOKEN_CHECK=1, 跳过预检');
  } else {
    // 预检 token 有效性
    const currentToken = process.env.WHALE_REFRESH_TOKEN || readTokenFile();
    if (currentToken) {
      console.log('[run-worker-auto] 验证 token 有效性...');
      const valid = await validateToken(currentToken);
      if (valid) {
        console.log('[run-worker-auto] ✅ token 有效');
        // 确保 token.tmp 里有最新的
        fs.writeFileSync(TOKEN_FILE, currentToken, 'utf8');
      } else {
        console.error('[run-worker-auto] ❌ token 失效!');
        console.error('[run-worker-auto] 需要从浏览器恢复 — 请确保 whale.zwztf.net 已登录');
        console.error('[run-worker-auto] Agent 应执行: 从浏览器 localStorage 提取 midstrage-refresh_token 并写入 token.tmp');
        console.error(JSON.stringify({ needBrowserLogin: true, tokenFile: TOKEN_FILE }));
        process.exit(2); // exit code 2 = 需要浏览器恢复
      }
    } else {
      console.error('[run-worker-auto] ❌ 无可用 token (env & token.tmp 都为空)');
      console.error('[run-worker-auto] Agent 应执行: 从浏览器 localStorage 提取 midstrage-refresh_token 并写入 token.tmp');
      process.exit(2);
    }
  }

  // 启动 worker
  const token = process.env.WHALE_REFRESH_TOKEN || readTokenFile();
  const shopId = process.env.WHALE_SHOP_ID || '1579337942525061';
  console.log(`[run-worker-auto] 启动 worker (shop=${shopId})`);

  try {
    execSync(`node "${WORKER_SCRIPT}"`, {
      stdio: 'inherit',
      env: {
        ...process.env,
        WHALE_REFRESH_TOKEN: token,
        WHALE_SHOP_ID: shopId,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
    });
  } catch (e) {
    process.exit(e.status || 1);
  }
}

main().catch(e => {
  console.error('[run-worker-auto] 异常:', e.message);
  process.exit(1);
});
