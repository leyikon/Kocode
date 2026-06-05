// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { FrameworkConfig } from "../types";

import { djangoConfig } from "./django";
import { fastapiConfig } from "./fastapi";
import { flaskConfig } from "./flask";
import { reactConfig } from "./react";
import { nextjsConfig } from "./nextjs";
import { expressConfig } from "./express";
import { vueConfig } from "./vue";
import { springConfig } from "./spring";
import { railsConfig } from "./rails";
import { ginConfig } from "./gin";

export const builtinFrameworkConfigs: FrameworkConfig[] = [
  djangoConfig,
  fastapiConfig,
  flaskConfig,
  reactConfig,
  nextjsConfig,
  expressConfig,
  vueConfig,
  springConfig,
  railsConfig,
  ginConfig,
];

export {
  djangoConfig,
  fastapiConfig,
  flaskConfig,
  reactConfig,
  nextjsConfig,
  expressConfig,
  vueConfig,
  springConfig,
  railsConfig,
  ginConfig,
};
