import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..'
);
const artifactPath = path.join(repositoryRoot, 'dist', '_worker.js');
const artifact = await readFile(artifactPath, 'utf8');

const prohibited = [
	['embedded UUID', /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i],
	['external URL', /https?:\/\//i],
	['dynamic code evaluation', /\beval\s*\(|\bnew\s+Function\s*\(/],
	['console logging', /\bconsole\s*\./],
	['obfuscator marker', /\bjavascript-obfuscator\b|(?:^|[^a-z0-9])_0x[0-9a-f]+/i],
	['retired public route', /\/(?:sub|trojan|bestip)\/|["'`]\/cf["'`]/i],
	['retired proxy mode', /\bSOCKS5\b|\bHTTP CONNECT\b|\bVLESS_OUTBOUND\b/i],
	['known external helper', /06151953|url\.v1\.mk|img2ipfs|jsdelivr|cdn-all/i],
];

const failures = prohibited
	.filter(([, pattern]) => pattern.test(artifact))
	.map(([label]) => label);
if (failures.length > 0) {
	throw new Error(`Artifact audit failed: ${failures.join(', ')}`);
}

const hash = createHash('sha256').update(artifact).digest('hex');
process.stdout.write(
	JSON.stringify(
		{
			bytes: Buffer.byteLength(artifact),
			file: 'dist/_worker.js',
			sha256: hash,
		},
		null,
		2
	) + '\n'
);
