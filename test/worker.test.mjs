import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../src/worker.js';

const TEST_UUID = ['44444444', '4444', '4444', '8444', '444444444444'].join('-');
const TEST_PATH = '/' + 'Qw7_zX-2'.repeat(3);
const HOST = 'stage.pages.dev';
const ENV = {
	ALLOWED_HOSTS: `${HOST},edge.song0810.xyz`,
	UUID: TEST_UUID,
	WS_PATH: TEST_PATH,
};

function request(path, headers = {}, method = 'GET') {
	return new Request(`https://${HOST}${path}`, {
		headers: { host: HOST, ...headers },
		method,
	});
}

test('missing and malformed configuration returns 503', async () => {
	assert.equal((await handleRequest(request('/healthz'), {}, () => {})).status, 503);
	assert.equal(
		(await handleRequest(request('/healthz'), { ...ENV, UUID: 'invalid' }, () => {})).status,
		503
	);
});

test('health route is the only ordinary HTTP route', async () => {
	assert.equal(
		(await handleRequest(request('/healthz'), ENV, () => {})).status,
		204
	);
	for (const path of [
		'/',
		'/cf',
		'/sub/value',
		'/trojan/value',
		'/bestip/value',
		`/${TEST_UUID}`,
	]) {
		assert.equal((await handleRequest(request(path), ENV, () => {})).status, 404);
	}
});

test('wrong Host and path fail before WebSocket creation', async () => {
	assert.equal(
		(
			await handleRequest(
				new Request(`https://${HOST}${TEST_PATH}`, {
					headers: { host: 'wrong.pages.dev', upgrade: 'websocket' },
				}),
				ENV,
				() => {
					throw new Error('connect must not run');
				}
			)
		).status,
		404
	);
	assert.equal(
		(
			await handleRequest(
				request('/wrong', { upgrade: 'websocket' }),
				ENV,
				() => {
					throw new Error('connect must not run');
				}
			)
		).status,
		404
	);
});

test('query parameters cannot override the outbound configuration', async () => {
	for (const query of [
		'?proxyip=8.8.8.8:443',
		'?socks5=8.8.8.8:1080',
		'?http=8.8.8.8:8080',
		'?vless=value',
		'?globalproxy=1',
		'?gvless=value',
	]) {
		const response = await handleRequest(
			request(TEST_PATH + query, { upgrade: 'websocket' }),
			ENV,
			() => {
				throw new Error('connect must not run');
			}
		);
		assert.equal(response.status, 404);
	}
});
