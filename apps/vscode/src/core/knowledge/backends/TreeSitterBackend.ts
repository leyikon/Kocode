import * as path from "path"
import Parser from "web-tree-sitter"
import { Logger } from "@/shared/services/Logger"
import type { TreeSitterNode } from "../vendor/plugins/extractors/types"
import { builtinExtractors, type LanguageExtractor } from "../vendor/plugins/extractors/index"
import type { AnalyzerPlugin, CallGraphEntry, ImportResolution, StructuralAnalysis } from "../vendor/types"

/**
 * Tier 0 结构提取后端(R11 B 类:保留上游算法,替换 tree-sitter 加载后端)。
 *
 * 上游 TreeSitterPlugin 通过 `createRequire` + `require.resolve` 从 npm 包路径加载
 * wasm 语法;Kocode 的 wasm 已由 esbuild 复制到 dist 目录,统一用
 * `Parser.Language.load(path.join(__dirname, "tree-sitter-<lang>.wasm"))` 加载。
 *
 * 本类:
 * - 实现 vendor 的 AnalyzerPlugin 接口,可直接注册进 vendor 的 PluginRegistry;
 * - 复用 vendor 的 9 个语言 extractor(纯 AST 函数)做结构提取;
 * - 缺少 extractor 的受支持语言(如 swift/kotlin)降级为"无结构",由上层创建文件级节点
 *   (满足需求 R1.4:不支持的语言仍建文件节点但不提取符号)。
 */

const EMPTY_ANALYSIS: StructuralAnalysis = { functions: [], classes: [], imports: [], exports: [] }

// 扩展名 → Kocode wasm 语法 key(对应 dist/tree-sitter-<wasmKey>.wasm)。
// 与 services/tree-sitter/languageParser.ts 的映射保持一致。
const EXT_TO_WASM: Record<string, string> = {
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	tsx: "tsx",
	py: "python",
	rs: "rust",
	go: "go",
	cpp: "cpp",
	hpp: "cpp",
	cc: "cpp",
	c: "c",
	h: "c",
	cs: "c_sharp",
	rb: "ruby",
	java: "java",
	php: "php",
	swift: "swift",
	kt: "kotlin",
}

// wasm 语法 key → extractor 的 languageId。
// extractor 的 languageIds 用上游语言命名(typescript/javascript/csharp/cpp...)。
// 注意:tsx 与 c_sharp 需要映射到 extractor 的命名。
const WASM_KEY_TO_LANG_ID: Record<string, string> = {
	javascript: "javascript",
	typescript: "typescript",
	tsx: "typescript",
	python: "python",
	rust: "rust",
	go: "go",
	cpp: "cpp",
	c: "cpp", // 上游 cpp-extractor 同时处理 C
	c_sharp: "csharp",
	ruby: "ruby",
	java: "java",
	php: "php",
}

export class TreeSitterBackend implements AnalyzerPlugin {
	readonly name = "kocode-tree-sitter"
	readonly languages: string[]

	private initialized = false
	private readonly loadedLanguages = new Map<string, Parser.Language>()
	private readonly extractorsByLangId = new Map<string, LanguageExtractor>()
	private readonly wasmDir: string

	/**
	 * @param wasmDir wasm 语法文件所在目录。默认 __dirname:
	 *   打包后(esbuild)__dirname 即 dist/,wasm 已被 copyWasmFiles 复制到此处。
	 *   测试/脚本环境可显式传入(如指向 dist/),因为 ts-node 下 __dirname 是源码目录、无 wasm。
	 */
	constructor(wasmDir?: string) {
		this.wasmDir = wasmDir ?? __dirname
		this.languages = Object.keys(WASM_KEY_TO_LANG_ID)
		for (const extractor of builtinExtractors) {
			for (const id of extractor.languageIds) {
				this.extractorsByLangId.set(id, extractor)
			}
		}
	}

	/** 加载 web-tree-sitter 运行时(幂等)。语法按需懒加载。 */
	async init(): Promise<void> {
		if (this.initialized) {
			return
		}
		await Parser.init()
		this.initialized = true
	}

	private wasmKeyFromPath(filePath: string): string | null {
		const ext = path.extname(filePath).toLowerCase().slice(1)
		return EXT_TO_WASM[ext] ?? null
	}

	private async loadLanguage(wasmKey: string): Promise<Parser.Language | null> {
		const cached = this.loadedLanguages.get(wasmKey)
		if (cached) {
			return cached
		}
		try {
			const wasmPath = path.join(this.wasmDir, `tree-sitter-${wasmKey}.wasm`)
			const language = await Parser.Language.load(wasmPath)
			this.loadedLanguages.set(wasmKey, language)
			return language
		} catch (error) {
			Logger.error(`[TreeSitterBackend] 加载 wasm 语法失败: ${wasmKey}`, error as Error)
			return null
		}
	}

