/**
 * 通过用户名密码获取 refresh_token
 */
const https = require('https');

const WHALE_BASE_URL = 'https://whale.zwztf.net';
const BASIC_AUTH = 'Basic d2hhbGU6d2hhbGU=';

// 禁用证书校验（worker-api.js 也这么做的）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function request(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const username = 'XACSNC';
  const password = 'a123456';

  // 尝试 password grant
  const url = `${WHALE_BASE_URL}/api/auth/oauth/token?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&grant_type=password&scope=server`;
  const r = await request(url, {
    method: 'POST',
    headers: {
      'Authorization': BASIC_AUTH,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
  });
  console.log('Status:', r.status);
  console.log('Response:', JSON.stringify(r.data, null, 2));
})();
