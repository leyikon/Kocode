import chokidar, { type FSWatcher } from "chokidar"
import * as fs from "fs/promises"
import * as path from "path"
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

export class KnowledgeAutoUpdater {
	private watcher?: FSWatcher
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
			const config = await this.store.readConfig()
			return config.autoUpdate === true
		} catch {
			return false
		}
	}

	/** 启动监听。若 autoUpdate 关闭或非 git 仓库,则不挂载监听器。 */
	async start(): Promise<void> {
		if (this.disposed || this.watcher) {
			return
		}
		if (!(await this.isAutoUpdateEnabled())) {
			Logger.log("[KnowledgeAutoUpdater] autoUpdate 未开启,跳过自动更新监听")
			return
		}
		const gitLogsHead = path.join(this.workspaceRoot, ".git", "logs", "HEAD")
		try {
			await fs.access(gitLogsHead)
		} catch {
			Logger.log("[KnowledgeAutoUpdater] 非 git 仓库或无 .git/logs/HEAD,跳过自动更新监听")
			return
		}

		this.watcher = chokidar.watch(gitLogsHead, { persistent: true, ignoreInitial: true })
		this.watcher.on("change", () => this.scheduleUpdate())
		Logger.log("[KnowledgeAutoUpdater] 已启动 commit 后自动增量更新监听")
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
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = undefined
		}
		void this.watcher?.close()
		this.watcher = undefined
	}
}
