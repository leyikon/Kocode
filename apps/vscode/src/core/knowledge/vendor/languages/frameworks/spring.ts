// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { FrameworkConfig } from "../types";

export const springConfig = {
  id: "spring",
  displayName: "Spring Boot",
  languages: ["java", "kotlin"],
  detectionKeywords: [
    "spring-boot",
    "spring-boot-starter",
    "spring-web",
    "spring-data",
    "org.springframework",
  ],
  manifestFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
  promptSnippetPath: "./frameworks/spring.md",
  entryPoints: ["**/Application.java", "**/App.java"],
  layerHints: {
    controller: "api",
    service: "service",
    repository: "data",
    model: "data",
    entity: "data",
    config: "config",
    dto: "types",
    security: "middleware",
  },
} satisfies FrameworkConfig;
