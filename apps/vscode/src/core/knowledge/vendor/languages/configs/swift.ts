// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const swiftConfig = {
  id: "swift",
  displayName: "Swift",
  extensions: [".swift"],
  concepts: [
    "optionals",
    "protocols",
    "extensions",
    "generics",
    "closures",
    "property wrappers",
    "result builders",
    "actors",
    "structured concurrency",
    "value types vs reference types",
  ],
  filePatterns: {
    entryPoints: ["Sources/*/main.swift", "App.swift", "AppDelegate.swift"],
    barrels: [],
    tests: ["*Tests.swift", "Tests/**/*.swift"],
    config: ["Package.swift"],
  },
} satisfies LanguageConfig;
