import type { KocodeEvent, KocodeMemoDocument } from "@shared/kocode"
import { EmptyRequest } from "@shared/proto/cline/common"
import {
	ChevronDownIcon,
	CopyIcon,
	ExternalLinkIcon,
	FileTextIcon,
	ListFilterIcon,
	MoreHorizontalIcon,
	RefreshCwIcon,
	SearchIcon,
	SettingsIcon,
	SlidersHorizontalIcon,
} from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useMemo, useState } from "react"
import kokoAvatar from "@/assets/kocode/koko-avatar.png"
import { MarkdownRow } from "@/components/chat/MarkdownRow"
import { KocodeServiceClient } from "@/services/kocode-client"
import "./KocodeWorkbenchView.css"

const memoKindLabel = (kind: KocodeMemoDocument["kind"]) => (kind === "plan_report" ? "計画" : "完了")

const formatDateTime = (timestamp: number) =>
	new Date(timestamp).toLocaleString("ja-JP", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	})

const sortMemos = (memos: KocodeMemoDocument[]) => [...memos].sort((a, b) => b.createdAt - a.createdAt)

type WorkbenchPage = "report" | "survey"

const PlaceholderIconButton = ({
	label,
	children,
	className = "",
}: {
	label: string
	children: ReactNode
	className?: string
}) => (
	<button aria-label={label} className={`kw-icon-button${className ? ` ${className}` : ""}`} title={label} type="button">
		{children}
	</button>
)

