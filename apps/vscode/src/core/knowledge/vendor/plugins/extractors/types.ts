// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { StructuralAnalysis, CallGraphEntry } from "../../types";

// [Kocode 适配] 上游基于 web-tree-sitter 0.26（命名导出 `Node`）。
// Kocode 当前固定在 web-tree-sitter 0.22.6，其节点类型为 `Parser.SyntaxNode`。
// 二者的 AST 节点 API（childCount/child/type/text/startPosition/endPosition）一致，
// 仅类型入口不同，因此此处把 TreeSitterNode 指向 0.22 的 SyntaxNode。
export type TreeSitterNode = import("web-tree-sitter").SyntaxNode;

/**
 * Language-specific extractor that maps a tree-sitter AST
 * to the common StructuralAnalysis / CallGraphEntry types.
 */
export interface LanguageExtractor {
  /** Language IDs this extractor handles (must match LanguageConfig.id) */
  languageIds: string[];

  /** Extract functions, classes, imports, exports from the root AST node */
  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis;

  /** Extract caller→callee relationships from the root AST node */
  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[];
}
