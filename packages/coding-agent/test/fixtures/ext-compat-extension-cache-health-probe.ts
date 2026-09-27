import { __isExtensionParseCacheAvailableForTests } from "../../src/extensibility/plugins/ext-compat";

process.stdout.write(__isExtensionParseCacheAvailableForTests() ? "AVAILABLE\n" : "UNAVAILABLE\n");
