// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const csharpConfig = {
  id: "csharp",
  displayName: "C#",
  extensions: [".cs"],
  treeSitter: {
    wasmPackage: "tree-sitter-c-sharp",
    wasmFile: "tree-sitter-c_sharp.wasm",
  },
  concepts: [
    "LINQ",
    "async/await",
    "generics",
    "properties",
    "delegates and events",
    "attributes",
    "nullable reference types",
    "pattern matching",
    "records",
    "dependency injection",
  ],
  filePatterns: {
    entryPoints: ["Program.cs", "**/Program.cs"],
    barrels: [],
    tests: ["*Tests.cs", "*Test.cs"],
    config: ["*.csproj", "*.sln"],
  },
} satisfies LanguageConfig;
