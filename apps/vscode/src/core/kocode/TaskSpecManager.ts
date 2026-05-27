import type { KocodeTaskMode, TaskSpec, TaskSpecPatch } from "@shared/kocode"

const TASK_KEYWORDS = [
	"实现",
	"修改",
	"修复",
	"调试",
	"报错",
	"代码",
	"文件",
	"生成",
	"做",
	"写",
	"add",
	"fix",
	"debug",
	"implement",
	"create",
	"update",
	"コード",
	"エラー",
	"作って",
]

const LEARNING_KEYWORDS = ["教我", "解释", "讲", "课件", "思维导图", "出题", "ppt", "PPT", "学習", "説明", "クイズ"]

export class TaskSpecManager {
	private taskSpec?: TaskSpec

	getTaskSpec(): TaskSpec | undefined {
		return this.taskSpec ? { ...this.taskSpec, pendingPatches: [...this.taskSpec.pendingPatches] } : undefined
	}

	ensureTaskSpec(text: string, sourceMessageId: string, files: string[] = []): TaskSpec {
		if (!this.taskSpec || this.taskSpec.status === "completed" || this.taskSpec.status === "cancelled") {
			this.taskSpec = {
				id: `${Date.now()}`,
				goal: text.trim(),
				mode: this.inferMode(text),
				status: "draft",
				files: [...files],
				constraints: [],
				acceptedDecisions: [],
				rejectedDirections: [],
				pendingPatches: [],
				acceptanceCriteria: ["满足用户当前明确提出的目标", "不把闲聊内容加入 Worker 上下文"],
			}
			return this.taskSpec
		}

		this.applyPatch({
			kind: "add_constraint",
			text,
			sourceMessageId,
			createdAt: Date.now(),
		})

		for (const file of files) {
			this.applyPatch({
				kind: "add_file_scope",
				text: file,
				sourceMessageId,
				createdAt: Date.now(),
			})
		}

		return this.taskSpec
	}

	applyPatch(patch: TaskSpecPatch): TaskSpec {
		if (!this.taskSpec) {
			this.taskSpec = {
				id: `${Date.now()}`,
				goal: patch.text,
				mode: this.inferMode(patch.text),
				status: "draft",
				files: [],
				constraints: [],
				acceptedDecisions: [],
				rejectedDirections: [],
				pendingPatches: [],
				acceptanceCriteria: ["满足用户当前明确提出的目标"],
			}
		}

		switch (patch.kind) {
			case "replace_goal":
				this.taskSpec.goal = patch.text
				this.taskSpec.mode = this.inferMode(patch.text)
				break
			case "add_constraint":
				this.addUnique(this.taskSpec.constraints, patch.text)
				break
			case "remove_constraint":
				this.taskSpec.constraints = this.taskSpec.constraints.filter((constraint) => constraint !== patch.text)
				break
			case "add_file_scope":
				this.addUnique(this.taskSpec.files, patch.text)
				break
			case "reject_direction":
				this.addUnique(this.taskSpec.rejectedDirections, patch.text)
				break
			case "request_pause":
				this.taskSpec.status = "paused"
				break
			case "request_cancel":
				this.taskSpec.status = "cancelled"
				break
			case "request_replan":
				this.addUnique(this.taskSpec.pendingPatches, patch)
				break
		}

		if (patch.kind !== "request_replan") {
			this.addUnique(this.taskSpec.pendingPatches, patch)
		}

		return this.taskSpec
	}

	markActive(): TaskSpec | undefined {
		if (this.taskSpec) {
			this.taskSpec.status = "active"
		}
		return this.taskSpec
	}

	markPaused(): TaskSpec | undefined {
		if (this.taskSpec) {
			this.taskSpec.status = "paused"
		}
		return this.taskSpec
	}

	markCancelled(): TaskSpec | undefined {
		if (this.taskSpec) {
			this.taskSpec.status = "cancelled"
		}
		return this.taskSpec
	}

	isTaskLike(text: string): boolean {
		const normalized = text.trim()
		return TASK_KEYWORDS.some((keyword) => normalized.includes(keyword)) || LEARNING_KEYWORDS.some((keyword) => normalized.includes(keyword))
	}

	inferMode(text: string): KocodeTaskMode {
		if (/ppt|PPT|课件|スライド/.test(text)) {
			return "slide_preview"
		}
		if (/出题|题目|quiz|クイズ/.test(text)) {
			return "quiz"
		}
		if (LEARNING_KEYWORDS.some((keyword) => text.includes(keyword))) {
			return "learning"
		}
		if (/报错|bug|debug|エラー|调试/.test(text)) {
			return "debugging"
		}
		return "coding"
	}

	private addUnique<T>(items: T[], item: T): void {
		const key = JSON.stringify(item)
		if (!items.some((candidate) => JSON.stringify(candidate) === key)) {
			items.push(item)
		}
	}
}
