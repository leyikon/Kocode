// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { FrameworkConfig } from "../types";

export const railsConfig = {
  id: "rails",
  displayName: "Ruby on Rails",
  languages: ["ruby"],
  detectionKeywords: [
    "rails",
    "railties",
    "actionpack",
    "activerecord",
    "actionview",
  ],
  manifestFiles: ["Gemfile"],
  promptSnippetPath: "./frameworks/rails.md",
  entryPoints: ["config.ru", "bin/rails"],
  layerHints: {
    controllers: "api",
    models: "data",
    views: "ui",
    helpers: "utility",
    mailers: "service",
    jobs: "service",
    channels: "service",
    middleware: "middleware",
    lib: "service",
  },
} satisfies FrameworkConfig;
