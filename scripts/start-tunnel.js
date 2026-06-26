/**
 * 新通途 MVP · 隧道启动脚本
 *
 * 使用 localtunnel 暴露 localhost:7788 到公网
 * localtunnel 有一个 "bypass reminder" 页面，首次访问需输入服务器公网 IP
 *
 * 用法:
 *   node start-tunnel.js
 *
 * 输出:
 *   - 公网 URL
 *   - bypass 密码 (即本机公网IP)
 *   - 完整的 H5 入口地址
 */
const lt = require('localtunnel');
const https = require('https');

const PORT = 7788;
const SUBDOMAIN = 'xtt-pilot';

// 获取公网 IP
function getPublicIP() {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org', { rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data.trim()));
    }).on('error', () => resolve('unknown'));
  });
}

(async () => {
  console.log('[tunnel] 正在连接 localtunnel...');

  try {
    const tunnel = await lt({ port: PORT, subdomain: SUBDOMAIN });
    const publicIP = await getPublicIP();

    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('  ✅ 隧道已建立');
    console.log('');
    console.log(`  公网地址: ${tunnel.url}`);
    console.log(`  Bypass密码: ${publicIP}`);
    console.log('');
    console.log('  ⚠️  课长首次打开链接时会看到一个提示页面');
    console.log(`     输入密码: ${publicIP} 后点击 Submit 即可`);
    console.log('     之后同一浏览器不再需要输入');
    console.log('');
    console.log('  接口验证:');
    console.log(`    ${tunnel.url}/v1/health`);
    console.log('');
    console.log('  H5 入口 (拼上 token 后推送):');
    console.log(`    ${tunnel.url}/h5/preview.html?token=<TOKEN>`);
    console.log('═══════════════════════════════════════════════════════');
    console.log('');
    console.log('[tunnel] 保持窗口打开... Ctrl+C 停止');

    tunnel.on('close', () => {
      console.log('[tunnel] 连接断开，正在重连...');
      process.exit(1);
    });

    tunnel.on('error', (err) => {
      console.error('[tunnel] 错误:', err.message);
    });

  } catch (err) {
    console.error('[tunnel] 启动失败:', err.message);
    console.error('[tunnel] 请确认:');
    console.error('  1. 网络连接正常');
    console.error('  2. server.js 在 7788 端口运行中');
    process.exit(1);
  }
})();
