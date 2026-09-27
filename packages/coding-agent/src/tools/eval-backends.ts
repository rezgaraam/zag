import type { ToolSession } from ".";

import { cfgEvalJs, cfgEvalPy } from "../eval/settings";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
}

/** Active eval backend allowance (`eval.py` / `eval.js`; `ZAG_PY` / `ZAG_JS` override). */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	return {
		python: cfgEvalPy.get(session.settings),
		js: cfgEvalJs.get(session.settings),
	};
}
