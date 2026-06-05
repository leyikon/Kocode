// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

// TODO: JSON Schema files have no unique extension — *.schema.json files will match
// `jsonConfigConfig` by the `.json` extension. Detection requires content-based
// heuristics (e.g., checking for `"$schema"` or `"type"` keys at the root level).
// A future content-based detection pass could re-classify them as JSON Schema.
export const jsonSchemaConfig = {
  id: "json-schema",
  displayName: "JSON Schema",
  extensions: [],
  concepts: ["types", "properties", "required fields", "$ref", "$defs", "allOf/anyOf/oneOf", "patterns", "validation"],
  filePatterns: {
    entryPoints: [],
    barrels: [],
    tests: [],
    config: [],
  },
} satisfies LanguageConfig;
