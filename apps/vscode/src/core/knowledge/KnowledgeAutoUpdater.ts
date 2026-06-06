import { execFile } from "child_process"
import chokidar, { type FSWatcher } from "chokidar"
import * as fs from "fs/promises"
import * as path from "path"
import { promisify } from "util"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { KnowledgeService } from "./KnowledgeService"
import { KnowledgeStore } from "./KnowledgeStore"

/**
 * commit 后自动增量更新(R7.1/R9.4/R9.5)。
 *
 * 设计说明(对需求的合理超集):
 * 需求字面为"监听 Kocode 执行的 git commit/merge/rebase/cherry-pick"。
 * 这里改为监听 `.git/logs/HEAD` 的变化——HEAD 因 commit/merge/rebase/cherry-pick 移动时
 * 该文件都会追加记录。这能覆盖 Worker 通过 execute_command 执行的 git 操作,也能覆盖用户
 * 手动操作,避免"漏监听导致图谱悄悄 stale"。语义上是原需求的超集,不丢失原意。
 *
 * 仅当项目配置 autoUpdate=true 时启用(R9.5:false 时不自动更新)。
 * 配置读取走 KnowledgeStore.readConfig(),对齐上游 ProjectConfig { autoUpdate, outputLanguage }。
 */

const DEBOUNCE_MS = 3_000
const execFileAsync = promisify(execFile)
const VSCODE_AUTO_UPDATE_SETTING = "kocode.knowledge.autoUpdate"

export class KnowledgeAutoUpdater {
	private watcher?: FSWatcher
	private configWatcher?: vscode.Disposable
	private debounceTimer?: ReturnType<typeof setTimeout>
	private running = false
	private disposed = false
	private readonly store: KnowledgeStore

	constructor(private readonly workspaceRoot: string) {
		this.store = new KnowledgeStore(workspaceRoot)
	}

	/** 读取 autoUpdate 配置(缺省/出错视为关闭)。 */
	private async isAutoUpdateEnabled(): Promise<boolean> {
		try {
			if (vscode.workspace.getConfiguration("kocode.knowledge").get<boolean>("autoUpdate") === true) {
				return true
			}
			const config = await this.store.readConfig()
			return config.autoUpdate === true
		} catch {
			return false
		}
	}

	/** 启动配置监听,并按当前 autoUpdate 状态挂载/卸载 HEAD watcher。 */
	async start(): Promise<void> {
		if (this.disposed) {
			return
		}
		if (!this.configWatcher) {
			this.configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(VSCODE_AUTO_UPDATE_SETTING)) {
					void this.syncWatcher()
				}
			})
		}
		await this.syncWatcher()
	}

	private async syncWatcher(): Promise<void> {
		if (this.disposed) {
			return
		}
		if (!(await this.isAutoUpdateEnabled())) {
			await this.stopWatcher()
			Logger.log("[KnowledgeAutoUpdater] autoUpdate 未开启,跳过自动更新监听")
			return
		}
		if (this.watcher) {
			return
		}

		const gitLogsHead = await this.resolveGitHeadLogPath()
		if (!gitLogsHead) {
			Logger.log("[KnowledgeAutoUpdater] 非 git 仓库或无 HEAD log,跳过自动更新监听")
			return
		}
		try {
			await fs.access(gitLogsHead)
		} catch {
			Logger.log("[KnowledgeAutoUpdater] 非 git 仓库或无 HEAD log,跳过自动更新监听")
			return
		}

		this.watcher = chokidar.watch(gitLogsHead, { persistent: true, ignoreInitial: true })
		this.watcher.on("change", () => this.scheduleUpdate())
		Logger.log("[KnowledgeAutoUpdater] 已启动 commit 后自动增量更新监听")
	}

	private async resolveGitHeadLogPath(): Promise<string | null> {
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "logs/HEAD"], {
				cwd: this.workspaceRoot,
			})
			const gitPath = stdout.trim()
			if (!gitPath) {
				return null
			}
			return path.isAbsolute(gitPath) ? gitPath : path.join(this.workspaceRoot, gitPath)
		} catch (error) {
			Logger.log(`[KnowledgeAutoUpdater] 解析 git HEAD log 失败: ${String(error)}`)
			return null
		}
	}

	private async stopWatcher(): Promise<void> {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = undefined
		}
		await this.watcher?.close()
		this.watcher = undefined
	}

	private scheduleUpdate(): void {
		if (this.disposed) {
			return
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
		}
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined
			void this.runUpdate()
		}, DEBOUNCE_MS)
	}

	private async runUpdate(): Promise<void> {
		if (this.running || this.disposed) {
			return
		}
		// 二次确认配置仍开启(用户可能中途关闭)。
		if (!(await this.isAutoUpdateEnabled())) {
			return
		}
		this.running = true
		try {
			const service = new KnowledgeService(this.workspaceRoot)
			const result = await service.incrementalUpdate({ semantic: true })
			Logger.log(`[KnowledgeAutoUpdater] 自动增量更新: ${result.action} — ${result.reason}`)
		} catch (error) {
			// 自动更新失败不打扰用户,仅记录;已有图谱保持不变(R10.1)。
			Logger.warn(`[KnowledgeAutoUpdater] 自动增量更新失败: ${String(error)}`)
		} finally {
			this.running = false
		}
	}

	dispose(): void {
		this.disposed = true
		this.configWatcher?.dispose()
		this.configWatcher = undefined
		void this.stopWatcher()
	}
}
