import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { combineErrorRetryMessages } from "@shared/combineErrorRetryMessages"
import { combineHookSequences } from "@shared/combineHookSequences"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { BooleanRequest } from "@shared/proto/cline/common"
import { MenuIcon, PlusIcon, SendIcon, SettingsIcon } from "lucide-react"
import { useCallback, useEffect, useMemo } from "react"
import { useMount } from "react-use"
import { Virtuoso } from "react-virtuoso"
import kokoAvatar from "@/assets/kocode/koko-avatar.png"
import kokoBanner from "@/assets/kocode/koko-banner.png"
import { MarkdownRow } from "@/components/chat/MarkdownRow"
import UserMessage from "@/components/chat/UserMessage"
import {
	ActionButtons,
	CHAT_CONSTANTS,
	ChatLayout,
	filterVisibleMessages,
	groupLowStakesTools,
	groupMessages,
	InputSection,
	useChatState,
	useMessageHandlers,
	useScrollBehavior,
} from "@/components/chat/chat-view"
import { MessageRenderer } from "@/components/chat/chat-view/components/messages/MessageRenderer"
import { normalizeApiConfiguration } from "@/components/settings/utils/providerUtils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { FileServiceClient, UiServiceClient } from "@/services/grpc-client"
import "./KocodeChatView.css"

interface KocodeChatViewProps {
	isHidden: boolean
	onOpenLegacy: () => void
}

const MAX_ATTACHMENTS = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE
const WAITING_MESSAGE_TS = Number.MIN_SAFE_INTEGER

const formatTime = (timestamp: number) =>
	new Date(timestamp).toLocaleTimeString("ja-JP", {
		hour: "2-digit",
		minute: "2-digit",
	})

const KocodeHeader = ({ onOpenLegacy, onOpenSettings }: { onOpenLegacy: () => void; onOpenSettings: () => void }) => (
	<header className="kocode-topbar">
		<button aria-label="以前の画面を開く" className="kocode-icon-button" onClick={onOpenLegacy} type="button">
			<MenuIcon size={21} />
		</button>
		<div className="kocode-logo">
			<span aria-hidden>♡</span>
			<strong>Kocode / ココーデ</strong>
		</div>
		<button aria-label="設定" className="kocode-icon-button" onClick={onOpenSettings} type="button">
			<SettingsIcon size={20} />
		</button>
	</header>
)

const KocodeHero = () => (
	<section className="kocode-hero">
		<img alt="ここちゃん" className="kocode-hero-art" src={kokoBanner} />
		<div className="kocode-hero-copy">
			<h1>
				ここちゃん<span> paw</span>
			</h1>
			<p>
				なんでも気軽に
				<br />
				聞いてにゃ！
			</p>
		</div>
	</section>
)

const Avatar = () => <img alt="" aria-hidden className="kocode-avatar" draggable={false} src={kokoAvatar} />

const AssistantBubble = ({ children, timestamp }: { children: React.ReactNode; timestamp?: number }) => (
	<div className="kocode-row kocode-row-assistant">
		<Avatar />
		<div className="kocode-bubble-wrap">
			<div className="kocode-bubble kocode-assistant-bubble">{children}</div>
			{timestamp !== undefined && <time>{formatTime(timestamp)}</time>}
		</div>
	</div>
)

const UserBubble = ({ children, timestamp }: { children: React.ReactNode; timestamp?: number }) => (
	<div className="kocode-row kocode-row-user">
		<div className="kocode-bubble-wrap">
			<div className="kocode-bubble kocode-user-bubble">{children}</div>
			{timestamp !== undefined && (
				<div className="kocode-sent">
					<time>{formatTime(timestamp)}</time>
					<span>✓</span>
				</div>
			)}
		</div>
	</div>
)

const KocodeEmptyChat = () => (
	<div className="kocode-empty-chat">
		<div className="kocode-day-divider">今日</div>
		<AssistantBubble>
			ボス、まずは小さく
			<br />
			作ってみるにゃ。
		</AssistantBubble>
		<UserBubble>うまく動かないよ〜</UserBubble>
		<AssistantBubble>
			このエラー、こわくないにゃ。
			<br />
			原因を一緒に見つけるにゃ〜
		</AssistantBubble>
	</div>
)

