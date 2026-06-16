import type { ExtensionMessage } from "@shared/ExtensionMessage"
import type { KocodeEvent, KocodeMemoDocument, KocodeSurveySession, KocodeWorkbenchPage } from "@shared/kocode"
import { EmptyRequest } from "@shared/proto/cline/common"
import { ResetStateRequest } from "@shared/proto/cline/state"
import {
	CheckCheckIcon,
	ChevronDownIcon,
	CopyIcon,
	ExternalLinkIcon,
	FileTextIcon,
	FlaskConicalIcon,
	HardDriveDownloadIcon,
	InfoIcon,
	ListFilterIcon,
	type LucideIcon,
	MoreHorizontalIcon,
	RefreshCwIcon,
	SearchIcon,
	SettingsIcon,
	SlidersHorizontalIcon,
	SquareMousePointerIcon,
	SquareTerminalIcon,
	WrenchIcon,
} from "lucide-react"
import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useEvent } from "react-use"
import kokoAvatar from "@/assets/kocode/koko-avatar.png"
import { MarkdownRow } from "@/components/chat/MarkdownRow"
import { useClineAuth } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { KocodeServiceClient } from "@/services/kocode-client"
import { isAdminOrOwner } from "../../account/helpers"
import AboutSection from "../../settings/sections/AboutSection"
import ApiConfigurationSection from "../../settings/sections/ApiConfigurationSection"
import BrowserSettingsSection from "../../settings/sections/BrowserSettingsSection"
import DebugSection from "../../settings/sections/DebugSection"
import FeatureSettingsSection from "../../settings/sections/FeatureSettingsSection"
import GeneralSettingsSection from "../../settings/sections/GeneralSettingsSection"
import { RemoteConfigSection } from "../../settings/sections/RemoteConfigSection"
import TerminalSettingsSection from "../../settings/sections/TerminalSettingsSection"
import "./KocodeWorkbenchView.css"

const IS_DEV = process.env.IS_DEV

const memoKindLabel = (kind: KocodeMemoDocument["kind"]) =>
	kind === "plan_report" ? "計画" : kind === "survey_record" ? "アンケート" : "完了"

const formatDateTime = (timestamp: number) =>
	new Date(timestamp).toLocaleString("ja-JP", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	})

const sortMemos = (memos: KocodeMemoDocument[]) => [...memos].sort((a, b) => b.createdAt - a.createdAt)

type KocodeSettingsTabId = "api-config" | "features" | "browser" | "terminal" | "general" | "remote-config" | "about" | "debug"

type KocodeSettingsTab = {
	id: KocodeSettingsTabId
	name: string
	headerText: string
	icon: LucideIcon
	hidden?: (params?: { activeOrganization: ReturnType<typeof useClineAuth>["activeOrganization"] }) => boolean
}

const KOCODE_SETTINGS_TABS: KocodeSettingsTab[] = [
	{ id: "api-config", name: "API", headerText: "API Configuration", icon: SlidersHorizontalIcon },
	{ id: "features", name: "機能", headerText: "Feature Settings", icon: CheckCheckIcon },
	{ id: "browser", name: "ブラウザ", headerText: "Browser Settings", icon: SquareMousePointerIcon },
	{ id: "terminal", name: "ターミナル", headerText: "Terminal Settings", icon: SquareTerminalIcon },
	{ id: "general", name: "一般", headerText: "General Settings", icon: WrenchIcon },
	{
		id: "remote-config",
		name: "Remote",
		headerText: "Remote Config",
		icon: HardDriveDownloadIcon,
		hidden: ({ activeOrganization } = { activeOrganization: null }) =>
			!activeOrganization || !isAdminOrOwner(activeOrganization),
	},
	{ id: "about", name: "About", headerText: "About", icon: InfoIcon },
	{ id: "debug", name: "Debug", headerText: "Debug", icon: FlaskConicalIcon, hidden: () => !IS_DEV },
]

const PlaceholderIconButton = ({
	label,
	children,
	className = "",
	onClick,
}: {
	label: string
	children: ReactNode
	className?: string
	onClick?: () => void
}) => (
	<button
		aria-label={label}
		className={`kw-icon-button${className ? ` ${className}` : ""}`}
		onClick={onClick}
		title={label}
		type="button">
		{children}
	</button>
)

const renderKocodeSectionHeader = (tabId: string) => {
	const tab = KOCODE_SETTINGS_TABS.find((item) => item.id === tabId)
	if (!tab) {
		return null
	}
	return (
		<div className="kw-settings-section-heading">
			<tab.icon size={16} />
			<span>{tab.headerText}</span>
		</div>
	)
}

