// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const makefileConfig = {
  id: "makefile",
  displayName: "Makefile",
  extensions: [".mk"],
  filenames: ["Makefile", "GNUmakefile", "makefile"],
  concepts: ["targets", "dependencies", "recipes", "variables", "pattern rules", "phony targets", "includes"],
  filePatterns: {
    entryPoints: ["Makefile"],
    barrels: [],
    tests: [],
    config: [],
  },
} satisfies LanguageConfig;
