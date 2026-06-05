// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { FrameworkConfig } from "../types";

export const expressConfig = {
  id: "express",
  displayName: "Express",
  languages: ["javascript", "typescript"],
  detectionKeywords: ["\"express\":", "express-validator", "express-session"],
  manifestFiles: ["package.json"],
  promptSnippetPath: "./frameworks/express.md",
  entryPoints: [
    "src/index.js",
    "src/app.js",
    "server.js",
    "app.js",
    "src/index.ts",
    "src/app.ts",
  ],
  layerHints: {
    routes: "api",
    controllers: "service",
    models: "data",
    middleware: "middleware",
    services: "service",
    db: "data",
  },
} satisfies FrameworkConfig;
