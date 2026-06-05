import { ClineEnv } from "@/config"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import {
    buildFileAnalysisPrompt,
    buildProjectSummaryPrompt,
    type LLMFileAnalysis,
    type LLMProjectSummary,
    parseFileAnalysisResponse,
    parseProjectSummaryResponse,
} from "../vendor/analyzer/llm-analyzer"

/**
 * Tier 1 语义分析后端(R11 B 类:复用上游 prompt/解析纯函数,替换为 Kocode 便宜模型后端)。
 *
 * - prompt 构建与响应解析全部复用 vendor 的 llm-analyzer 纯函数;
 * - 实际请求走 Kocode 的 Flash relay(与 FlashModelClient 同端点同模型 deepseek-v4-flash);
 * - 不引入新的模型配置项(满足 R2.4 / R8.6);
 * - 支持取消(AbortSignal)、超时与 token 用量累计(R8)。
 */

const FLASH_MODEL_ID = "deepseek-v4-flash"
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 2

export interface FlashUsage {
	promptTokens: number
	completionTokens: number
	totalTokens: number
	requests: number
}

export interface SemanticAnalyzeOptions {
	/** 注入到 prompt 的项目背景(语言/框架等),便于模型理解上下文。 */
	projectContext: string
	/** 外部取消信号(R8.2:取消后停止后续调用)。 */
	signal?: AbortSignal
}

export class FlashSemanticCancelledError extends Error {
	constructor() {
		super("Flash 语义分析已取消")
		this.name = "FlashSemanticCancelledError"
	}
}

export class FlashSemanticAnalyzer {
	private readonly usage: FlashUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 }

	constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

	getUsage(): FlashUsage {
		return { ...this.usage }
	}

	/** 对单个文件生成语义分析(Tier 1)。失败返回 null,由上层降级保留结构信息(R2.5)。 */
	async analyzeFile(
		filePath: string,
		content: string,
		options: SemanticAnalyzeOptions,
	): Promise<LLMFileAnalysis | null> {
		const prompt = buildFileAnalysisPrompt(filePath, content, options.projectContext)
		const raw = await this.requestCompletion(prompt, options.signal)
		if (raw == null) {
			return null
		}
		return parseFileAnalysisResponse(raw)
	}

	/** 生成项目级摘要(描述/框架/层划分提示)。失败返回 null。 */
	async analyzeProject(
		fileList: string[],
		sampleFiles: Array<{ path: string; content: string }>,
		signal?: AbortSignal,
	): Promise<LLMProjectSummary | null> {
		const prompt = buildProjectSummaryPrompt(fileList, sampleFiles)
		const raw = await this.requestCompletion(prompt, signal)
		if (raw == null) {
			return null
		}
		return parseProjectSummaryResponse(raw)
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) {
			throw new FlashSemanticCancelledError()
		}
	}

	/**
	 * 调用 Flash relay 做一次补全。返回模型文本内容;失败返回 null(由调用方降级)。
	 * 取消信号触发时抛出 FlashSemanticCancelledError 以便上层停止整个批次。
	 */
	private async requestCompletion(prompt: string, externalSignal?: AbortSignal): Promise<string | null> {
		let lastError: unknown
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			this.throwIfAborted(externalSignal)
			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
			const onExternalAbort = () => controller.abort()
			externalSignal?.addEventListener("abort", onExternalAbort, { once: true })
			try {
				const response = await fetch(`${ClineEnv.config().apiBaseUrl}/api/v1/chat/completions`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: "Bearer kocode-direct-dev" },
					body: JSON.stringify({
						model: FLASH_MODEL_ID,
						stream: false,
						max_tokens: 700,
						thinking: { type: "disabled" },
						response_format: { type: "json_object" },
						messages: [{ role: "user", content: prompt }],
					}),
					signal: controller.signal,
				})
				const bodyText = await response.text()
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}: ${bodyText.slice(0, 200)}`)
				}
				const payload = JSON.parse(bodyText)
				this.accumulateUsage(payload?.usage)
				const content = payload?.choices?.[0]?.message?.content
				return typeof content === "string" ? content : JSON.stringify(content)
			} catch (error) {
				// 外部取消优先:直接抛出,让整个批次停止。
				if (externalSignal?.aborted) {
					throw new FlashSemanticCancelledError()
				}
				lastError = error
				Logger.warn(`[FlashSemanticAnalyzer] 请求失败(尝试 ${attempt}/${MAX_ATTEMPTS}): ${String(error)}`)
			} finally {
				clearTimeout(timeout)
				externalSignal?.removeEventListener("abort", onExternalAbort)
			}
		}
		Logger.error("[FlashSemanticAnalyzer] 语义分析请求全部失败", lastError as Error)
		return null
	}

	private accumulateUsage(usage: unknown): void {
		this.usage.requests += 1
		if (usage && typeof usage === "object") {
			const u = usage as Record<string, unknown>
			const prompt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0
			const completion = typeof u.completion_tokens === "number" ? u.completion_tokens : 0
			const total = typeof u.total_tokens === "number" ? u.total_tokens : prompt + completion
			this.usage.promptTokens += prompt
			this.usage.completionTokens += completion
			this.usage.totalTokens += total
		}
	}
}
