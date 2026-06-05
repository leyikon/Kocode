// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { FrameworkConfig } from "../types";

export const flaskConfig = {
  id: "flask",
  displayName: "Flask",
  languages: ["python"],
  detectionKeywords: [
    "flask",
    "flask-restful",
    "flask-sqlalchemy",
    "flask-marshmallow",
    "flask-wtf",
  ],
  manifestFiles: [
    "requirements.txt",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "Pipfile",
  ],
  promptSnippetPath: "./frameworks/flask.md",
  entryPoints: ["app.py", "run.py", "wsgi.py"],
  layerHints: {
    blueprints: "api",
    views: "api",
    models: "data",
    forms: "ui",
    templates: "ui",
    extensions: "config",
  },
} satisfies FrameworkConfig;
