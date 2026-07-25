import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..'
);
const outputDirectory = path.resolve(
	process.argv[2] || path.join(repositoryRoot, 'dist')
);

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });

await build({
	banner: {
		js: '/* SPDX-License-Identifier: MIT; see LICENSE and NOTICE */',
	},
	bundle: true,
	charset: 'ascii',
	entryPoints: [path.join(repositoryRoot, 'src/index.js')],
	external: ['cloudflare:sockets'],
	format: 'esm',
	legalComments: 'none',
	logLevel: 'error',
	minify: false,
	outfile: path.join(outputDirectory, '_worker.js'),
	platform: 'browser',
	sourcemap: false,
	target: ['es2022'],
	treeShaking: true,
});
