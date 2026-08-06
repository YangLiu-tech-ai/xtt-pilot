#!/usr/bin/env node
/**
 * refresh-kunlun-token.js — 无浏览器自动刷新昆仑 h5tk
 *
 * 原理：
 *   向 mtop.ele.newretail.item.pageQuery 发送一个带非法/过期 h5tk 的请求，
 *   服务端返回 FAIL_SYS_TOKEN_ILLEGAL 时会在 Set-Cookie 中下发新的 _m_h5_tk 和 _m_h5_tk_enc。
 *   保留原 token 文件中的 ssot（日级有效），只更新 h5tk 和 enc。
 *
 * 用法：
 *   node refresh-kunlun-token.js --token ../kunlun-token.json --seller <sellerId> --store <storeId> [--cookie ../cookie_fresh.txt]
 *
 * 退出码：
 *   0 = 刷新成功
 *   1 = 异常
 *   2 = 参数错误
 *   3 = 服务端未返回新 token
 *   4 = 刷新后探活失败
 */
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const APP_KEY = '12574478';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function httpRequest(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
    }, (res) => {
      let d = '';
      const setCookie = res.headers['set-cookie'] || [];
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, setCookie, body: JSON.parse(d.replace(/^\uFEFF/, '')) });
        } catch (pe) {
          resolve({ status: res.statusCode, setCookie, body: { raw: d, _parseErr: pe.message } });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout ' + urlStr)); });
    req.end();
  });
}

function parseSetCookie(setCookie, name) {
  for (const c of setCookie) {
    const m = c.match(new RegExp('(^|;)\\s*' + name + '=([^;]+)'));
    if (m) return m[2];
  }
  return null;
}

function buildMtopUrl(sellerId, storeId, h5tk, enc, ssot) {
  const tk = h5tk.split('_')[0];
  const t = Date.now();
  const dataObj = {
    pageSize: 1, pageNum: 1, sellerId: String(sellerId),
    storeIds: JSON.stringify([String(storeId)]), titleWithoutSplitting: true,
  };
  const dataStr = JSON.stringify(dataObj);
  const sign = md5(tk + '&' + t + '&' + APP_KEY + '&' + dataStr);
  const qs = new URLSearchParams({
    jsv: '2.7.2', appKey: APP_KEY, t: String(t), sign, api: 'mtop.ele.newretail.item.pageQuery',
    v: '1.0', type: 'json', dataType: 'json', valueType: 'string', data: dataStr,
  });
  const cookie = '_m_h5_tk=' + h5tk + (enc ? '; _m_h5_tk_enc=' + enc : '') + '; mtop_partitioned_detect=1';
  const url = 'https://h5api.m.alibaba-inc.com/h5/mtop.ele.newretail.item.pagequery/1.0/?' + qs.toString();
  return { url, headers: { Accept: 'application/json', 'x-ele-platform': 'new_kunlun', 'x-ele-newkunlun-token': ssot, Cookie: cookie } };
}

async function probeToken(h5tk, enc, ssot, sellerId, storeId) {
  const { url, headers } = buildMtopUrl(sellerId, storeId, h5tk, enc, ssot);
  const res = await httpRequest(url, headers);
  const ret = (res.body && Array.isArray(res.body.ret)) ? res.body.ret.join(',') : JSON.stringify(res.body && res.body.ret);
  return ret.indexOf('SUCCESS') >= 0;
}

