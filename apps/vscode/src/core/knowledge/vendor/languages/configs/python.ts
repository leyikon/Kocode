// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const pythonConfig = {
  id: "python",
  displayName: "Python",
  extensions: [".py", ".pyi"],
  treeSitter: {
    wasmPackage: "tree-sitter-python",
    wasmFile: "tree-sitter-python.wasm",
  },
  concepts: [
    "decorators",
    "list comprehensions",
    "generators",
    "context managers",
    "type hints",
    "dunder methods",
    "metaclasses",
    "dataclasses",
    "async/await",
    "descriptors",
    "protocols",
  ],
  filePatterns: {
    entryPoints: [
      "main.py",
      "manage.py",
      "app.py",
      "wsgi.py",
      "asgi.py",
      "run.py",
      "__main__.py",
    ],
    barrels: ["__init__.py"],
    tests: ["test_*.py", "*_test.py", "conftest.py"],
    config: [
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
    ],
  },
} satisfies LanguageConfig;
