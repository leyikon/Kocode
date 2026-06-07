import type { Boolean, EmptyRequest } from "@shared/proto/cline/common"
import { useCallback, useEffect, useState } from "react"
import AccountView from "./components/account/AccountView"
import ChatView from "./components/chat/ChatView"
import HistoryView from "./components/history/HistoryView"
import KocodeChatView from "./components/kocode/KocodeChatView"
import KocodeWorkbenchView from "./components/kocode/workbench/KocodeWorkbenchView"
import McpView from "./components/mcp/configuration/McpConfigurationView"
import OnboardingView from "./components/onboarding/OnboardingView"
import SettingsView from "./components/settings/SettingsView"
import WorktreesView from "./components/worktrees/WorktreesView"
import { useClineAuth } from "./context/ClineAuthContext"
import { useExtensionState } from "./context/ExtensionStateContext"
import { Providers } from "./Providers"
import { UiServiceClient } from "./services/grpc-client"

const AppContent = () => {
	const webviewMode = (window as Window & { __KOCODE_WEBVIEW_MODE__?: string }).__KOCODE_WEBVIEW_MODE__
	const [chatExperience, setChatExperience] = useState<"kocode" | "legacy">("kocode")
	const {
		didHydrateState,
		showWelcome,
		shouldShowAnnouncement,
		showMcp,
		mcpTab,
		showSettings,
		settingsTargetSection,
		showHistory,
		showAccount,
		showWorktrees,
		showAnnouncement,
		setShowAnnouncement,
		setShouldShowAnnouncement,
		closeMcpView,
		navigateToHistory,
		hideSettings,
		hideHistory,
		hideAccount,
		hideWorktrees,
		hideAnnouncement,
	} = useExtensionState()

	const { clineUser, organizations, activeOrganization } = useClineAuth()

	const showUpdateAnnouncementModal = useCallback(() => {
		setShowAnnouncement(true)
		UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
			.then((response: Boolean) => {
				setShouldShowAnnouncement(response.value)
			})
			.catch((error) => {
				console.error("Failed to acknowledge announcement:", error)
			})
	}, [setShouldShowAnnouncement, setShowAnnouncement])

	useEffect(() => {
		if (!didHydrateState || showWelcome || !shouldShowAnnouncement || showAnnouncement) {
			return
		}
		showUpdateAnnouncementModal()
	}, [didHydrateState, showWelcome, shouldShowAnnouncement, showAnnouncement, showUpdateAnnouncementModal])

	useEffect(() => {
		const handleKocodeMessage = (event: MessageEvent) => {
			if (event.data?.type === "kocode_show_legacy") {
				setChatExperience("legacy")
			}
		}
		window.addEventListener("message", handleKocodeMessage)
		return () => window.removeEventListener("message", handleKocodeMessage)
	}, [])

	if (webviewMode === "kocode-workbench") {
		return <KocodeWorkbenchView />
	}

	if (!didHydrateState) {
		return null
	}

	if (showWelcome) {
		return <OnboardingView />
	}

	return (
		<div className="flex h-screen w-full flex-col">
			{showSettings && <SettingsView onDone={hideSettings} targetSection={settingsTargetSection} />}
			{showHistory && <HistoryView onDone={hideHistory} />}
			{showMcp && <McpView initialTab={mcpTab} onDone={closeMcpView} />}
			{showAccount && (
				<AccountView
					activeOrganization={activeOrganization}
					clineUser={clineUser}
					onDone={hideAccount}
					organizations={organizations}
				/>
			)}
			{showWorktrees && <WorktreesView onDone={hideWorktrees} />}
			{chatExperience === "kocode" ? (
				<KocodeChatView isHidden={showSettings || showHistory || showMcp || showAccount || showWorktrees} />
			) : (
				<div className="relative flex h-full min-h-0 flex-col">
					{/* Legacy chat remains available while Kocode is developed independently. */}
					<ChatView
						hideAnnouncement={hideAnnouncement}
						isHidden={showSettings || showHistory || showMcp || showAccount || showWorktrees}
						showAnnouncement={showAnnouncement}
						showHistoryView={navigateToHistory}
					/>
					{!showSettings && !showHistory && !showMcp && !showAccount && !showWorktrees && (
						<button className="kocode-legacy-return" onClick={() => setChatExperience("kocode")} type="button">
							ここちゃん画面へ
						</button>
					)}
				</div>
			)}
		</div>
	)
}

const App = () => {
	return (
		<Providers>
			<AppContent />
		</Providers>
	)
}

export default App
