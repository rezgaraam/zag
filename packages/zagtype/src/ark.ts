/**
 * ArkType compatibility facade — `@zag/zagtype/ark`.
 *
 * Lets code written against arktype keep its imports and names while running
 * on the zagtype lazy-JIT runtime: swap `from "arktype"` for
 * `from "@zag/zagtype/ark"` and nothing else changes. New code should
 * import `@zag/zagtype` directly.
 *
 * Compatibility affordance: `ArkError` / `ArkErrors` alias `ZagError` /
 * `ZagErrors`. All schema builders, including recursive `scope()`, are
 * re-exported unchanged.
 */
import { ZagError, ZagErrors } from "./errors";

export * from "./index";

export const ArkError = ZagError;
export type ArkError = ZagError;
export const ArkErrors = ZagErrors;
export type ArkErrors = ZagErrors;
