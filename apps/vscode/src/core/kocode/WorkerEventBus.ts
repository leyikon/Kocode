import type { KocodeEvent, WorkerDigest, WorkerEvent } from "@shared/kocode"
import { Logger } from "@/shared/services/Logger"

export type KocodeEventListener = (event: KocodeEvent) => void | Promise<void>

export class WorkerEventBus {
	private listeners = new Set<KocodeEventListener>()
	private workerEvents: WorkerEvent[] = []
	private digest: WorkerDigest = {
		status: "idle",
		title: "待機中",
		summary: "まだ作業は始まっていないにゃ。",
		lastEventAt: Date.now(),
	}

	subscribe(listener: KocodeEventListener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getWorkerEvents(): WorkerEvent[] {
		return [...this.workerEvents]
	}

	getDigest(): WorkerDigest {
		return { ...this.digest }
	}

	async emit(event: KocodeEvent): Promise<void> {
		if (event.type === "worker_detail") {
			this.workerEvents.push(event.event)
			this.workerEvents = this.workerEvents.slice(-200)
		}

		if (event.type === "worker_status") {
			this.digest = event.digest
		}

		await Promise.all(
			Array.from(this.listeners).map(async (listener) => {
				try {
					await listener(event)
				} catch (error) {
					Logger.error("[Kocode] Event listener failed", error)
				}
			}),
		)
	}

	async emitWorkerDetail(event: Omit<WorkerEvent, "id" | "ts"> & { id?: string; ts?: number }): Promise<void> {
		const ts = event.ts ?? Date.now()
		await this.emit({
			type: "worker_detail",
			event: {
				...event,
				id: event.id ?? `${ts}-${Math.random().toString(36).slice(2)}`,
				ts,
			},
		})
	}

	async emitDigest(digest: Omit<WorkerDigest, "lastEventAt"> & { lastEventAt?: number }): Promise<void> {
		await this.emit({
			type: "worker_status",
			digest: {
				...digest,
				lastEventAt: digest.lastEventAt ?? Date.now(),
			},
		})
	}
}
