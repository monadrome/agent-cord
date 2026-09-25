import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发期：/api 全部代理到本地 server（默认 http://127.0.0.1:7250），前端不感知后端地址
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:7250", changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
