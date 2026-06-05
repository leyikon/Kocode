// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const xmlConfig = {
  id: "xml",
  displayName: "XML",
  extensions: [".xml", ".xsl", ".xsd", ".svg", ".plist"],
  concepts: ["elements", "attributes", "namespaces", "DTD", "XPath", "XSLT", "schemas"],
  filePatterns: {
    entryPoints: [],
    barrels: [],
    tests: [],
    config: ["pom.xml", "web.xml", "AndroidManifest.xml"],
  },
} satisfies LanguageConfig;
