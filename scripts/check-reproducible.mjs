import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..'
);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'edtunnel-build-'));
const first = path.join(temporaryRoot, 'first');
const second = path.join(temporaryRoot, 'second');

function runBuild(output) {
	const result = spawnSync(
		process.execPath,
		[path.join(repositoryRoot, 'scripts/build-pages.mjs'), output],
		{ cwd: repositoryRoot, encoding: 'utf8' }
	);
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || 'Build failed');
	}
}

try {
	runBuild(first);
	runBuild(second);
	const [firstArtifact, secondArtifact] = await Promise.all([
		readFile(path.join(first, '_worker.js')),
		readFile(path.join(second, '_worker.js')),
	]);
	const firstHash = createHash('sha256').update(firstArtifact).digest('hex');
	const secondHash = createHash('sha256').update(secondArtifact).digest('hex');
	if (firstHash !== secondHash) {
		throw new Error('Build artifacts are not reproducible');
	}
	process.stdout.write(`${firstHash}\n`);
} finally {
	await rm(temporaryRoot, { force: true, recursive: true });
}
