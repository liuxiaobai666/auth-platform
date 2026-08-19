import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5273,
    proxy: {
      // 开发期直连本地授权中心，避免前端配置里出现跨域和硬编码域名
      '/api': { target: 'http://127.0.0.1:3100', changeOrigin: true },
    },
  },
});
