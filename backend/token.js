/**
 * Token 工具：URL Token (72h)
 * Token 形态: base64(JSON{storeId, dingId, exp})
 * 简单 HMAC 签名防伪造
 */
const crypto = require('crypto');

const SECRET = process.env.MVP_SECRET || 'xtt-mvp-dev-secret-2026';
const TTL_MS = 72 * 60 * 60 * 1000;

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function issue({ storeId, dingId }) {
  const body = {
    storeId, dingId,
    exp: Date.now() + TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (sign(payload) !== sig) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (body.exp < Date.now()) return null;
    return body;
  } catch (e) { return null; }
}

module.exports = { issue, verify };
