// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

export const dockerComposeConfig = {
  id: "docker-compose",
  displayName: "Docker Compose",
  extensions: [],
  filenames: ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
  concepts: ["services", "networks", "volumes", "ports", "environment", "depends_on", "build context", "healthchecks"],
  filePatterns: {
    entryPoints: ["docker-compose.yml", "compose.yml"],
    barrels: [],
    tests: [],
    config: [],
  },
} satisfies LanguageConfig;
