// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const javascriptConfig = {
  id: "javascript",
  displayName: "JavaScript",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  treeSitter: {
    wasmPackage: "tree-sitter-javascript",
    wasmFile: "tree-sitter-javascript.wasm",
  },
  concepts: [
    "closures",
    "prototypes",
    "promises",
    "async/await",
    "event loop",
    "destructuring",
    "spread operator",
    "proxies",
    "generators",
    "modules (ESM/CJS)",
  ],
  filePatterns: {
    entryPoints: ["index.js", "src/index.js", "main.js"],
    barrels: ["index.js"],
    tests: ["*.test.js", "*.spec.js"],
    config: ["package.json", "jsconfig.json"],
  },
} satisfies LanguageConfig;
