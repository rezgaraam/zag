declare module "zag-ext-compat-modules" {
	/** Lazy host package namespace loaders retained for compiled legacy extensions. */
	export const BUNDLED_ZAG_MODULE_LOADERS: Readonly<Record<string, () => Promise<Readonly<Record<string, unknown>>>>>;
}
