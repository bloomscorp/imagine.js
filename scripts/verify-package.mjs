// The packaging gate: what `npm publish` would ship is exactly the intended files,
// loads in both module systems, and the <script> build works as a script tag.
// Requires `npm run build` first.
import {execSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const fail = (msg) => { console.error(`verify-package: ${msg}`); process.exit(1); };
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Files
const packed = JSON.parse(execSync('npm pack --dry-run --json --ignore-scripts', {encoding: 'utf8'}))[0];
const files = packed.files.map(f => f.path).sort();
const allowed = [
	'LICENSE.md', 'README.md', 'dist/imagine.global.js', 'dist/index.d.mts', 'dist/index.d.ts',
	'dist/index.js', 'dist/index.mjs', 'package.json',
];
const extra = files.filter(f => !allowed.includes(f));
const missing = allowed.filter(f => !files.includes(f));
if (extra.length) fail(`unexpected files in the package: ${extra.join(', ')}`);
if (missing.length) fail(`missing from the package: ${missing.join(', ')}`);

// Manifest
if (Object.keys(pkg.dependencies ?? {}).length) fail('the core must have no runtime dependencies');
if (pkg.sideEffects !== false) fail('package.json should declare "sideEffects": false');
if (!/github\.com\/bloomscorp\/imagine\.js/.test(pkg.repository?.url ?? '')) fail('repository.url must name bloomscorp/imagine.js (npm provenance checks it)');

// CommonJS and ESM
const expected = ['ImagineBrowser', 'ImagineError', 'isImagineError', 'VERSION'];
const require = createRequire(import.meta.url);
const cjs = require('../dist/index.js');
const esm = await import('../dist/index.mjs');
for (const [name, mod] of [['cjs', cjs], ['esm', esm]]) {
	const exported = Object.keys(mod).filter(k => k !== 'default').sort();
	if (JSON.stringify(exported) !== JSON.stringify([...expected].sort())) fail(`${name} exports ${exported.join(', ')}; expected ${expected.join(', ')}`);
	if (mod.VERSION !== pkg.version) fail(`${name} VERSION ${mod.VERSION} does not match package.json ${pkg.version}`);
}
const types = readFileSync(new URL('../dist/index.d.ts', import.meta.url), 'utf8');
for (const name of ['ImagineBrowser', 'ImagineError', 'CreateJobRequest', 'Job', 'Image', 'Session', 'Presets']) {
	if (!new RegExp(`\\b${name}\\b`).test(types)) fail(`the types do not declare ${name}`);
}

// <script> build: run it the way a page does, with a stubbed fetch.
const seen = [];
const context = vm.createContext({
	console, setTimeout, clearTimeout, AbortController, URL, FormData, Blob, Headers, Response,
	fetch: async (url, init) => {
		seen.push({url: String(url), auth: init.headers.Authorization});
		return new Response(JSON.stringify({success: true, data: {expiresAt: '2099-01-01T00:00:00.000Z', modes: ['prompt']}}), {status: 200});
	},
});
vm.runInContext(readFileSync(new URL('../dist/imagine.global.js', import.meta.url), 'utf8'), context);
const global = context.BloomsImagine;
if (!global || typeof global.ImagineBrowser !== 'function') fail('the <script> build does not define BloomsImagine.ImagineBrowser');
if (global.VERSION !== pkg.version) fail(`the <script> build's VERSION ${global.VERSION} does not match ${pkg.version}`);
const client = new global.ImagineBrowser({getSessionToken: () => 'ims_check', baseUrl: 'https://z.example'});
const session = await client.session();
if (session.modes?.[0] !== 'prompt') fail('the <script> build did not return the session');
if (seen[0]?.url !== 'https://z.example/api/v1/imagine/browser/session' || seen[0]?.auth !== 'Bearer ims_check') {
	fail(`the <script> build sent ${JSON.stringify(seen[0])}`);
}

console.log(`verify-package: ok (${files.length} files, cjs + esm + <script> load, version ${pkg.version}, no dependencies)`);
