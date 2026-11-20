/** Filled in at build time from package.json (tsup.config.ts); 'dev' in tests run from source. */
declare const __IMAGINE_JS_VERSION__: string;

export const VERSION: string =
	typeof __IMAGINE_JS_VERSION__ === 'string' ? __IMAGINE_JS_VERSION__ : 'dev';
