import { expect } from "chai"
import { describe, it } from "mocha"
import {
	createDefaultMemory,
	InMemoryKocodeMemoryStore,
	KocodeMemoryMutators,
	KocodeMemorySchema,
	memoryToPromptText,
} from "../KocodeMemoryStore"

describe("KocodeMemoryStore", () => {
	it("creates a default memory that satisfies the schema", () => {
		const memory = createDefaultMemory()
		const parsed = KocodeMemorySchema.safeParse(memory)
		expect(parsed.success).to.equal(true)
		expect(memory.skillProfile.level).to.equal("beginner")
	})

	it("dedupes glossary entries by term and bumps updatedAt", () => {
		const initial = createDefaultMemory()
		const first = KocodeMemoryMutators.addGlossary(initial, "SSR", "サーバー側で HTML を作る")
		const second = KocodeMemoryMutators.addGlossary(first, "SSR", "リクエストごとに HTML を生成する仕組み")
		expect(second.glossary.length).to.equal(1)
		expect(second.glossary[0].explanation).to.contain("リクエストごと")
		expect(second.updatedAt).to.be.greaterThanOrEqual(initial.updatedAt)
	})

	it("dedupes rejected directions and caps the list at the bound", () => {
		let memory = createDefaultMemory()
		for (let i = 0; i < 40; i++) {
			memory = KocodeMemoryMutators.rejectDirection(memory, `direction-${i}`)
		}
		expect(memory.rejectedDirections.length).to.be.lessThanOrEqual(25)
		// Re-adding an existing entry shouldn't expand the list.
		const before = memory.rejectedDirections.length
		memory = KocodeMemoryMutators.rejectDirection(memory, "direction-39")
		expect(memory.rejectedDirections.length).to.equal(before)
	})

	it("memoryToPromptText only emits sections that have entries", () => {
		const memory = createDefaultMemory()
		const text = memoryToPromptText(memory)
		expect(text).to.contain("skill_level: beginner")
		expect(text).to.not.contain("glossary:")
	})

	it("InMemoryKocodeMemoryStore round-trips state for tests", async () => {
		const store = new InMemoryKocodeMemoryStore()
		const memory = KocodeMemoryMutators.acceptDecision(createDefaultMemory(), "Use Tailwind")
		await store.save(memory)
		const reloaded = await store.load()
		expect(reloaded.acceptedDecisions.map((entry) => entry.text)).to.deep.equal(["Use Tailwind"])
	})
})