interface KocodeMessageItemProps {
	item: ClineMessage | ClineMessage[]
	index: number
	rows: (ClineMessage | ClineMessage[])[]
	modifiedMessages: ClineMessage[]
	chatState: ReturnType<typeof useChatState>
	messageHandlers: ReturnType<typeof useMessageHandlers>
	scrollBehavior: ReturnType<typeof useScrollBehavior>
}

const KocodeMessageItem = ({
	item,
	index,
	rows,
	modifiedMessages,
	chatState,
	messageHandlers,
	scrollBehavior,
}: KocodeMessageItemProps) => {
	if (!Array.isArray(item) && item.ts === WAITING_MESSAGE_TS) {
		return <AssistantBubble>考えているにゃ...</AssistantBubble>
	}

	if (!Array.isArray(item) && item.type === "say" && item.say === "task") {
		return <UserBubble timestamp={item.ts}>{item.text}</UserBubble>
	}

	if (!Array.isArray(item) && item.type === "say" && item.say === "user_feedback") {
		return (
			<UserBubble timestamp={item.ts}>
				<UserMessage
					files={item.files}
					images={item.images}
					messageTs={item.ts}
					sendMessageFromChatRow={messageHandlers.handleSendMessage}
					text={item.text}
				/>
			</UserBubble>
		)
	}

	if (!Array.isArray(item) && item.type === "say" && item.say === "text") {
		return (
			<AssistantBubble timestamp={item.ts}>
				<MarkdownRow markdown={item.text} />
			</AssistantBubble>
		)
	}

	return (
		<AssistantBubble timestamp={Array.isArray(item) ? item[0]?.ts : item.ts}>
			<div className="kocode-embedded-card">
				<MessageRenderer
					expandedRows={chatState.expandedRows}
					footerActive={false}
					groupedMessages={rows}
					index={index}
					inputValue={chatState.inputValue}
					messageHandlers={messageHandlers}
					messageOrGroup={item}
					modifiedMessages={modifiedMessages}
					onHeightChange={scrollBehavior.handleRowHeightChange}
					onSetQuote={chatState.setActiveQuote}
					onToggleExpand={scrollBehavior.toggleRowExpansion}
				/>
			</div>
		</AssistantBubble>
	)
}

