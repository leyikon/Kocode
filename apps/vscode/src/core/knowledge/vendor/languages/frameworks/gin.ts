// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { FrameworkConfig } from "../types";

export const ginConfig = {
  id: "gin",
  displayName: "Gin",
  languages: ["go"],
  detectionKeywords: ["github.com/gin-gonic/gin"],
  manifestFiles: ["go.mod"],
  promptSnippetPath: "./frameworks/gin.md",
  entryPoints: ["main.go", "cmd/server/main.go"],
  layerHints: {
    handlers: "api",
    routes: "api",
    models: "data",
    middleware: "middleware",
    services: "service",
    repository: "data",
  },
} satisfies FrameworkConfig;
