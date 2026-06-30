#!/usr/bin/env node
/**
 * refresh-whale-token.js — 自动从鲸品云后台获取有效的 refresh_token
 * 
 * 策略（按优先级）：
 *   1. 尝试用现有 WHALE_REFRESH_TOKEN 刷新 access_token
 *   2. 若失败（invalid_grant），从本地 token.tmp 文件读取备用 token 重试
 *   3. 若仍失败，输出错误提示需要通过浏览器登录鲸品云
 * 
 * 输出：
 *   成功时向 stdout 输出 JSON: {"ok":true,"refresh_token":"xxx","access_token":"xxx"}
 *   失败时向 stdout 输出 JSON: {"ok":false,"error":"xxx","needBrowserLogin":true}
 * 
 * 用法：
 *   node refresh-whale-token.js [--save]
 *   --save: 成功时将 refresh_token 写入 token.tmp
 * 
 * 环境变量：
 *   WHALE_REFRESH_TOKEN - 当前的 refresh_token
 *   WHALE_BASE_URL      - 鲸品云地址 (default: https://whale.zwztf.net)
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const WHALE_BASE_URL = process.env.WHALE_BASE_URL || 'https://whale.zwztf.net';
const BASIC_AUTH = 'Basic d2hhbGU6d2hhbGU=';
const TOKEN_FILE = path.join(__dirname, '..', 'token.tmp');

const doSave = process.argv.includes('--save');

function request(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function tryRefresh(refreshToken) {
  if (!refreshToken) return null;
  const url = `${WHALE_BASE_URL}/api/auth/oauth/token?refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token&scope=server`;
  try {
    const r = await request(url, { method: 'POST', headers: { 'Authorization': BASIC_AUTH } });
    if (r.data?.access_token) {
      return {
        ok: true,
        refresh_token: refreshToken,
        access_token: r.data.access_token,
        expires_in: r.data.expires_in,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function readTokenFile() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const content = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    // token.tmp 可能是纯 token 字符串，也可能是 JSON
    if (content.startsWith('{')) {
      const obj = JSON.parse(content);
      return obj.refresh_token || obj.WHALE_REFRESH_TOKEN || null;
    }
    return content || null;
  } catch {
    return null;
  }
}

async function main() {
  // 策略1: 用环境变量里的 token
  const envToken = process.env.WHALE_REFRESH_TOKEN || '';
  if (envToken) {
    const result = await tryRefresh(envToken);
    if (result) {
      if (doSave) {
        fs.writeFileSync(TOKEN_FILE, envToken, 'utf8');
      }
      console.log(JSON.stringify(result));
      return;
    }
    process.stderr.write('[refresh-whale-token] env WHALE_REFRESH_TOKEN invalid_grant, trying token.tmp...\n');
  }

  // 策略2: 从 token.tmp 读取
  const fileToken = readTokenFile();
  if (fileToken && fileToken !== envToken) {
    const result = await tryRefresh(fileToken);
    if (result) {
      console.log(JSON.stringify(result));
      return;
    }
    process.stderr.write('[refresh-whale-token] token.tmp also invalid\n');
  }

  // 策略3: 所有 token 都失效
  console.log(JSON.stringify({
    ok: false,
    error: 'All refresh_tokens expired. Need browser login to whale.zwztf.net',
    needBrowserLogin: true,
  }));
  process.exit(1);
}

main().catch(e => {
  console.log(JSON.stringify({ ok: false, error: e.message, needBrowserLogin: true }));
  process.exit(1);
});
