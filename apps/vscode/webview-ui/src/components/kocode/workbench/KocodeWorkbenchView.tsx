import type { KocodeEvent, TaskSpec, WorkerDigest, WorkerEvent } from "@shared/kocode"
import { EmptyRequest } from "@shared/proto/cline/common"
import {
	BookOpenIcon,
	BotIcon,
	CheckCircle2Icon,
	CircleIcon,
	ExpandIcon,
	PawPrintIcon,
	PlayCircleIcon,
	TargetIcon,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import kokoWorkbench from "@/assets/kocode/koko-workbench.png"
import { KocodeServiceClient } from "@/services/kocode-client"
import "./KocodeWorkbenchView.css"

const idleDigest: WorkerDigest = {
	status: "idle",
	title: "Worker Agent",
	summary: "ボスのお願いを待っているにゃ。",
	lastEventAt: Date.now(),
}

const fallbackSteps = [
	{ label: "やることを整理", status: "完了" },
	{ label: "必要なファイルを確認", status: "完了" },
	{ label: "小さく実装", status: "進行中" },
	{ label: "動きを一緒に確認", status: "未着手" },
]

const getShortGoal = (taskSpec?: TaskSpec) =>
	taskSpec?.goal || "ユーザー登録機能を実装して、ログイン後にプロフィールを編集できるようにする。"

const getNextStep = (taskSpec?: TaskSpec, workerDigest?: WorkerDigest) => {
	const patch = taskSpec?.pendingPatches.at(-1)
	if (patch) {
		return patch.text
	}
	if (workerDigest && workerDigest.status !== "idle") {
		return workerDigest.summary
	}
	return "ユーザー登録APIのバリデーションを追加する"
}

const getStatusLabel = (status?: WorkerDigest["status"]) => {
	switch (status) {
		case "completed":
			return "完了"
		case "paused":
			return "一時停止"
		case "cancelled":
			return "停止"
		case "waiting":
			return "確認待ち"
		case "running":
		case "starting":
			return "進行中"
		case "failed":
			return "確認中"
		default:
			return "待機中"
	}
}

const buildProgressItems = (taskSpec?: TaskSpec, workerEvents: WorkerEvent[] = []) => {
	const eventItems = workerEvents
		.filter((event) => event.kind !== "message")
		.slice(-4)
		.map((event) => ({
			label: event.title,
			status: event.kind === "completed" ? "完了" : event.kind === "error" ? "確認中" : "進行中",
		}))

	const acceptedItems =
		taskSpec?.acceptedDecisions.map((decision) => ({
			label: decision,
			status: "完了",
		})) ?? []

	return [...acceptedItems, ...eventItems, ...fallbackSteps].slice(0, 5)
}

const WorkbenchCard = ({
	children,
	className,
	title,
	icon,
}: {
	children: React.ReactNode
	className?: string
	title?: string
	icon?: React.ReactNode
}) => (
	<section className={["kw-card", className].filter(Boolean).join(" ")}>
		{title && (
			<header className="kw-card-title">
				{icon}
				<h3>{title}</h3>
			</header>
		)}
		{children}
	</section>
)

const KocodeWorkbenchView = () => {
	const [taskSpec, setTaskSpec] = useState<TaskSpec>()
	const [workerDigest, setWorkerDigest] = useState<WorkerDigest>(idleDigest)
	const [workerEvents, setWorkerEvents] = useState<WorkerEvent[]>([])

	useEffect(() => {
		KocodeServiceClient.getKocodeSession(EmptyRequest.create({}))
			.then((session) => {
				setTaskSpec(session.taskSpec)
				setWorkerDigest(session.workerDigest)
				setWorkerEvents(session.workerEvents)
			})
			.catch(console.error)

		const cleanup = KocodeServiceClient.subscribeToKocodeEvents(EmptyRequest.create({}), {
			onResponse: (event: KocodeEvent) => {
				if (event.type === "worker_status") {
					setWorkerDigest(event.digest)
				}
				if (event.type === "worker_detail") {
					setWorkerEvents((previous) => [...previous, event.event].slice(-120))
				}
				if (event.type === "task_spec_updated") {
					setTaskSpec(event.taskSpec)
				}
			},
			onError: console.error,
			onComplete: () => undefined,
		})

		return cleanup
	}, [])

	const progressItems = useMemo(() => buildProgressItems(taskSpec, workerEvents), [taskSpec, workerEvents])
	const statusLabel = getStatusLabel(workerDigest.status)

	return (
		<div className="kw-root">
			<div className="kw-shell">
				<header className="kw-header">
					<div className="kw-brand">
						<span aria-hidden className="kw-cat-mark">
							♡
						</span>
						<h1>Kocode / ココーデ</h1>
						<PawPrintIcon size={28} />
					</div>
					<div className="kw-koko">
						<img alt="ここちゃん" src={kokoWorkbench} />
						<div>
							<strong>ここちゃん</strong>
							<span>いっしょにがんばろうにゃ！</span>
						</div>
					</div>
				</header>

				<main className="kw-main">
					<aside className="kw-memo">
						<div className="kw-section-heading">
							<PawPrintIcon size={26} />
							<h2>作業メモ</h2>
						</div>

						<WorkbenchCard icon={<TargetIcon size={23} />} title="現在のゴール">
							<p>{getShortGoal(taskSpec)}</p>
						</WorkbenchCard>

						<WorkbenchCard icon={<PlayCircleIcon size={23} />} title="次のステップ">
							<div className="kw-next-row">
								<p>{getNextStep(taskSpec, workerDigest)}</p>
								<span>{statusLabel}</span>
							</div>
						</WorkbenchCard>

						<WorkbenchCard icon={<CheckCircle2Icon size={23} />} title="進行状況">
							<ul className="kw-progress-list">
								{progressItems.map((item, index) => {
									const done = item.status === "完了"
									const active = item.status === "進行中" || item.status === "確認待ち"
									return (
										<li key={`${item.label}-${index}`}>
											{done ? (
												<CheckCircle2Icon className="kw-done" size={20} />
											) : (
												<CircleIcon className={active ? "kw-active" : "kw-pending"} size={20} />
											)}
											<span>{item.label}</span>
											<em className={active ? "kw-pill-active" : undefined}>{item.status}</em>
										</li>
									)
								})}
							</ul>
						</WorkbenchCard>

						<div className="kw-worker-card">
							<div className="kw-worker-icon">
								<BotIcon size={34} />
							</div>
							<div>
								<strong>Worker Agent</strong>
								<p>{workerDigest.summary || "集中して順番に進めているよ！"}</p>
							</div>
							<PawPrintIcon aria-hidden className="kw-worker-paw" size={54} />
						</div>
					</aside>

					<section className="kw-whiteboard">
						<div className="kw-section-heading">
							<BookOpenIcon size={29} />
							<h2>教学白板</h2>
						</div>

						<WorkbenchCard className="kw-explain">
							<h3>解説</h3>
							<p>
								ユーザー登録の流れは、入力データの検証 → 保存 → 確認メール送信の順で行います。
								バリデーションでは、必須チェックと重複チェックを行います。
							</p>

							<div className="kw-flow-card">
								<div className="kw-flow-title">
									<strong>システムフロー（Mermaid）</strong>
									<button type="button">
										<ExpandIcon size={16} />
										拡大
									</button>
								</div>
								<div className="kw-flow">
									<div className="kw-flow-node">
										ユーザー入力
										<br />
										登録フォーム
									</div>
									<span />
									<div className="kw-flow-node">
										バリデーション
										<br />
										必須・重複チェック
									</div>
									<span />
									<div className="kw-flow-diamond">検証OK?</div>
									<span />
									<div className="kw-flow-node">
										ユーザー保存
										<br />
										DB
									</div>
									<span />
									<div className="kw-flow-node">確認メール送信</div>
									<span />
									<div className="kw-flow-node small">登録完了</div>
									<div className="kw-flow-error">
										エラーを返す
										<br />
										メッセージ表示
									</div>
								</div>
							</div>
						</WorkbenchCard>

						<WorkbenchCard className="kw-code-card">
							<h3>コード解説（抜粋）</h3>
							<div className="kw-code-grid">
								<pre>
									<code>{`src/auth/register.ts

1  export async function register(input: RegisterInput) {
2    await validate(input); // 入力検証
3    const user = await prisma.user.create({ data: input });
4    await sendVerificationEmail(user.email); // 確認メール送信
5    return { success: true };
6  }`}</code>
								</pre>
								<ul>
									<li>validate() で入力データを検証します</li>
									<li>prisma でユーザーを保存します</li>
									<li>確認メールを送信して、登録を完了します</li>
								</ul>
							</div>
						</WorkbenchCard>
					</section>
				</main>
			</div>
		</div>
	)
}

export default KocodeWorkbenchView