function getArg(argv, flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

async function main() {
  const argv = process.argv.slice(2);
  const tokenFile = path.resolve(process.cwd(), getArg(argv, '--token', ''));
  const sellerId = getArg(argv, '--seller', '');
  const storeId = getArg(argv, '--store', '');
  const cookieFile = getArg(argv, '--cookie', '');
  const quiet = argv.includes('--quiet');

  if (!tokenFile || !sellerId || !storeId) {
    console.error('用法: node refresh-kunlun-token.js --token <token.json> --seller <sellerId> --store <storeId> [--cookie <cookie.txt>] [--quiet]');
    process.exit(2);
  }

  if (!fs.existsSync(tokenFile)) {
    console.error(`[refresh] token 文件不存在: ${tokenFile}`);
    process.exit(1);
  }

  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(tokenFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`[refresh] token 文件解析失败: ${e.message}`);
    process.exit(1);
  }
  if (!obj.ssot) {
    console.error(`[refresh] token 文件缺少 ssot: ${tokenFile}`);
    process.exit(1);
  }

  const oldPrefix = obj.h5tk ? obj.h5tk.slice(0, 14) : 'null';
  if (!quiet) console.log(`[refresh] 当前 h5tk: ${oldPrefix}... ssot: ${obj.ssot.slice(0, 14)}...`);

  // 用非法 h5tk 触发服务端下发新 cookie
  const dummyH5tk = 'dummy0000000000000000000000_0';
  const dummyEnc = '00000000000000000000000000000000';
  const { url, headers } = buildMtopUrl(sellerId, storeId, dummyH5tk, dummyEnc, obj.ssot);

  let res;
  try {
    res = await httpRequest(url, headers);
  } catch (e) {
    console.error(`[refresh] 请求失败: ${e.message}`);
    process.exit(1);
  }

  const newH5tk = parseSetCookie(res.setCookie, '_m_h5_tk');
  const newEnc = parseSetCookie(res.setCookie, '_m_h5_tk_enc');

  if (!newH5tk) {
    console.error(`[refresh] 服务端未返回新的 _m_h5_tk。响应 ret: ${JSON.stringify((res.body && res.body.ret) || res.body)}`);
    process.exit(3);
  }

  // 校验新 h5tk 时间戳
  const expiryMs = Number(newH5tk.split('_')[1]) || 0;
  const remainingMin = expiryMs ? Math.round((expiryMs - Date.now()) / 60000) : 0;
  if (remainingMin <= 0) {
    console.error(`[refresh] 服务端返回的 h5tk 已过期: ${newH5tk}`);
    process.exit(3);
  }
  if (remainingMin < 30) {
    console.error(`[refresh] 服务端返回的 h5tk 剩余时间过短: ${remainingMin} 分钟`);
    process.exit(3);
  }

  if (!quiet) console.log(`[refresh] 新 h5tk: ${newH5tk.slice(0, 14)}... 剩余约 ${remainingMin} 分钟`);

  // 先探活，通过后才写入文件（避免坏 token 覆盖好 token）
  try {
    const alive = await probeToken(newH5tk, newEnc || obj.enc || '', obj.ssot, sellerId, storeId);
    if (!alive) {
      console.error('[refresh] 刷新后服务端探活失败，保留原 token 文件不覆写');
      process.exit(4);
    }
  } catch (e) {
    console.error(`[refresh] 刷新后探活异常: ${e.message}，保留原 token 文件不覆写`);
    process.exit(4);
  }

  // 探活通过，更新 token 文件
  const updated = {
    h5tk: newH5tk,
    ssot: obj.ssot,
    enc: newEnc || obj.enc || '',
    harvestedAt: new Date().toISOString(),
    source: 'auto-refresh-via-mtop',
  };

  try {
    fs.writeFileSync(tokenFile, JSON.stringify(updated, null, 2), 'utf8');
  } catch (e) {
    console.error(`[refresh] 写入 token 文件失败: ${e.message}`);
    process.exit(1);
  }

  // 镜像写入父目录同名文件（probe 从 scripts/ 用 --token ../kunlun-token.json 读取的是父目录文件）
  const parentTokenFile = path.resolve(path.dirname(tokenFile), '..', path.basename(tokenFile));
  if (parentTokenFile !== tokenFile) {
    try {
      fs.writeFileSync(parentTokenFile, JSON.stringify(updated, null, 2), 'utf8');
      if (!quiet) console.log(`[refresh] 镜像已同步: ${parentTokenFile}`);
    } catch (e) {
      if (!quiet) console.log(`[refresh] 镜像写入失败(不影响主流程): ${e.message}`);
    }
  }

  // 同步 cookie 文件
  if (cookieFile) {
    const cookieOut = '_m_h5_tk=' + newH5tk
      + (newEnc ? '; _m_h5_tk_enc=' + newEnc : '')
      + '; mtop_partitioned_detect=1';
    try {
      fs.writeFileSync(path.resolve(process.cwd(), cookieFile), cookieOut, 'utf8');
      if (!quiet) console.log(`[refresh] cookie 已同步: ${cookieFile}`);
    } catch (e) {
      console.error(`[refresh] 写入 cookie 文件失败: ${e.message}`);
      process.exit(1);
    }
  }

  if (!quiet) console.log('[refresh] ✓ 刷新并探活成功');
}

main().catch(e => {
  console.error('[refresh] 异常:', e.message);
  process.exit(1);
});
