#!/usr/bin/env node
/**
 * probe-kunlun-token.js — 昆仑 token 服务端探活 + cookie 同步
 *
 * 用途：
 *   1. 用真实的 mtop.ele.newretail.item.pageQuery 请求判断 token 在服务端是否有效。
 *      客户端用 h5tk 内嵌时间戳判断不可靠（服务端 TTL 可能与本地时间戳不一致）。
 *   2. 可选把 token JSON 同步到 cookie 文件，供 Python 取数脚本使用。
 *
 * 命令行：
 *   node probe-kunlun-token.js --token ../kunlun-token.json --seller 1919996480451 --store 20015142365 --sync-cookie ../cookie_fresh.txt
 *
 * 模块引用：
 *   const { probeToken, syncCookieFromToken } = require('./probe-kunlun-token');
 *   const r = await probeToken(tokenFile, sellerId, storeId);
 *   if (!r.ok) { ... }
 */
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_KEY = '12574478';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function httpJson(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(d.replace(/^\uFEFF/, '')));
        } catch (pe) {
          resolve({ raw: d, _parseErr: pe.message });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout ' + urlStr)); });
    if (body) req.write(body);
    req.end();
  });
}

function mtopProbe(api, dataObj, creds) {
  const tk = creds.h5tk.split('_')[0];
  const t = Date.now();
  const dataStr = JSON.stringify(dataObj);
  const sign = md5(tk + '&' + t + '&' + APP_KEY + '&' + dataStr);
  const qs = new URLSearchParams({
    jsv: '2.7.2', appKey: APP_KEY, t: String(t), sign, api,
    v: '1.0', type: 'json', dataType: 'json', valueType: 'string', data: dataStr,
  });
  const cookie = '_m_h5_tk=' + creds.h5tk + (creds.enc ? '; _m_h5_tk_enc=' + creds.enc : '');
  const url = 'https://h5api.m.alibaba-inc.com/h5/' + api.toLowerCase() + '/1.0/?' + qs.toString();
  return httpJson(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'x-ele-platform': 'new_kunlun',
      'x-ele-newkunlun-token': creds.ssot,
      Cookie: cookie,
    },
  });
}

function isTokenError(res) {
  const ret = (res && Array.isArray(res.ret)) ? res.ret.join(',') : JSON.stringify((res && res.ret) || '');
  return /TOKEN[_ ]?EX(P|O)IRED|令牌过期|FAIL_SYS_SESSION_EXPIRED|未登录|无权限|ILLEGAL_ACCESS|FAIL_SYS_ACCESS_TOKEN/i.test(ret);
}

/**
 * 对指定 sellerId+storeId 做一次极轻 pageQuery 探活。
 * @returns {Promise<{ok:boolean, token?:boolean, err?:string, ret?:any}>}
 */
async function probeToken(tokenFile, sellerId, storeId) {
  if (!fs.existsSync(tokenFile)) return { ok: false, err: 'token文件不存在: ' + tokenFile };
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(tokenFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ok: false, err: 'JSON解析失败: ' + e.message };
  }
  if (!creds.h5tk || !creds.ssot) return { ok: false, err: 'token缺h5tk/ssot字段' };
  try {
    const res = await mtopProbe('mtop.ele.newretail.item.pageQuery', {
      pageSize: 1, pageNum: 1, sellerId: String(sellerId),
      storeIds: JSON.stringify([String(storeId)]), titleWithoutSplitting: true,
    }, creds);
    if (Array.isArray(res.ret) && String(res.ret[0]).indexOf('SUCCESS') >= 0) return { ok: true };
    if (isTokenError(res)) return { ok: false, token: true, ret: res.ret };
    return { ok: false, err: JSON.stringify(res.ret) };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/**
 * 把 token JSON 中的 h5tk/enc 写入 cookie 文件，保持 Python 取数脚本读到最新凭证。
 */
function syncCookieFromToken(tokenFile, cookieFile) {
  if (!fs.existsSync(tokenFile)) {
    throw new Error('token文件不存在，无法同步cookie: ' + tokenFile);
  }
  const obj = JSON.parse(fs.readFileSync(tokenFile, 'utf8').replace(/^\uFEFF/, ''));
  if (!obj.h5tk) throw new Error('token文件缺h5tk字段: ' + tokenFile);
  const cookie = '_m_h5_tk=' + obj.h5tk
    + (obj.enc ? '; _m_h5_tk_enc=' + obj.enc : '')
    + '; mtop_partitioned_detect=1';
  fs.writeFileSync(cookieFile, cookie, 'utf8');
  return { h5tkPrefix: obj.h5tk.slice(0, 14), cookieFile };
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
  const syncCookie = getArg(argv, '--sync-cookie', '');
  const quiet = argv.includes('--quiet');

  if (!tokenFile || !sellerId || !storeId) {
    console.error('用法: node probe-kunlun-token.js --token <token.json> --seller <sellerId> --store <storeId> [--sync-cookie <cookie.txt>] [--quiet]');
    process.exit(2);
  }

  if (syncCookie) {
    try {
      const r = syncCookieFromToken(tokenFile, path.resolve(process.cwd(), syncCookie));
      if (!quiet) console.log(`[probe] cookie 已同步: ${r.cookieFile} (${r.h5tkPrefix}...)`);
    } catch (e) {
      console.error('[probe] cookie 同步失败:', e.message);
      process.exit(3);
    }
  }

  const result = await probeToken(tokenFile, sellerId, storeId);
  if (result.ok) {
    if (!quiet) console.log('[probe] ✓ 服务端探活通过');
    process.exit(0);
  }
  if (result.token) {
    console.error('[probe] ✗ token 在服务端已过期:', JSON.stringify(result.ret));
    process.exit(10);
  }
  console.error('[probe] ⚠ 探活失败:', result.err);
  process.exit(11);
}

module.exports = { probeToken, syncCookieFromToken, mtopProbe, isTokenError };

if (require.main === module) {
  main().catch(e => {
    console.error('[probe] 异常:', e.message);
    process.exit(1);
  });
}
