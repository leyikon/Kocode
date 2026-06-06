import { type ApiHandler, buildApiHandler } from "@core/api"
import type { ApiStreamUsageChunk } from "@core/api/transform/stream"
import { StateManager } from "@/core/storage/StateManager"
import type { ApiConfiguration } from "@/shared/api"
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
 * Tier 1 语义分析后端。
 *
 * 这里不再直接调用固定 relay / 固定 token,而是复用 Kocode 现有 ApiHandler:
 * - 使用用户当前 Act 模式 provider 与鉴权配置;
 * - 禁用 thinking budget,避免为结构摘要消耗推理预算;
 * - 聚合流式响应后交给上游 JSON 解析纯函数;
 * - 通过 ApiHandler.abort() 接入取消与超时。
 */

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 2
const SYSTEM_PROMPT = "You analyze code and return only valid JSON. Do not include markdown or commentary."

export interface KocodeSemanticUsage {
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

export class KocodeSemanticCancelledError extends Error {
	constructor() {
		super("Kocode 语义分析已取消")
		this.name = "KocodeSemanticCancelledError"
	}
}

export class KocodeSemanticAnalyzer {
	private readonly usage: KocodeSemanticUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 }

	constructor(
		private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
		private readonly apiConfiguration?: ApiConfiguration,
	) {}

	getUsage(): KocodeSemanticUsage {
		return { ...this.usage }
	}

	/** 对单个文件生成语义分析(Tier 1)。失败返回 null,由上层降级保留结构信息(R2.5)。 */
	async analyzeFile(filePath: string, content: string, options: SemanticAnalyzeOptions): Promise<LLMFileAnalysis | null> {
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
			throw new KocodeSemanticCancelledError()
		}
	}

	private buildSemanticHandler(): ApiHandler {
		const baseConfig = this.apiConfiguration ?? StateManager.get().getApiConfiguration()
		const configuredTimeout =
			typeof baseConfig.requestTimeoutMs === "number" && baseConfig.requestTimeoutMs > 0
				? Math.min(baseConfig.requestTimeoutMs, this.timeoutMs)
				: this.timeoutMs

		return buildApiHandler(
			{
				...baseConfig,
				requestTimeoutMs: configuredTimeout,
				actModeThinkingBudgetTokens: 0,
				planModeThinkingBudgetTokens: 0,
			},
			"act",
		)
	}

	/**
	 * 通过 Kocode ApiHandler 做一次补全。返回模型文本内容;失败返回 null(由调用方降级)。
	 * 取消信号触发时抛出 KocodeSemanticCancelledError 以便上层停止整个批次。
	 */
	private async requestCompletion(prompt: string, externalSignal?: AbortSignal): Promise<string | null> {
		let lastError: unknown
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			this.throwIfAborted(externalSignal)
			let timedOut = false
			let apiHandler: ApiHandler | undefined
			try {
				apiHandler = this.buildSemanticHandler()
				const timeout = setTimeout(() => {
					timedOut = true
					apiHandler?.abort?.()
				}, this.timeoutMs)
				const onExternalAbort = () => apiHandler?.abort?.()
				externalSignal?.addEventListener("abort", onExternalAbort, { once: true })
				try {
					const stream = apiHandler.createMessage(SYSTEM_PROMPT, [{ role: "user", content: prompt }])
					let content = ""
					let sawUsage = false
					for await (const chunk of stream) {
						this.throwIfAborted(externalSignal)
						if (timedOut) {
							throw new Error(`Semantic analysis timed out after ${this.timeoutMs}ms`)
						}
						if (chunk.type === "text") {
							content += chunk.text
						} else if (chunk.type === "usage") {
							this.accumulateStreamUsage(chunk)
							sawUsage = true
						}
					}
					if (!sawUsage) {
						const finalUsage = await apiHandler.getApiStreamUsage?.()
						if (finalUsage) {
							this.accumulateStreamUsage(finalUsage)
						}
					}
					this.usage.requests += 1
					return content.trim()
				} finally {
					clearTimeout(timeout)
					externalSignal?.removeEventListener("abort", onExternalAbort)
				}
			} catch (error) {
				if (externalSignal?.aborted) {
					throw new KocodeSemanticCancelledError()
				}
				lastError = error
				Logger.warn(`[KocodeSemanticAnalyzer] 请求失败(尝试 ${attempt}/${MAX_ATTEMPTS}): ${String(error)}`)
			}
		}
		Logger.error("[KocodeSemanticAnalyzer] 语义分析请求全部失败", lastError as Error)
		return null
	}

	private accumulateStreamUsage(usage: ApiStreamUsageChunk): void {
		const prompt = usage.inputTokens || 0
		const completion = usage.outputTokens || 0
		this.usage.promptTokens += prompt
		this.usage.completionTokens += completion
		this.usage.totalTokens += prompt + completion
	}
}