const KocodeSettingsPanel = () => {
	const { activeOrganization } = useClineAuth()
	const { settingsInitialModelTab, version } = useExtensionState()
	const [activeTab, setActiveTab] = useState<KocodeSettingsTabId>("api-config")

	const visibleTabs = useMemo(
		() => KOCODE_SETTINGS_TABS.filter((tab) => !tab.hidden?.({ activeOrganization })),
		[activeOrganization],
	)

	const handleResetState = useCallback(async (resetGlobalState?: boolean) => {
		try {
			await StateServiceClient.resetState(ResetStateRequest.create({ global: resetGlobalState }))
		} catch (error) {
			console.error("Failed to reset state:", error)
		}
	}, [])

	useEvent(
		"message",
		useCallback((event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type !== "grpc_response") {
				return
			}
			const tabId =
				message.grpc_response?.message?.key === "scrollToSettings" ? message.grpc_response.message.value : undefined
			if (KOCODE_SETTINGS_TABS.some((tab) => tab.id === tabId)) {
				setActiveTab(tabId as KocodeSettingsTabId)
			}
		}, []),
	)

	const contentProps = { renderSectionHeader: renderKocodeSectionHeader }
	let content: ReactNode = null
	switch (activeTab) {
		case "api-config":
			content = <ApiConfigurationSection {...contentProps} initialModelTab={settingsInitialModelTab} />
			break
		case "features":
			content = <FeatureSettingsSection {...contentProps} />
			break
		case "browser":
			content = <BrowserSettingsSection {...contentProps} />
			break
		case "terminal":
			content = <TerminalSettingsSection {...contentProps} />
			break
		case "general":
			content = <GeneralSettingsSection {...contentProps} />
			break
		case "remote-config":
			content = <RemoteConfigSection {...contentProps} />
			break
		case "about":
			content = <AboutSection {...contentProps} version={version} />
			break
		case "debug":
			content = <DebugSection {...contentProps} onResetState={handleResetState} />
			break
	}

	return (
		<main className="kw-settings-page">
			<aside aria-label="設定カテゴリ" className="kw-settings-nav">
				<div className="kw-settings-nav-title">設定</div>
				{visibleTabs.map((tab) => (
					<button
						aria-current={activeTab === tab.id ? "page" : undefined}
						className={`kw-settings-tab${activeTab === tab.id ? " is-active" : ""}`}
						key={tab.id}
						onClick={() => setActiveTab(tab.id)}
						type="button">
						<tab.icon size={15} />
						<span>{tab.name}</span>
					</button>
				))}
			</aside>
			<section aria-label="設定内容" className="kw-settings-detail">
				<div className="kw-settings-content">{content}</div>
			</section>
		</main>
	)
}

