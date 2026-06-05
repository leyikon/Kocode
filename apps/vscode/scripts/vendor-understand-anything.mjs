// 从 Understand-Anything 上游 (MIT) 拉取纯算法源码到 Kocode 的 vendor 目录。
//
// 设计原则(对应需求 R11 复用约束):
// - A 类纯算法/数据模型文件:原样拉取,仅在文件头注入 vendor 说明注释。
// - B 类需换后端的文件(tree-sitter-plugin / llm-analyzer):本脚本不拉取,
//   由 Kocode 侧手写适配器,避免覆盖。
// - C 类(plugins 平台壳 / dashboard / install / agents):不拉取。
//
// 用法: node scripts/vendor-understand-anything.mjs
//
// 拉取后会把上游 import 里的 ".js" 后缀去掉以适配 Kocode 的 Bundler moduleResolution。

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = path.resolve(__dirname, "../src/core/knowledge/vendor")

const RAW_BASE =
	"https://raw.githubusercontent.com/Lum1104/Understand-Anything/main/understand-anything-plugin/packages/core/src"

// A 类:原样 vendor 的纯算法 / 数据模型文件(相对 core/src 的路径)。
// 注意:types.ts 已手动落地,这里不重复;tree-sitter-plugin.ts 与 llm-analyzer.ts
// 属于 B 类(换后端),不在此列表。
const FILES = [
	"schema.ts",
	"fingerprint.ts",
	"change-classifier.ts",
	"staleness.ts",
	"search.ts",
	"embedding-search.ts",
	// persistence:文件拆分(graph/meta/fingerprints/config/domain)+ 路径脱敏 + 校验,纯 IO 算法
	"persistence/index.ts",
	"ignore-filter.ts",
	"ignore-generator.ts",
	// analyzer 系列(graph-builder 依赖 plugin 接口,但算法本身纯净)
	"analyzer/graph-builder.ts",
	"analyzer/normalize-graph.ts",
	"analyzer/layer-detector.ts",
	"analyzer/tour-generator.ts",
	"analyzer/language-lesson.ts",
	// llm-analyzer:纯 prompt 构建 + JSON 解析函数(无 IO / 无 LLM 客户端依赖),
	// 实际"换后端"发生在 Kocode 侧的 FlashSemanticAnalyzer(负责发请求),此文件可原样 vendor。
	"analyzer/llm-analyzer.ts",
	// plugins/registry:纯协调器,桥接 AnalyzerPlugin 与上游算法(依赖已 vendor)
	"plugins/registry.ts",
	// extractors:纯 AST 函数,100% 可复用
	// 注意:extractors/types.ts 含 web-tree-sitter 版本适配(Node→SyntaxNode),
	// 属于 B 类换后端文件,由 Kocode 侧手工维护,不在自动拉取清单内。
	"plugins/extractors/base-extractor.ts",
	"plugins/extractors/index.ts",
	"plugins/extractors/typescript-extractor.ts",
	"plugins/extractors/python-extractor.ts",
	"plugins/extractors/go-extractor.ts",
	"plugins/extractors/rust-extractor.ts",
	"plugins/extractors/java-extractor.ts",
	"plugins/extractors/ruby-extractor.ts",
	"plugins/extractors/php-extractor.ts",
	"plugins/extractors/cpp-extractor.ts",
	"plugins/extractors/csharp-extractor.ts",
	// languages 注册表与配置
	"languages/index.ts",
	"languages/types.ts",
	"languages/language-registry.ts",
	"languages/framework-registry.ts",
	// languages/configs:38 个内置语言配置
	"languages/configs/index.ts",
	"languages/configs/batch.ts",
	"languages/configs/c.ts",
	"languages/configs/cpp.ts",
	"languages/configs/csharp.ts",
	"languages/configs/css.ts",
	"languages/configs/csv.ts",
	"languages/configs/docker-compose.ts",
	"languages/configs/dockerfile.ts",
	"languages/configs/env.ts",
	"languages/configs/github-actions.ts",
	"languages/configs/go.ts",
	"languages/configs/graphql.ts",
	"languages/configs/html.ts",
	"languages/configs/java.ts",
	"languages/configs/javascript.ts",
	"languages/configs/jenkinsfile.ts",
	"languages/configs/json-config.ts",
	"languages/configs/json-schema.ts",
	"languages/configs/kotlin.ts",
	"languages/configs/kubernetes.ts",
	"languages/configs/lua.ts",
	"languages/configs/makefile.ts",
	"languages/configs/markdown.ts",
	"languages/configs/openapi.ts",
	"languages/configs/php.ts",
	"languages/configs/plaintext.ts",
	"languages/configs/powershell.ts",
	"languages/configs/protobuf.ts",
	"languages/configs/python.ts",
	"languages/configs/restructuredtext.ts",
	"languages/configs/ruby.ts",
	"languages/configs/rust.ts",
	"languages/configs/shell.ts",
	"languages/configs/sql.ts",
	"languages/configs/swift.ts",
	"languages/configs/terraform.ts",
	"languages/configs/toml.ts",
	"languages/configs/typescript.ts",
	"languages/configs/xml.ts",
	"languages/configs/yaml.ts",
	// languages/frameworks:11 个内置框架配置
	"languages/frameworks/index.ts",
	"languages/frameworks/django.ts",
	"languages/frameworks/express.ts",
	"languages/frameworks/fastapi.ts",
	"languages/frameworks/flask.ts",
	"languages/frameworks/gin.ts",
	"languages/frameworks/nextjs.ts",
	"languages/frameworks/rails.ts",
	"languages/frameworks/react.ts",
	"languages/frameworks/spring.ts",
	"languages/frameworks/vue.ts",
]

const VENDOR_HEADER = `// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。
`

function stripJsExtensions(source) {
	// 把 from "./x.js" / from "../x.js" 改为去掉 .js,适配 Bundler moduleResolution。
	return source.replace(/(from\s+["'])(\.{1,2}\/[^"']+?)\.js(["'])/g, "$1$2$3")
}

async function main() {
	for (const rel of FILES) {
		const url = `${RAW_BASE}/${rel}`
		const res = await fetch(url)
		if (!res.ok) {
			console.error(`✘ 拉取失败 ${rel}: HTTP ${res.status}`)
			process.exitCode = 1
			continue
		}
		let source = await res.text()
		source = stripJsExtensions(source)
		const dest = path.join(VENDOR_ROOT, rel)
		await fs.mkdir(path.dirname(dest), { recursive: true })
		await fs.writeFile(dest, VENDOR_HEADER + "\n" + source, "utf8")
		console.log(`✔ ${rel} (${source.length} chars)`)
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
