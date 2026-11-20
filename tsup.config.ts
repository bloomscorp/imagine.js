import {defineConfig} from 'tsup';
import {readFileSync} from 'fs';

const {version} = JSON.parse(readFileSync('./package.json', 'utf8'));
const define = {__IMAGINE_JS_VERSION__: JSON.stringify(version)};

export default defineConfig([
	// npm: ESM and CommonJS, with types.
	{
		entry: ['./src/index.ts'],
		format: ['cjs', 'esm'],
		dts: true,
		clean: true,
		sourcemap: false,
		target: 'es2020',
		platform: 'browser',
		define,
	},
	// <script>: one minified file that sets the global `BloomsImagine`.
	{
		entry: {imagine: './src/global.ts'},
		format: ['iife'],
		globalName: 'BloomsImagine',
		minify: true,
		sourcemap: false,
		target: 'es2020',
		platform: 'browser',
		define,
	},
]);
