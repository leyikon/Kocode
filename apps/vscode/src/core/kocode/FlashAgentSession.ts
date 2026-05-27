import type { KocodeChatMessage, TaskSpecPatch, WorkerControlRequest, WorkerDigest } from "@shared/kocode"

export type FlashIntent =
	| { type: "social_chat"; reply: string }
	| { type: "status_question"; reply: string }
	| { type: "complex_task" }
	| { type: "task_revision"; patch: TaskSpecPatch }
	| { type: "worker_control"; control: WorkerControlRequest; reply: string }

export class FlashAgentSession {
	classify(text: string, messageId: string, workerDigest: WorkerDigest, hasActiveTask: boolean): FlashIntent {
		const normalized = text.trim()
		const lower = normalized.toLowerCase()

		if (this.isPause(lower)) {
			return {
				type: "worker_control",
				control: { action: "pause", reason: normalized },
				reply: "わかったにゃ、ボス。いったん作業を止めるにゃ。",
			}
		}

		if (this.isCancel(lower)) {
			return {
				type: "worker_control",
				control: { action: "cancel", reason: normalized },
				reply: "了解にゃ。今の作業はキャンセルしておくにゃ。",
			}
		}

		if (this.isRedirect(lower) && hasActiveTask) {
			return {
				type: "worker_control",
				control: {
					action: "redirect",
					reason: normalized,
					taskSpecPatch: {
						kind: "reject_direction",
						text: normalized,
						sourceMessageId: messageId,
						createdAt: Date.now(),
					},
				},
				reply: "方向を変えるんだね、ボス。今の作業を止めて、整理し直すにゃ。",
			}
		}

		if (this.isStatusQuestion(lower)) {
			return {
				type: "status_question",
				reply: `いまは「${workerDigest.title}」だにゃ。${workerDigest.summary}`,
			}
		}

		if (hasActiveTask && this.isRevision(lower)) {
			return {
				type: "task_revision",
				patch: {
					kind: "add_constraint",
					text: normalized,
					sourceMessageId: messageId,
					createdAt: Date.now(),
				},
			}
		}

		if (this.isComplexTask(lower)) {
			return { type: "complex_task" }
		}

		return {
			type: "social_chat",
			reply: "うんうん、聞いてるにゃ。コードのことでも、ちょっとした相談でも大丈夫だにゃ、ボス。",
		}
	}

	workerStartedMessage(): string {
		return "ボス、ここからは裏でしっかり作業を進めるにゃ。細かい流れは作業画面で見られるにゃ。"
	}

	revisionQueuedMessage(): string {
		return "追加の希望、ちゃんとメモしたにゃ。次の整理タイミングで反映するにゃ。"
	}

	toMessage(text: string): KocodeChatMessage {
		return {
			id: `flash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			author: "flash",
			text,
			ts: Date.now(),
		}
	}

	private isPause(text: string): boolean {
		return /暂停|停一下|先停|止め|待って|pause|hold/.test(text)
	}

	private isCancel(text: string): boolean {
		return /取消|不要做了|终止|キャンセル|cancel|abort/.test(text)
	}

	private isRedirect(text: string): boolean {
		return /不是这个|方向不对|改方向|重新来|やり直|違う|redirect/.test(text)
	}

	private isStatusQuestion(text: string): boolean {
		return /进度|状态|做到哪|现在.*做|何して|状況|status|progress/.test(text)
	}

	private isRevision(text: string): boolean {
		return /顺便|另外|改成|不要|加上|去掉|もっと|追加|変更|instead|also/.test(text)
	}

	private isComplexTask(text: string): boolean {
		return /实现|修改|修复|调试|报错|代码|文件|生成|做|写|教我|解释|课件|思维导图|出题|add|fix|debug|implement|create|update|コード|エラー|作って|説明|クイズ/.test(
			text,
		)
	}
}
