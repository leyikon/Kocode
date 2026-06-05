// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

export type { LanguageExtractor, TreeSitterNode } from "./types";
export { traverse, getStringValue, findChild, findChildren, hasChildOfType } from "./base-extractor";
export { TypeScriptExtractor } from "./typescript-extractor";
export { PythonExtractor } from "./python-extractor";
export { GoExtractor } from "./go-extractor";
export { RustExtractor } from "./rust-extractor";
export { JavaExtractor } from "./java-extractor";
export { RubyExtractor } from "./ruby-extractor";
export { PhpExtractor } from "./php-extractor";
export { CppExtractor } from "./cpp-extractor";
export { CSharpExtractor } from "./csharp-extractor";

import type { LanguageExtractor } from "./types";
import { TypeScriptExtractor } from "./typescript-extractor";
import { PythonExtractor } from "./python-extractor";
import { GoExtractor } from "./go-extractor";
import { RustExtractor } from "./rust-extractor";
import { JavaExtractor } from "./java-extractor";
import { RubyExtractor } from "./ruby-extractor";
import { PhpExtractor } from "./php-extractor";
import { CppExtractor } from "./cpp-extractor";
import { CSharpExtractor } from "./csharp-extractor";

export const builtinExtractors: LanguageExtractor[] = [
  new TypeScriptExtractor(),
  new PythonExtractor(),
  new GoExtractor(),
  new RustExtractor(),
  new JavaExtractor(),
  new RubyExtractor(),
  new PhpExtractor(),
  new CppExtractor(),
  new CSharpExtractor(),
];
