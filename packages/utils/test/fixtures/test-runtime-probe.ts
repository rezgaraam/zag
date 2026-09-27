import { isBunTestRuntime } from "@zag/zag-utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
