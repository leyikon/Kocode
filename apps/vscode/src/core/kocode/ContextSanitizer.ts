import type { ClineMessage } from "@shared/ExtensionMessage"
import type { TaskSpec, WorkerDigest } from "@shared/kocode"
import { KnowledgeContextProvider } from "@/core/knowledge/KnowledgeContextProvider"

function isCompletionMessage(message: ClineMessage): boolean {
	return !message.partial && (message.say === "completion_result" || message.ask === "completion_result")
}

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
		const pending =
			taskSpec.pendingPatches.length > 0
				? taskSpec.pendingPatches.map((patch) => `- ${patch.kind}: ${patch.text}`).join("\n")
				: "- なし"

		return [
			"# Kocode Worker Task",
			"",
			"あなたは Kocode の Worker Agent です。既存の Cline と同じように、必要な調査・編集・検証を行ってください。",
			"ただし、この依頼は Flash Agent が会話から抽出した TaskSpec です。雑談やキャラクター口調は Worker の判断材料にしないでください。",
			"",
			"## Audience",
			"このユーザーは「初めて vibe coding する新人」です。専門用語ベースの提案やフレームワーク選定の質問は、まず一行のやさしい言い換えを添えてください。",
			"",
			"## Newbie-Mode Operating Rules",
			"- 破壊的なシェルコマンド（rm / mv / git reset --hard / DB drop / 大量ファイル削除など）は必ず requires_approval=true で出し、簡潔な日本語で「何を消すか・元に戻せるか」を 1 行で説明してください。",
			"- 不可逆操作は、ユーザーが明示確認するまで実行しないでください。",
			"- 1 タスクごと、または大きな編集ごとに、attempt_completion ではなく短い進捗メッセージ（1〜2 文・専門用語なし）で「いま何をしたか」を伝えてください。",
			"- まだ動かしていない / 確認していないことを「できた」「直った」と書かないでください。完了主張の前に、可能なら lint / test / dev server / 簡単な smoke check のいずれかを必ず実行してください。",
			"- TaskSpec で明示されたファイル以外を大きく書き換える前に、ask_followup_question で確認してください。",
			"- ユーザーがまだ知らない概念（例: SSR, Hydration, OAuth）に触れる時は、コード前に 1 行の砕けた説明を添えてください。",
			"- attempt_completion では、ユーザーが「次に何を見ればよいか」を 1 行だけ案内してください（例: ブラウザで /login を開いてみて）。",
			"",
			this.executionModeSection(taskSpec.executionMode),
			"",
			`## Goal\n${taskSpec.goal}`,
			`## Mode\n${taskSpec.mode}`,
			`## Files\n${files}`,
			`## Constraints\n${constraints}`,
			`## Rejected Directions\n${rejected}`,
			`## Pending Revisions\n${pending}`,
			`## Acceptance Criteria\n${criteria}`,
		].join("\n")
	}

	/**
	 * executionMode に応じて Worker の進め方を明示する。
	 * plan_only / plan_then_execute / survey_plan / execute_directly（既定）で行動を切り替える。
	 */
	private executionModeSection(executionMode?: TaskSpec["executionMode"]): string {
		switch (executionMode) {
			case "plan_only":
				return [
					"## Execution Mode: PLAN ONLY（計画のみ・ファイルを変更しない）",
					"- 必要なファイルだけを読み、現状を把握してください。",
					"- 短く分かりやすい「作り方の計画」を出力してください（手順の箇条書きで十分）。",
					"- ファイルの編集・新規作成・書き込み系コマンドの実行は一切しないでください。",
					"- 計画は attempt_completion で返し、そこで止まってください。ユーザーの次の指示を待ちます。",
					"- 勝手に実装へ進まないでください。",
				].join("\n")
			case "survey_plan":
				return [
					"## Execution Mode: SURVEY PLAN（アンケート方式・ファイルを変更しない）",
					"このタスクは「複雑・あいまい・大規模」な依頼です。いきなり実装せず、まずユーザーの意図を",
					"一問一答のアンケートで丁寧に確認し、最後に計画レポートを出してください。",
					"",
					"### 厳守ルール（最重要）",
					"- ファイルの編集・新規作成・書き込み系コマンドの実行は一切しないでください（plan_only と同じ・読み取りのみ）。",
					"- ユーザーへの質問は必ず `ask_followup_question` を 1 回につき **ちょうど 1 問** だけ使ってください。",
					"- 1 問には必ず 2〜4 個の `options`（選択肢）を付けてください。ユーザーが選びやすい具体的な選択肢にします。",
					"- `plan_mode_respond` で複数の質問を列挙してはいけません。質問はすべて `ask_followup_question` の単問で行います。",
					"- 1 問を出したら、その回答を受け取るまで次の質問を出さないでください（先回りして複数問を並べない）。",
					"- 質問は専門用語を避け、初めて vibe coding する新人にも分かる言葉にしてください。",
					"",
					"### 進め方（二段階判断）",
					"1. まず必要最小限のファイル/コンテキストだけを読み、プロジェクトの現状を把握してください。",
					"2. **最初の質問は必ず「理解度の自己評価」にしてください**。例:",
					"   question:「プロジェクトを見たよ。この依頼はもう十分わかったから、このまま進めても大丈夫そうにゃ。どうする？」",
					'   options: ["このまま始めてOK", "もう少し確認したいことがある"]',
					"   - ユーザーが「このまま始めてOK」を選んだら、追加の質問はせず、すぐに attempt_completion で計画レポートを出してください。",
					"   - ユーザーが「もう少し確認したい」を選んだら、本当に未確定な決定事項だけを一問ずつ確認してください。",
					"3. コンテキストから既に分かることは質問しないでください。実装方針が変わる「未知の決定」だけを聞きます。",
					"",
					"### 質問数の上限",
					"- 核心質問は最大 20 問までを目安にしてください。理解が十分なら 20 問を待たず早めに切り上げてかまいません。",
					"- どうしても足りない場合のみ、追加で最大 5 問まで聞けます（合計 25 問が上限の目安）。",
					"",
					"### 完了",
					"- 質問が十分終わったら、ファイルは一切変更せず、`attempt_completion` で Markdown の「計画レポート」を返してください。",
					"- レポートには、目的 / 採用する方針 / 主要な手順 / 対象ファイル / 確認した前提 を簡潔にまとめてください。",
					"- レポートを返したらそこで止まり、ユーザーの次の指示を待ちます。勝手に実装へ進まないでください。",
				].join("\n")
			case "plan_then_execute":
				return [
					"## Execution Mode: PLAN THEN EXECUTE（先に計画→そのまま実装）",
					"- まず短い文章で「これからどう進めるか」の計画を 1 回伝えてください（専門用語なし・数行）。",
					"- 計画を伝えたら、確認を待たずにそのまま実装を続けてください。",
					"- 計画と実装が食い違わないように進めてください。",
				].join("\n")
			default:
				return [
					"## Execution Mode: EXECUTE（通常の実装）",
					"- TaskSpec の目標に沿って、必要な調査・編集・検証を行って実装してください。",
				].join("\n")
		}
	}

	/**
	 * 在基础 Worker prompt 之后追加项目知识图谱上下文(R5)。
	 * 注入失败/无图谱时仅返回基础 prompt,绝不阻塞 Worker 启动(R6.4)。
	 *
	 * @param workspaceRoot 工作区根路径;缺省则跳过注入。
	 */
	async toWorkerPromptWithKnowledge(taskSpec: TaskSpec, workspaceRoot?: string): Promise<string> {
		const base = this.toWorkerPrompt(taskSpec)
		if (!workspaceRoot) {
			return base
		}
		try {
			const provider = new KnowledgeContextProvider(workspaceRoot)
			const injection = await provider.buildInjection(taskSpec)
			if (!injection) {
				return base
			}
			return `${base}\n\n${injection}`
		} catch {
			// 注入是增强而非必需:任何失败都回退到基础 prompt。
			return base
		}
	}

	toDigestFromMessage(message: ClineMessage, taskId?: string): WorkerDigest {
		const isCompletion = isCompletionMessage(message)
		const status = isCompletion ? "completed" : message.type === "ask" ? "waiting" : message.partial ? "running" : "running"
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
