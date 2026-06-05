import { Logger } from "@/shared/services/Logger"

type TraceValue = string | number | boolean | null | undefined | TraceValue[] | { [key: string]: TraceValue }

function safeStringify(value: TraceValue): string {
	if (value === undefined) {
		return "undefined"
	}
	try {
		return JSON.stringify(value) ?? "undefined"
	} catch {
		return JSON.stringify(String(value))
	}
}

function preview(value: unknown, maxLength = 360): string {
	const text = typeof value === "string" ? value : safeStringify(value as TraceValue)
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}`
	}
	return String(error)
}

export const KocodeTrace = {
	log(event: string, fields: Record<string, unknown> = {}): void {
		try {
			const parts = Object.entries(fields).map(([key, value]) => `${key}=${preview(value)}`)
			Logger.log(`[Kocode Trace] ${event}${parts.length ? ` ${parts.join(" ")}` : ""}`)
		} catch (error) {
			Logger.warn(`[Kocode Trace] logger_failed event=${event} error=${errorMessage(error)}`)
		}
	},

	warn(event: string, fields: Record<string, unknown> = {}): void {
		try {
			const parts = Object.entries(fields).map(([key, value]) => `${key}=${preview(value)}`)
			Logger.warn(`[Kocode Trace] ${event}${parts.length ? ` ${parts.join(" ")}` : ""}`)
		} catch (error) {
			Logger.warn(`[Kocode Trace] logger_failed event=${event} error=${errorMessage(error)}`)
		}
	},

	error(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
		try {
			const parts = Object.entries({ ...fields, error: errorMessage(error) }).map(([key, value]) => `${key}=${preview(value)}`)
			Logger.warn(`[Kocode Trace] ${event}${parts.length ? ` ${parts.join(" ")}` : ""}`)
		} catch (traceError) {
			Logger.warn(`[Kocode Trace] logger_failed event=${event} error=${errorMessage(traceError)} originalError=${errorMessage(error)}`)
		}
	},
}

export const __test__ = {
	preview,
	errorMessage,
}
