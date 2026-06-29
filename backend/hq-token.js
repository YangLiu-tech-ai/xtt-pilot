/**
 * HQ Magic Link Token 工具
 * 与店长端 token.js 共存，独立 SECRET / 独立 TTL
 *
 * 设计：
 *  - 短 token (magic_link)：5 min 过期 + jti 防重放 → 用于群消息一次性入口
 *  - 长 token (session)   : 7 day 过期 → magic_link exchange 后下发，写 localStorage
 *
 * Token 形态: base64url(JSON{ kind, brand, userId, shopIds, jti, exp }) + '.' + sig
 */
const crypto = require('crypto');

const HQ_SECRET = process.env.HQ_JWT_SECRET || 'xtt-hq-dev-secret-2026';
const MAGIC_TTL_MS = 5 * 60 * 1000;          // 5 分钟
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

function sign(payload) {
  return crypto.createHmac('sha256', HQ_SECRET).update(payload).digest('base64url');
}

function newJti() {
  return crypto.randomBytes(12).toString('base64url');
}

/**
 * 签发 magic-link token，放入钉钉群消息按钮
 * @param {object} opts { brand, userId, shopIds=[] }
 * @returns { token, jti, exp }
 */
function issueMagicLink({ brand, userId, shopIds = [] }) {
  if (!brand) throw new Error('brand required');
  const body = {
    kind: 'magic',
    brand,
    userId: userId || null,
    shopIds,
    jti: newJti(),
    exp: Date.now() + MAGIC_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return {
    token: `${payload}.${sign(payload)}`,
    jti: body.jti,
    exp: body.exp,
  };
}

/**
 * 签发 long session token，magic-link exchange 后下发
 */
function issueSession({ brand, userId, shopIds = [] }) {
  if (!brand) throw new Error('brand required');
  const body = {
    kind: 'session',
    brand,
    userId: userId || null,
    shopIds,
    jti: newJti(),
    exp: Date.now() + SESSION_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return {
    token: `${payload}.${sign(payload)}`,
    jti: body.jti,
    exp: body.exp,
  };
}

/**
 * 校验任意 token，返回 payload；失败返回 null
 */
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (sign(payload) !== sig) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (body.exp < Date.now()) return null;
    return body;
  } catch (e) {
    return null;
  }
}

/**
 * 校验 magic-link token 并 ensure jti 未消费过（依赖外部 DB）
 * @param {object} db sqlite db instance
 * @param {string} token
 * @returns { ok, payload?, reason? }
 */
function consumeMagicLink(db, token) {
  const body = verify(token);
  if (!body) return { ok: false, reason: 'INVALID_OR_EXPIRED' };
  if (body.kind !== 'magic') return { ok: false, reason: 'NOT_MAGIC_LINK' };
  if (!body.brand) return { ok: false, reason: 'NO_BRAND' };

  // 检查 jti 是否已被消费
  const existing = db.prepare(`SELECT consumed_at FROM hq_magic_link_jti WHERE jti = ?`).get([body.jti]);
  if (existing && existing.consumed_at) {
    return { ok: false, reason: 'JTI_ALREADY_USED' };
  }

  // 插入或更新 jti 记录，标记为已消费
  const now = new Date().toISOString();
  const expIso = new Date(body.exp).toISOString();
  db.prepare(`
    INSERT INTO hq_magic_link_jti (jti, brand, issued_at, consumed_at, exp_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jti) DO UPDATE SET consumed_at = excluded.consumed_at
  `).run([body.jti, body.brand, now, now, expIso]);

  return { ok: true, payload: body };
}

/**
 * brand-aware session 中间件
 * 用法：app.get('/api/hq/...', hqAuth('csnc'), handler) 或 hqAuth() 任意品牌
 * Express middleware factory
 */
function hqAuth(requireBrand = null) {
  return (req, res, next) => {
    const token = req.headers['x-hq-token'] || req.query.t || req.cookies?.hq_token;
    const body = verify(token);
    if (!body) return res.status(401).json({ ok: false, err: 'INVALID_TOKEN' });
    if (body.kind !== 'session') return res.status(401).json({ ok: false, err: 'NOT_SESSION' });
    if (requireBrand && body.brand !== requireBrand) {
      return res.status(403).json({ ok: false, err: 'BRAND_MISMATCH' });
    }
    req.hqUser = body;
    next();
  };
}

module.exports = {
  issueMagicLink,
  issueSession,
  verify,
  consumeMagicLink,
  hqAuth,
};