const KocodeWorkbenchView = () => {
	const [memos, setMemos] = useState<KocodeMemoDocument[]>([])
	const [selectedMemoId, setSelectedMemoId] = useState<string>()
	const [activePage, setActivePage] = useState<WorkbenchPage>("report")

	useEffect(() => {
		KocodeServiceClient.getKocodeSession(EmptyRequest.create({}))
			.then((session) => {
				setMemos(session.memos ?? [])
				setSelectedMemoId(session.selectedMemoId ?? session.memos?.at(-1)?.id)
			})
			.catch(console.error)

		const cleanup = KocodeServiceClient.subscribeToKocodeEvents(EmptyRequest.create({}), {
			onResponse: (event: KocodeEvent) => {
				if (event.type === "memo_ready") {
					setMemos((previous) => {
						const withoutDuplicate = previous.filter((memo) => memo.id !== event.memo.id)
						return [...withoutDuplicate, event.memo]
					})
					setSelectedMemoId(event.memo.id)
				}
				if (event.type === "memo_selected") {
					setSelectedMemoId(event.memoId)
				}
			},
			onError: console.error,
			onComplete: () => undefined,
		})

		return cleanup
	}, [])

	const sortedMemos = useMemo(() => sortMemos(memos), [memos])
	const selectedMemo = useMemo(() => {
		return sortedMemos.find((memo) => memo.id === selectedMemoId) ?? sortedMemos[0]
	}, [selectedMemoId, sortedMemos])

	return (
		<div className="kw-root">
			<header className="kw-header">
				<div className="kw-brand">
					<span aria-hidden className="kw-cat-mark" />
					<h1>作業メモ</h1>
				</div>
				<nav aria-label="作業メモページ" className="kw-tabs">
					<button
						aria-current={activePage === "report" ? "page" : undefined}
						className={activePage === "report" ? "is-active" : ""}
						onClick={() => setActivePage("report")}
						type="button">
						レポート
					</button>
					<button
						aria-current={activePage === "survey" ? "page" : undefined}
						className={activePage === "survey" ? "is-active" : ""}
						onClick={() => setActivePage("survey")}
						type="button">
						アンケート
					</button>
				</nav>
				<div aria-label="作業メモツール" className="kw-header-actions" role="toolbar">
					<PlaceholderIconButton label="検索">
						<SearchIcon size={18} />
					</PlaceholderIconButton>
					<PlaceholderIconButton label="表示設定">
						<SlidersHorizontalIcon size={18} />
					</PlaceholderIconButton>
					<PlaceholderIconButton label="更新">
						<RefreshCwIcon size={18} />
					</PlaceholderIconButton>
					<PlaceholderIconButton label="設定">
						<SettingsIcon size={18} />
					</PlaceholderIconButton>
					<img alt="" aria-hidden className="kw-avatar" draggable={false} src={kokoAvatar} />
				</div>
			</header>

			{activePage === "survey" ? (
				<main className="kw-survey-page">
					<section aria-label="アンケート" className="kw-survey-panel">
						<div className="kw-survey-mascot">
							<img alt="" aria-hidden draggable={false} src={kokoAvatar} />
						</div>
						<div className="kw-survey-copy">
							<span>アンケート</span>
							<h2>まだアンケートはありません。</h2>
							<p>ここに作業後のふりかえりや確認フォームを表示します。</p>
						</div>
						<i aria-hidden />
					</section>
				</main>
			) : sortedMemos.length === 0 ? (
				<main className="kw-empty">
					<img alt="" aria-hidden draggable={false} src={kokoAvatar} />
					<span>まだ作業メモはありません。</span>
				</main>
			) : (
				<main className="kw-layout">
					<aside aria-label="作業メモ一覧" className="kw-list">
						<div className="kw-list-header">
							<span>{selectedMemo ? `${memoKindLabel(selectedMemo.kind)}レポート` : "レポート"}</span>
							<ChevronDownIcon aria-hidden size={13} />
							<i aria-hidden />
							<PlaceholderIconButton className="kw-list-tool" label="一覧設定">
								<ListFilterIcon size={14} />
							</PlaceholderIconButton>
						</div>
						{sortedMemos.map((memo) => {
							const selected = memo.id === selectedMemo?.id
							return (
								<button
									aria-current={selected ? "true" : undefined}
									className={`kw-list-item${selected ? " is-selected" : ""}`}
									key={memo.id}
									onClick={() => setSelectedMemoId(memo.id)}
									type="button">
									<span className="kw-list-icon">
										<FileTextIcon size={16} />
									</span>
									<span className="kw-list-main">
										<strong>{memo.title}</strong>
										<small>
											{memoKindLabel(memo.kind)} · {formatDateTime(memo.createdAt)}
										</small>
									</span>
									<span aria-hidden className="kw-list-dot" />
								</button>
							)
						})}
						<div aria-hidden className="kw-list-deco">
							<span>✦</span>
							<span>🐾</span>
							<span>✧</span>
						</div>
					</aside>

					<section aria-label="作業メモ本文" className="kw-detail">
						{selectedMemo && (
							<>
								<header className="kw-detail-header">
									<div className="kw-detail-heading">
										<div className="kw-detail-title-row">
											<span>{memoKindLabel(selectedMemo.kind)}レポート</span>
											<h2>{selectedMemo.title}</h2>
										</div>
										<div className="kw-detail-meta">
											<time>{formatDateTime(selectedMemo.createdAt)}</time>
											{selectedMemo.taskGoal && <em>{selectedMemo.taskGoal}</em>}
										</div>
									</div>
									<div aria-label="レポート操作" className="kw-detail-actions" role="toolbar">
										<PlaceholderIconButton label="コピー">
											<CopyIcon size={17} />
										</PlaceholderIconButton>
										<PlaceholderIconButton label="外部で開く">
											<ExternalLinkIcon size={17} />
										</PlaceholderIconButton>
										<PlaceholderIconButton label="その他">
											<MoreHorizontalIcon size={18} />
										</PlaceholderIconButton>
									</div>
								</header>
								<article className="kw-markdown">
									<MarkdownRow markdown={selectedMemo.markdown} />
									<i aria-hidden className="kw-paper-deco" />
								</article>
							</>
						)}
					</section>
				</main>
			)}
		</div>
	)
}

export default KocodeWorkbenchView
