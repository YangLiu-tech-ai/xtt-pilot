import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// HQ H5 三品牌共用工程，通过 --base 切换部署前缀
// dev 时通过 ?brand=csnc|xq|txp query 参数模拟
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE || 'http://localhost:7788',
        changeOrigin: true,
      },
    },
  },
});
