// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { FrameworkConfig } from "../types";

export const nextjsConfig = {
  id: "nextjs",
  displayName: "Next.js",
  languages: ["typescript", "javascript"],
  detectionKeywords: ["\"next\":", "@next/font", "@next/image"],
  manifestFiles: ["package.json"],
  promptSnippetPath: "./frameworks/nextjs.md",
  entryPoints: [
    "src/app/layout.tsx",
    "pages/_app.tsx",
    "src/pages/_app.tsx",
  ],
  layerHints: {
    app: "ui",
    pages: "ui",
    api: "api",
    components: "ui",
    lib: "service",
    middleware: "middleware",
  },
} satisfies FrameworkConfig;