const KocodeWorkbenchView = () => {
	const [memos, setMemos] = useState<KocodeMemoDocument[]>([])
	const [selectedMemoId, setSelectedMemoId] = useState<string>()
	const [activePage, setActivePage] = useState<KocodeWorkbenchPage>("report")
	// 進行中の survey 会話。survey_question / survey_updated で更新する。
	const [survey, setSurvey] = useState<KocodeSurveySession | null>(null)
	const [answerDraft, setAnswerDraft] = useState("")
	const [submitting, setSubmitting] = useState(false)

	const loadSession = useCallback(() => {
		KocodeServiceClient.getKocodeSession(EmptyRequest.create({}))
			.then((session) => {
				setMemos(session.memos ?? [])
				setSelectedMemoId(session.selectedMemoId ?? session.memos?.at(-1)?.id)
				setSurvey(session.survey ?? null)
				if (session.selectedWorkbenchPage) {
					setActivePage(session.selectedWorkbenchPage)
				} else if (session.survey) {
					// 進行中の survey があれば、開いた時点でアンケートページに合わせる。
					if (session.survey.status === "active") {
						setActivePage("survey")
					}
				}
			})
			.catch(console.error)
	}, [])

	useEffect(() => {
		loadSession()
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
				if (event.type === "workbench_page_selected") {
					setActivePage(event.page)
				}
				if (event.type === "survey_question") {
					// 新しい質問が来たら回答欄をリセット。
					setAnswerDraft("")
					setSubmitting(false)
					setActivePage("survey")
				}
				if (event.type === "survey_updated") {
					setSurvey(event.survey)
					if (event.survey.current) {
						setAnswerDraft("")
						setSubmitting(false)
					}
				}
			},
			onError: console.error,
			onComplete: () => undefined,
		})

		return cleanup
	}, [loadSession])

	const submitSurveyAnswer = (text: string) => {
		const trimmed = text.trim()
		if (!trimmed || submitting) {
			return
		}
		setSubmitting(true)
		KocodeServiceClient.answerWorkerAsk({ text: trimmed }).catch((error) => {
			console.error(error)
			setSubmitting(false)
		})
	}

	const sortedMemos = useMemo(() => sortMemos(memos), [memos])
	const selectedMemo = useMemo(() => {
		return sortedMemos.find((memo) => memo.id === selectedMemoId) ?? sortedMemos[0]
	}, [selectedMemoId, sortedMemos])

	const selectMemo = useCallback((memoId: string) => {
		setSelectedMemoId(memoId)
		void KocodeServiceClient.openWorkbench({ memoId })
	}, [])

	const selectPage = useCallback((page: KocodeWorkbenchPage) => {
		setActivePage(page)
		void KocodeServiceClient.openWorkbench({ page })
	}, [])

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
						onClick={() => selectPage("report")}
						type="button">
						レポート
					</button>
					<button
						aria-current={activePage === "survey" ? "page" : undefined}
						className={activePage === "survey" ? "is-active" : ""}
						onClick={() => selectPage("survey")}
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
					<PlaceholderIconButton
						className={activePage === "settings" ? "is-active" : ""}
						label="設定"
						onClick={() => selectPage("settings")}>
						<SettingsIcon size={18} />
					</PlaceholderIconButton>
					<img alt="" aria-hidden className="kw-avatar" draggable={false} src={kokoAvatar} />
				</div>
			</header>

			{activePage === "settings" ? (
				<KocodeSettingsPanel />
			) : activePage === "survey" ? (
				<main className="kw-survey-page">
					{survey && (survey.entries.length > 0 || survey.current) ? (
						<section aria-label="アンケート" className="kw-survey-active">
							<header className="kw-survey-head">
								<img alt="" aria-hidden draggable={false} src={kokoAvatar} />
								<div>
									<span>アンケート</span>
									<h2>{survey.taskGoal ? survey.taskGoal : "一緒に計画を整理するにゃ"}</h2>
									<p>
										{survey.status === "active"
											? `${survey.entries.length}問 回答済み`
											: "このアンケートは終了したにゃ。計画レポートを見てね。"}
									</p>
								</div>
							</header>

							<ol className="kw-survey-history">
								{survey.entries.map((entry, index) => (
									<li className="kw-survey-history-item" key={`${entry.question}-${index}`}>
										<p className="kw-survey-history-q">
											<span>Q{index + 1}</span>
											{entry.question}
										</p>
										<p className="kw-survey-history-a">{entry.answer ?? "(未回答)"}</p>
									</li>
								))}
							</ol>

							{survey.status === "active" && survey.current && (
								<div className="kw-survey-current">
									<p className="kw-survey-current-q">
										<span>Q{survey.entries.length + 1}</span>
										{survey.current.question}
									</p>
									{survey.current.options.length > 0 && (
										<div className="kw-survey-current-options">
											{survey.current.options.map((option) => (
												<button
													className="kw-survey-current-option"
													disabled={submitting}
													key={option}
													onClick={() => submitSurveyAnswer(option)}
													type="button">
													{option}
												</button>
											))}
										</div>
									)}
									<div className="kw-survey-current-free">
										<textarea
											disabled={submitting}
											onChange={(event) => setAnswerDraft(event.target.value)}
											onKeyDown={(event) => {
												if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
													submitSurveyAnswer(answerDraft)
												}
											}}
											placeholder="自分の言葉で答えてもいいにゃ（⌘/Ctrl+Enter で送信）"
											value={answerDraft}
										/>
										<button
											className="kw-survey-send"
											disabled={submitting || !answerDraft.trim()}
											onClick={() => submitSurveyAnswer(answerDraft)}
											type="button">
											送信
										</button>
									</div>
								</div>
							)}
						</section>
					) : (
						<section aria-label="アンケート" className="kw-survey-panel">
							<div className="kw-survey-mascot">
								<img alt="" aria-hidden draggable={false} src={kokoAvatar} />
							</div>
							<div className="kw-survey-copy">
								<span>アンケート</span>
								<h2>まだアンケートはありません。</h2>
								<p>複雑な依頼のとき、ここで一問一答しながら計画を固めていくにゃ。</p>
							</div>
							<i aria-hidden />
						</section>
					)}
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
									onClick={() => selectMemo(memo.id)}
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