	private getExtractor(wasmKey: string): LanguageExtractor | null {
		const langId = WASM_KEY_TO_LANG_ID[wasmKey]
		if (!langId) {
			return null
		}
		return this.extractorsByLangId.get(langId) ?? null
	}

	/**
	 * 解析单个文件并返回结构分析。
	 * web-tree-sitter 的 parse 是同步的,但语法加载是异步的,因此提供 async 版本预加载语法。
	 */
	async parseFile(filePath: string, content: string): Promise<StructuralAnalysis> {
		await this.init()
		const wasmKey = this.wasmKeyFromPath(filePath)
		if (!wasmKey) {
			return EMPTY_ANALYSIS
		}
		const language = await this.loadLanguage(wasmKey)
		if (!language) {
			return EMPTY_ANALYSIS
		}
		const extractor = this.getExtractor(wasmKey)
		if (!extractor) {
			// 受支持的 wasm 但无 extractor(如 swift/kotlin):降级为无结构。
			return EMPTY_ANALYSIS
		}
		try {
			const parser = new Parser()
			parser.setLanguage(language)
			const tree = parser.parse(content)
			if (!tree?.rootNode) {
				return EMPTY_ANALYSIS
			}
			const result = extractor.extractStructure(tree.rootNode as unknown as TreeSitterNode)
			return result
		} catch (error) {
			Logger.error(`[TreeSitterBackend] 解析文件失败: ${filePath}`, error as Error)
			return EMPTY_ANALYSIS
		}
	}

	/**
	 * AnalyzerPlugin 同步接口。要求调用方先通过 prewarm() 预加载所需语法,
	 * 否则首次遇到未加载语法时返回空结构(不阻塞)。
	 */
	analyzeFile(filePath: string, content: string): StructuralAnalysis {
		const wasmKey = this.wasmKeyFromPath(filePath)
		if (!wasmKey) {
			return EMPTY_ANALYSIS
		}
		const language = this.loadedLanguages.get(wasmKey)
		if (!language) {
			Logger.warn(`[TreeSitterBackend] 语法未预加载,跳过结构提取: ${wasmKey} (${filePath})`)
			return EMPTY_ANALYSIS
		}
		const extractor = this.getExtractor(wasmKey)
		if (!extractor) {
			return EMPTY_ANALYSIS
		}
		try {
			const parser = new Parser()
			parser.setLanguage(language)
			const tree = parser.parse(content)
			if (!tree?.rootNode) {
				return EMPTY_ANALYSIS
			}
			return extractor.extractStructure(tree.rootNode as unknown as TreeSitterNode)
		} catch (error) {
			Logger.error(`[TreeSitterBackend] 解析文件失败: ${filePath}`, error as Error)
			return EMPTY_ANALYSIS
		}
	}

	resolveImports(filePath: string, content: string): ImportResolution[] {
		const analysis = this.analyzeFile(filePath, content)
		const dir = path.dirname(filePath)
		return analysis.imports.map((imp) => {
			let resolvedPath: string
			if (imp.source.startsWith("./") || imp.source.startsWith("../")) {
				resolvedPath = path.resolve(dir, imp.source)
			} else {
				resolvedPath = imp.source
			}
			return { source: imp.source, resolvedPath, specifiers: imp.specifiers }
		})
	}

	extractCallGraph(filePath: string, content: string): CallGraphEntry[] {
		const wasmKey = this.wasmKeyFromPath(filePath)
		if (!wasmKey) {
			return []
		}
		const language = this.loadedLanguages.get(wasmKey)
		if (!language) {
			return []
		}
		const extractor = this.getExtractor(wasmKey)
		if (!extractor) {
			return []
		}
		try {
			const parser = new Parser()
			parser.setLanguage(language)
			const tree = parser.parse(content)
			if (!tree?.rootNode) {
				return []
			}
			return extractor.extractCallGraph(tree.rootNode as unknown as TreeSitterNode)
		} catch (error) {
			Logger.error(`[TreeSitterBackend] 调用图提取失败: ${filePath}`, error as Error)
			return []
		}
	}

	/** 预加载一批文件涉及的全部语法,使后续同步 analyzeFile 可用。 */
	async prewarm(filePaths: string[]): Promise<void> {
		await this.init()
		const wasmKeys = new Set<string>()
		for (const filePath of filePaths) {
			const key = this.wasmKeyFromPath(filePath)
			if (key) {
				wasmKeys.add(key)
			}
		}
		await Promise.all([...wasmKeys].map((key) => this.loadLanguage(key)))
	}
}
