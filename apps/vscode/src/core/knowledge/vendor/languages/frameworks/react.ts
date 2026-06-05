// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { FrameworkConfig } from "../types";

export const reactConfig = {
  id: "react",
  displayName: "React",
  languages: ["typescript", "javascript"],
  detectionKeywords: ["react", "react-dom", "@types/react"],
  manifestFiles: ["package.json"],
  promptSnippetPath: "./frameworks/react.md",
  entryPoints: ["src/App.tsx", "src/App.jsx", "src/index.tsx", "src/main.tsx"],
  layerHints: {
    components: "ui",
    hooks: "service",
    pages: "ui",
    contexts: "service",
    utils: "utility",
    lib: "service",
  },
} satisfies FrameworkConfig;
