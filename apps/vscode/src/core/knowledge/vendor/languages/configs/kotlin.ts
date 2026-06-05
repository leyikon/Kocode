// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const kotlinConfig = {
  id: "kotlin",
  displayName: "Kotlin",
  extensions: [".kt", ".kts"],
  concepts: [
    "coroutines",
    "data classes",
    "sealed classes",
    "extension functions",
    "null safety",
    "delegation",
    "DSL builders",
    "inline functions",
    "companion objects",
    "flow",
  ],
  filePatterns: {
    entryPoints: ["**/Application.kt", "**/Main.kt"],
    barrels: [],
    tests: ["*Test.kt", "*Tests.kt"],
    config: ["build.gradle.kts", "build.gradle"],
  },
} satisfies LanguageConfig;
