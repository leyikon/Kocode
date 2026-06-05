// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

// Types
export type {
  LanguageConfig,
  TreeSitterConfig,
  FilePatternConfig,
  FrameworkConfig,
} from "./types";

export {
  LanguageConfigSchema,
  TreeSitterConfigSchema,
  FilePatternConfigSchema,
  FrameworkConfigSchema,
} from "./types";

// Registries
export { LanguageRegistry } from "./language-registry";
export { FrameworkRegistry } from "./framework-registry";

// Built-in configs
export { builtinLanguageConfigs } from "./configs/index";
export { builtinFrameworkConfigs } from "./frameworks/index";
