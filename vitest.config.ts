import { defineConfig } from "vitest/config";

export default defineConfig({
  // 让 workspace 内的 "agent-cord" 解析到 src（exports.development），测试不依赖 dist 构建产物
  resolve: { conditions: ["development"] },
  test: {
    include: ["tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
});
