// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const cConfig = {
  id: "c",
  displayName: "C",
  extensions: [".c", ".h"],
  treeSitter: {
    wasmPackage: "tree-sitter-cpp",
    wasmFile: "tree-sitter-cpp.wasm",
  },
  concepts: [
    "pointers",
    "manual memory management",
    "structs",
    "unions",
    "function pointers",
    "preprocessor macros",
    "header files",
    "static vs dynamic linking",
  ],
  filePatterns: {
    entryPoints: ["main.c", "src/main.c"],
    barrels: [],
    tests: ["*_test.c", "test_*.c"],
    config: ["Makefile", "CMakeLists.txt", "meson.build"],
  },
} satisfies LanguageConfig;
