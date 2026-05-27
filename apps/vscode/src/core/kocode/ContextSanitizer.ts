import type { ClineMessage } from "@shared/ExtensionMessage"
import type { TaskSpec, WorkerDigest } from "@shared/kocode"

export class ContextSanitizer {
	toWorkerPrompt(taskSpec: TaskSpec): string {
		const files = taskSpec.files.length > 0 ? taskSpec.files.map((file) => `- ${file}`).join("\n") : "- 未指定"
		const constraints =
			taskSpec.constraints.length > 0 ? taskSpec.constraints.map((constraint) => `- ${constraint}`).join("\n") : "- 未指定"
		const rejected =
			taskSpec.rejectedDirections.length > 0
				? taskSpec.rejectedDirections.map((direction) => `- ${direction}`).join("\n")
				: "- なし"
		const criteria =
			taskSpec.acceptanceCriteria.length > 0
				? taskSpec.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")
				: "- ユーザーの明示した目的を満たす"

		return [
			"# Kocode Worker Task",
			"",
			"あなたは Kocode の Worker Agent です。既存の Cline と同じように、必要な調査・編集・検証を行ってください。",
			"ただし、この依頼は Flash Agent が会話から抽出した TaskSpec です。雑談やキャラクター口調は Worker の判断材料にしないでください。",
			"",
			`## Goal\n${taskSpec.goal}`,
			`## Mode\n${taskSpec.mode}`,
			`## Files\n${files}`,
			`## Constraints\n${constraints}`,
			`## Rejected Directions\n${rejected}`,
			`## Acceptance Criteria\n${criteria}`,
		].join("\n")
	}

	toDigestFromMessage(message: ClineMessage, taskId?: string): WorkerDigest {
		const status = message.type === "ask" ? "waiting" : message.partial ? "running" : "running"
		const label = message.ask ?? message.say ?? "message"
		return {
			taskId,
			status,
			title: this.titleFor(label),
			summary: this.summaryFor(message),
			lastEventAt: message.ts ?? Date.now(),
		}
	}

	private titleFor(label: string): string {
		switch (label) {
			case "tool":
				return "作業中"
			case "command":
			case "command_output":
				return "コマンド確認中"
			case "completion_result":
				return "完了確認"
			case "api_req_started":
				return "考え中"
			case "text":
				return "進捗あり"
			default:
				return "作業状態"
		}
	}

	private summaryFor(message: ClineMessage): string {
		const text = message.text?.trim()
		if (!text) {
			return message.type === "ask" ? "確認が必要な操作があるにゃ。" : "Worker が作業を進めているにゃ。"
		}
		const compact = text.replace(/\s+/g, " ")
		return compact.length > 160 ? `${compact.slice(0, 160)}...` : compact
	}
}
