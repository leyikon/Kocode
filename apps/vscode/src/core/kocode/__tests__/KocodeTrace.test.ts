import { expect } from "chai"
import { describe, it } from "mocha"
import { KocodeTrace } from "../KocodeTrace"

describe("KocodeTrace", () => {
	it("never throws when fields contain undefined", () => {
		expect(() =>
			KocodeTrace.log("test_event", {
				taskStatus: undefined,
				taskGoal: undefined,
				ok: true,
			}),
		).not.to.throw()
	})
})
