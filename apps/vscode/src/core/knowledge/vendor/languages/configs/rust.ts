// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const rustConfig = {
  id: "rust",
  displayName: "Rust",
  extensions: [".rs"],
  treeSitter: {
    wasmPackage: "tree-sitter-rust",
    wasmFile: "tree-sitter-rust.wasm",
  },
  concepts: [
    "ownership",
    "borrowing",
    "lifetimes",
    "traits",
    "pattern matching",
    "enums with data",
    "error handling (Result/Option)",
    "macros",
    "async/await",
    "unsafe blocks",
    "generics",
    "closures",
  ],
  filePatterns: {
    entryPoints: ["src/main.rs", "src/lib.rs"],
    barrels: ["mod.rs", "lib.rs"],
    tests: ["tests/*.rs"],
    config: ["Cargo.toml"],
  },
} satisfies LanguageConfig;
