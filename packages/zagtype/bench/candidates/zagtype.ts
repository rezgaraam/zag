/** Pipeline: `type(def)` compiles lazily; each call returns data or ZagErrors directly. */
import { ZagErrors, type } from "../../src";
import type { Candidate } from "../candidate";
import type { Def } from "../ir";

export const zagtypeCandidate: Candidate = {
	name: "zagtype",
	type(def: Def) {
		// Runtime-generated benchmark definitions cannot preserve the const generic.
		return type(def as never);
	},
	allows(def: Def) {
		const schema = type(def as never);
		return (value: unknown) => schema.allows(value);
	},
	isErrors: result => result instanceof ZagErrors,
	summary: result => (result instanceof ZagErrors ? result.summary : ""),
};
