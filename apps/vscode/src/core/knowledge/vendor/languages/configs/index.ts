// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";
import { typescriptConfig } from "./typescript";
import { javascriptConfig } from "./javascript";
import { pythonConfig } from "./python";
import { goConfig } from "./go";
import { rustConfig } from "./rust";
import { javaConfig } from "./java";
import { rubyConfig } from "./ruby";
import { phpConfig } from "./php";
import { swiftConfig } from "./swift";
import { kotlinConfig } from "./kotlin";
import { cConfig } from "./c";
import { cppConfig } from "./cpp";
import { csharpConfig } from "./csharp";
import { luaConfig } from "./lua";
// Non-code language configs
import { markdownConfig } from "./markdown";
import { yamlConfig } from "./yaml";
import { jsonConfigConfig } from "./json-config";
import { tomlConfig } from "./toml";
import { envConfig } from "./env";
import { xmlConfig } from "./xml";
import { dockerfileConfig } from "./dockerfile";
import { sqlConfig } from "./sql";
import { graphqlConfig } from "./graphql";
import { protobufConfig } from "./protobuf";
import { terraformConfig } from "./terraform";
import { githubActionsConfig } from "./github-actions";
import { makefileConfig } from "./makefile";
import { shellConfig } from "./shell";
import { htmlConfig } from "./html";
import { cssConfig } from "./css";
import { openapiConfig } from "./openapi";
import { kubernetesConfig } from "./kubernetes";
import { dockerComposeConfig } from "./docker-compose";
import { jsonSchemaConfig } from "./json-schema";
import { csvConfig } from "./csv";
import { restructuredtextConfig } from "./restructuredtext";
import { powershellConfig } from "./powershell";
import { batchConfig } from "./batch";
import { jenkinsfileConfig } from "./jenkinsfile";
import { plaintextConfig } from "./plaintext";

export const builtinLanguageConfigs: LanguageConfig[] = [
  // Code languages
  typescriptConfig,
  javascriptConfig,
  pythonConfig,
  goConfig,
  rustConfig,
  javaConfig,
  rubyConfig,
  phpConfig,
  swiftConfig,
  kotlinConfig,
  luaConfig,
  cConfig,
  cppConfig,
  csharpConfig,
  // Non-code languages
  markdownConfig,
  yamlConfig,
  jsonConfigConfig,
  tomlConfig,
  envConfig,
  xmlConfig,
  dockerfileConfig,
  sqlConfig,
  graphqlConfig,
  protobufConfig,
  terraformConfig,
  githubActionsConfig,
  makefileConfig,
  shellConfig,
  htmlConfig,
  cssConfig,
  openapiConfig,
  kubernetesConfig,
  dockerComposeConfig,
  jsonSchemaConfig,
  csvConfig,
  restructuredtextConfig,
  powershellConfig,
  batchConfig,
  jenkinsfileConfig,
  plaintextConfig,
];

export {
  // Code languages
  typescriptConfig,
  javascriptConfig,
  pythonConfig,
  goConfig,
  rustConfig,
  javaConfig,
  rubyConfig,
  phpConfig,
  swiftConfig,
  kotlinConfig,
  luaConfig,
  cConfig,
  cppConfig,
  csharpConfig,
  // Non-code languages
  markdownConfig,
  yamlConfig,
  jsonConfigConfig,
  tomlConfig,
  envConfig,
  xmlConfig,
  dockerfileConfig,
  sqlConfig,
  graphqlConfig,
  protobufConfig,
  terraformConfig,
  githubActionsConfig,
  makefileConfig,
  shellConfig,
  htmlConfig,
  cssConfig,
  openapiConfig,
  kubernetesConfig,
  dockerComposeConfig,
  jsonSchemaConfig,
  csvConfig,
  restructuredtextConfig,
  powershellConfig,
  batchConfig,
  jenkinsfileConfig,
  plaintextConfig,
};
