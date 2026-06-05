// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { FrameworkConfig } from "../types";

export const djangoConfig = {
  id: "django",
  displayName: "Django",
  languages: ["python"],
  detectionKeywords: [
    "django",
    "djangorestframework",
    "django-rest-framework",
    "django-cors-headers",
    "django-filter",
  ],
  manifestFiles: [
    "requirements.txt",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "Pipfile",
  ],
  promptSnippetPath: "./frameworks/django.md",
  entryPoints: ["manage.py", "wsgi.py", "asgi.py"],
  layerHints: {
    views: "api",
    models: "data",
    serializers: "api",
    urls: "api",
    templates: "ui",
    migrations: "data",
    management: "config",
    signals: "service",
    admin: "config",
    forms: "ui",
    templatetags: "utility",
  },
} satisfies FrameworkConfig;