const KocodeChatView = ({ isHidden, onOpenLegacy }: KocodeChatViewProps) => {
	const { apiConfiguration, clineMessages: messages, hooksEnabled, mode, navigateToSettings } = useExtensionState()
	const task = useMemo(() => messages.at(0), [messages])
	const modifiedMessages = useMemo(() => {
		const afterTask = messages.slice(1)
		const withHooks = hooksEnabled ? combineHookSequences(afterTask) : afterTask
		return combineErrorRetryMessages(combineApiRequests(combineCommandSequences(withHooks)))
	}, [hooksEnabled, messages])
	const visibleMessages = useMemo(() => filterVisibleMessages(modifiedMessages), [modifiedMessages])
	const groupedMessages = useMemo(() => groupLowStakesTools(groupMessages(visibleMessages)), [visibleMessages])

	const chatState = useChatState(messages)
	const messageHandlers = useMessageHandlers(messages, chatState)
	const scrollBehavior = useScrollBehavior(
		messages,
		visibleMessages,
		groupedMessages,
		chatState.expandedRows,
		chatState.setExpandedRows,
	)
	const { selectedModelInfo } = useMemo(() => normalizeApiConfiguration(apiConfiguration, mode), [apiConfiguration, mode])

	const selectFilesAndImages = useCallback(async () => {
		const response = await FileServiceClient.selectFiles(BooleanRequest.create({ value: selectedModelInfo.supportsImages }))
		const availableSlots = MAX_ATTACHMENTS - chatState.selectedImages.length - chatState.selectedFiles.length
		if (!response || availableSlots <= 0) {
			return
		}
		const imagesToAdd = response.values1.slice(0, availableSlots)
		const filesToAdd = response.values2.slice(0, availableSlots - imagesToAdd.length)
		chatState.setSelectedImages((previous) => [...previous, ...imagesToAdd])
		chatState.setSelectedFiles((previous) => [...previous, ...filesToAdd])
	}, [chatState, selectedModelInfo.supportsImages])

	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToShowWebview(
			{},
			{
				onResponse: (event) => {
					if (!isHidden && !event.preserveEditorFocus) {
						chatState.textAreaRef.current?.focus()
					}
				},
				onError: console.error,
				onComplete: () => undefined,
			},
		)
		return cleanup
	}, [chatState.textAreaRef, isHidden])

	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToAddToInput(
			{},
			{
				onResponse: (event) => {
					if (event.value) {
						chatState.setInputValue((previous) => (previous ? `${previous}\n${event.value}\n` : `${event.value}\n`))
					}
				},
				onError: console.error,
				onComplete: () => undefined,
			},
		)
		return cleanup
	}, [chatState.setInputValue])

	useMount(() => chatState.textAreaRef.current?.focus())

	const waitingForKoko = useMemo(() => {
		const last = messages.at(-1)
		return (
			!!task && (messages.length === 1 || (last?.type === "say" && last.say === "api_req_started" && last.partial === true))
		)
	}, [messages, task])

	const rows = useMemo<(ClineMessage | ClineMessage[])[]>(() => {
		if (!task) {
			return []
		}
		const conversation: (ClineMessage | ClineMessage[])[] = [task, ...groupedMessages]
		if (waitingForKoko) {
			conversation.push({
				partial: true,
				say: "reasoning",
				text: "",
				ts: WAITING_MESSAGE_TS,
				type: "say",
			})
		}
		return conversation
	}, [groupedMessages, task, waitingForKoko])

	const attachmentsDisabled = chatState.selectedImages.length + chatState.selectedFiles.length >= MAX_ATTACHMENTS

	return (
		<ChatLayout isHidden={isHidden}>
			<main className="kocode-view">
				<KocodeHeader onOpenLegacy={onOpenLegacy} onOpenSettings={() => navigateToSettings()} />
				<KocodeHero />
				<section className="kocode-conversation">
					{task ? (
						<Virtuoso
							atBottomStateChange={scrollBehavior.setIsAtBottom}
							className="kocode-thread scrollable"
							data={rows}
							initialTopMostItemIndex={rows.length - 1}
							itemContent={(index, item) => (
								<KocodeMessageItem
									chatState={chatState}
									index={index}
									item={item}
									messageHandlers={messageHandlers}
									modifiedMessages={modifiedMessages}
									rows={rows}
									scrollBehavior={scrollBehavior}
								/>
							)}
							key={task.ts}
							ref={scrollBehavior.virtuosoRef}
						/>
					) : (
						<KocodeEmptyChat />
					)}
				</section>
			</main>
			<footer className="kocode-input-dock">
				<ActionButtons
					chatState={chatState}
					messageHandlers={messageHandlers}
					messages={messages}
					mode={mode}
					scrollBehavior={scrollBehavior}
					task={task}
				/>
				<div className="kocode-compose-row">
					<button
						aria-label="ファイルや画像を追加"
						className="kocode-compose-action"
						disabled={attachmentsDisabled}
						onClick={() => void selectFilesAndImages()}
						type="button">
						<PlusIcon size={22} />
					</button>
					<div className="kocode-composer">
						<InputSection
							chatState={chatState}
							messageHandlers={messageHandlers}
							placeholderText="ここちゃんにメッセージを送る..."
							scrollBehavior={scrollBehavior}
							selectFilesAndImages={selectFilesAndImages}
							shouldDisableFilesAndImages={attachmentsDisabled}
							variant="kocode"
						/>
					</div>
					<button
						aria-label="送信"
						className="kocode-compose-action kocode-send-ornament"
						onClick={() =>
							void messageHandlers.handleSendMessage(
								chatState.inputValue,
								chatState.selectedImages,
								chatState.selectedFiles,
							)
						}
						type="button">
						<SendIcon size={21} />
					</button>
				</div>
				<div className="kocode-footer-copy">♡ Kocode はあなたのコーディングを応援するにゃ！</div>
			</footer>
		</ChatLayout>
	)
}

export default KocodeChatView
