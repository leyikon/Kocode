// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { FrameworkConfig } from "../types";

export const vueConfig = {
  id: "vue",
  displayName: "Vue",
  languages: ["typescript", "javascript"],
  detectionKeywords: ["vue", "@vue/cli-service", "nuxt", "vite-plugin-vue"],
  manifestFiles: ["package.json"],
  promptSnippetPath: "./frameworks/vue.md",
  entryPoints: ["src/main.ts", "src/App.vue", "src/main.js"],
  layerHints: {
    components: "ui",
    views: "ui",
    store: "service",
    composables: "service",
    router: "config",
    plugins: "config",
  },
} satisfies FrameworkConfig;
