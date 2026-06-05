// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const javaConfig = {
  id: "java",
  displayName: "Java",
  extensions: [".java"],
  treeSitter: {
    wasmPackage: "tree-sitter-java",
    wasmFile: "tree-sitter-java.wasm",
  },
  concepts: [
    "generics",
    "annotations",
    "interfaces",
    "abstract classes",
    "streams API",
    "lambdas",
    "sealed classes",
    "records",
    "dependency injection",
    "checked exceptions",
  ],
  filePatterns: {
    entryPoints: [
      "**/Application.java",
      "**/Main.java",
      "src/main/java/**/App.java",
    ],
    barrels: [],
    tests: ["*Test.java", "*Tests.java", "*IT.java"],
    config: ["pom.xml", "build.gradle", "build.gradle.kts"],
  },
} satisfies LanguageConfig;
