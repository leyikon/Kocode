// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const typescriptConfig = {
  id: "typescript",
  displayName: "TypeScript",
  extensions: [".ts", ".tsx"],
  treeSitter: {
    wasmPackage: "tree-sitter-typescript",
    wasmFile: "tree-sitter-typescript.wasm",
  },
  concepts: [
    "generics",
    "type guards",
    "discriminated unions",
    "utility types",
    "decorators",
    "enums",
    "interfaces",
    "type inference",
    "mapped types",
    "conditional types",
    "template literal types",
  ],
  filePatterns: {
    entryPoints: ["src/index.ts", "src/main.ts", "src/App.tsx", "index.ts"],
    barrels: ["index.ts"],
    tests: ["*.test.ts", "*.spec.ts", "*.test.tsx"],
    config: ["tsconfig.json"],
  },
} satisfies LanguageConfig;
