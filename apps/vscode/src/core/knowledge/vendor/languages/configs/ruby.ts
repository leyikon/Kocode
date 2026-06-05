// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const rubyConfig = {
  id: "ruby",
  displayName: "Ruby",
  extensions: [".rb", ".rake"],
  treeSitter: {
    wasmPackage: "tree-sitter-ruby",
    wasmFile: "tree-sitter-ruby.wasm",
  },
  concepts: [
    "blocks and procs",
    "mixins",
    "metaprogramming",
    "duck typing",
    "DSLs",
    "monkey patching",
    "symbols",
    "method_missing",
    "open classes",
  ],
  filePatterns: {
    entryPoints: ["config.ru", "app.rb"],
    barrels: [],
    tests: ["*_test.rb", "*_spec.rb", "spec_helper.rb"],
    config: ["Gemfile", "Rakefile"],
  },
} satisfies LanguageConfig;
