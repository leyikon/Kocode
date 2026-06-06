import { getWorkspacePath } from "@utils/path"
import * as vscode from "vscode"
import type { Controller } from "@/core/controller"
import { ExtensionRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"
import { type AnalyzeProgress, KnowledgeService } from "./KnowledgeService"
import { KnowledgeStore } from "./KnowledgeStore"

/**
 * 项目知识图谱命令注册(R9)。
 * - knowledge.analyze:全量分析(默认含 Tier1 语义,Tier2 深度按需)。
 * - knowledge.refresh:增量更新。
 * - knowledge.openProjectMap:本期占位/禁用(可视化在 Out of Scope)。
 *
 * 进度通过 vscode 进度 UI 展示并支持取消(R8.1/R8.2)。
 */

const commands = ExtensionRegistryInfo.commands

/**
 * 获取工作区根路径。
 * 注意:同步的 getWorkspaceManager() 仅在任务初始化后才有值,命令独立触发时通常为空。
 * 因此优先用 ensureWorkspaceManager()(懒初始化),再回退到 getWorkspacePath()(直接查 VS Code 工作区)。
 */
async function getWorkspaceRoot(controller: Controller): Promise<string | undefined> {
	const fromManager = (await controller.ensureWorkspaceManager())?.getPrimaryRoot()?.path
	if (fromManager) {
		return fromManager
	}
	const fromVscode = await getWorkspacePath()
	return fromVscode || undefined
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController()
	if (token.isCancellationRequested) {
		controller.abort()
	}
	token.onCancellationRequested(() => controller.abort())
	return controller.signal
}

function reportProgress(
	reporter: vscode.Progress<{ message?: string; increment?: number }>,
	progress: AnalyzeProgress,
): void {
	let message = progress.message
	if (progress.phase === "semantic" && progress.total) {
		message = `${progress.message} (${progress.current ?? 0}/${progress.total})`
	}
	reporter.report({ message })
}

function formatTokenSummary(usage: { totalTokens: number; requests: number }): string {
	return `Kocode 模型调用 ${usage.requests} 次,约 ${usage.totalTokens} tokens`
}

async function runAnalyze(controller: Controller): Promise<void> {
	const root = await getWorkspaceRoot(controller)
	if (!root) {
		void vscode.window.showWarningMessage("未打开工作区,无法生成项目知识图谱。")
		return
	}
	const service = new KnowledgeService(root)
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "生成项目知识图谱", cancellable: true },
		async (reporter, token) => {
			const signal = toAbortSignal(token)
			try {
				const result = await service.analyze({
					semantic: true,
					signal,
					onProgress: (p) => reportProgress(reporter, p),
				})
				if (result.cancelled) {
					void vscode.window.showInformationMessage(
						`知识图谱已部分生成(已取消)。${formatTokenSummary(result.tokenUsage)}`,
					)
				} else {
					void vscode.window.showInformationMessage(
						`知识图谱已生成:${result.graph.nodes.length} 节点 / ${result.graph.edges.length} 关系。${formatTokenSummary(result.tokenUsage)}`,
					)
				}
			} catch (error) {
				Logger.error("[knowledge.analyze] 失败", error as Error)
				void vscode.window.showErrorMessage(`生成知识图谱失败(可重试):${String((error as Error)?.message ?? error)}`)
			}
		},
	)
}

async function runRefresh(controller: Controller): Promise<void> {
	const root = await getWorkspaceRoot(controller)
	if (!root) {
		void vscode.window.showWarningMessage("未打开工作区,无法刷新项目知识图谱。")
		return
	}
	const service = new KnowledgeService(root)
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "刷新项目知识图谱", cancellable: true },
		async (reporter, token) => {
			const signal = toAbortSignal(token)
			try {
				const update = await service.incrementalUpdate({
					semantic: true,
					signal,
					onProgress: (p) => reportProgress(reporter, p),
				})
				switch (update.action) {
					case "SKIP":
						void vscode.window.showInformationMessage(`无需更新:${update.reason}`)
						break
					case "FULL_RECOMMENDED":
						void vscode.window
							.showWarningMessage(`变更较大,建议全量重建:${update.reason}`, "全量重建")
							.then((choice) => {
								if (choice === "全量重建") {
									void runAnalyze(controller)
								}
							})
						break
					default:
						void vscode.window.showInformationMessage(`图谱已更新(${update.action}):${update.reason}`)
				}
			} catch (error) {
				Logger.error("[knowledge.refresh] 失败", error as Error)
				void vscode.window.showErrorMessage(`刷新知识图谱失败(可重试):${String((error as Error)?.message ?? error)}`)
			}
		},
	)
}

async function runToggleAutoUpdate(controller: Controller): Promise<void> {
	const root = await getWorkspaceRoot(controller)
	if (!root) {
		void vscode.window.showWarningMessage("未打开工作区,无法切换项目知识图谱自动更新。")
		return
	}

	const setting = vscode.workspace.getConfiguration("kocode.knowledge").get<boolean>("autoUpdate") === true
	const store = new KnowledgeStore(root)
	const config = await store.readConfig()
	const next = !(setting || config.autoUpdate === true)

	await vscode.workspace.getConfiguration("kocode.knowledge").update("autoUpdate", next, vscode.ConfigurationTarget.Workspace)
	await store.writeConfig({ ...config, autoUpdate: next })

	void vscode.window.showInformationMessage(next ? "项目知识图谱自动更新已开启。" : "项目知识图谱自动更新已关闭。")
}

/**
 * 注册全部知识图谱命令。返回 Disposable 数组供 extension 订阅。
 */
export function registerKnowledgeCommands(controller: Controller): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(commands.KnowledgeAnalyze, () => runAnalyze(controller)),
		vscode.commands.registerCommand(commands.KnowledgeRefresh, () => runRefresh(controller)),
		vscode.commands.registerCommand(commands.KnowledgeToggleAutoUpdate, () => runToggleAutoUpdate(controller)),
		vscode.commands.registerCommand(commands.KnowledgeOpenProjectMap, () => {
			// R9.3:本期占位/禁用,可视化在 Out of Scope。
			void vscode.window.showInformationMessage("Project Map 可视化将在后续版本提供。当前可使用「生成项目知识图谱」命令构建图谱数据。")
		}),
	]
}
