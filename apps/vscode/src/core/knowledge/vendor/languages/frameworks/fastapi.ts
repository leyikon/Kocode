// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { FrameworkConfig } from "../types";

export const fastapiConfig = {
  id: "fastapi",
  displayName: "FastAPI",
  languages: ["python"],
  detectionKeywords: ["fastapi", "uvicorn", "starlette"],
  manifestFiles: [
    "requirements.txt",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "Pipfile",
  ],
  promptSnippetPath: "./frameworks/fastapi.md",
  entryPoints: ["main.py", "app.py"],
  layerHints: {
    routers: "api",
    schemas: "types",
    models: "data",
    dependencies: "service",
    crud: "service",
    api: "api",
  },
} satisfies FrameworkConfig;
