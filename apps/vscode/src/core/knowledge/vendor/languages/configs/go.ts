// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const goConfig = {
  id: "go",
  displayName: "Go",
  extensions: [".go"],
  treeSitter: {
    wasmPackage: "tree-sitter-go",
    wasmFile: "tree-sitter-go.wasm",
  },
  concepts: [
    "goroutines",
    "channels",
    "interfaces",
    "struct embedding",
    "error handling patterns",
    "defer/panic/recover",
    "slices",
    "pointers",
    "concurrency patterns",
  ],
  filePatterns: {
    entryPoints: ["main.go", "cmd/*/main.go"],
    barrels: [],
    tests: ["*_test.go"],
    config: ["go.mod", "go.sum"],
  },
} satisfies LanguageConfig;
