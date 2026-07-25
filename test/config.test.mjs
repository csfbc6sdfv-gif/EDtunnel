import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, normalizeHost } from '../src/config.js';

const TEST_UUID = ['11111111', '1111', '4111', '8111', '111111111111'].join('-');
const TEST_PATH = '/' + 'aB3_-xY9'.repeat(3);

function validEnv(overrides = {}) {
	return {
		ALLOWED_HOSTS: 'stage.pages.dev,edge.song0810.xyz',
		PROXY_FALLBACK: 'true',
		PROXY_TIMEOUT: '2000',
		UUID: TEST_UUID,
		WS_PATH: TEST_PATH,
		...overrides,
	};
}

test('required secrets and allowed hosts fail closed', () => {
	assert.equal(loadConfig(validEnv({ UUID: undefined })).ok, false);
	assert.equal(loadConfig(validEnv({ WS_PATH: undefined })).ok, false);
	assert.equal(loadConfig(validEnv({ ALLOWED_HOSTS: undefined })).ok, false);
	assert.equal(loadConfig(validEnv({ UUID: TEST_UUID.replace('-4', '-1') })).ok, false);
	assert.equal(loadConfig(validEnv({ WS_PATH: '/short' })).ok, false);
	assert.equal(
		loadConfig(validEnv({ ALLOWED_HOSTS: 'stage.pages.dev:443' })).ok,
		false
	);
});

test('only bounded settings are accepted', () => {
	assert.equal(loadConfig(validEnv({ PROXY_TIMEOUT: '999' })).ok, false);
	assert.equal(loadConfig(validEnv({ PROXY_TIMEOUT: '5001' })).ok, false);
	assert.equal(loadConfig(validEnv({ PROXY_FALLBACK: 'yes' })).ok, false);
	assert.equal(loadConfig(validEnv({ PROXY_TIMEOUT: '1000' })).ok, true);
	assert.equal(loadConfig(validEnv({ PROXY_TIMEOUT: '5000' })).ok, true);
});

test('proxy pool rejects URLs, private, reserved, and Cloudflare addresses', () => {
	assert.equal(loadConfig(validEnv({ PROXYIP: 'https://8.8.8.8:443' })).ok, false);
	assert.equal(loadConfig(validEnv({ PROXYIP: '127.0.0.1:443' })).ok, false);
	assert.equal(loadConfig(validEnv({ PROXYIP: '169.254.169.254:80' })).ok, false);
	assert.equal(loadConfig(validEnv({ PROXYIP: '104.16.1.1:443' })).ok, false);
	assert.equal(
		loadConfig(validEnv({ PROXYIP: '8.8.8.8:443,1.1.1.1:443,9.9.9.9:443,4.2.2.2:443' })).ok,
		false
	);
	assert.equal(loadConfig(validEnv({ PROXYIP: '8.8.8.8:443' })).ok, true);
});

test('host normalization is exact and port-aware', () => {
	assert.equal(normalizeHost('EDGE.SONG0810.XYZ'), 'edge.song0810.xyz');
	assert.equal(normalizeHost('edge.song0810.xyz:443'), 'edge.song0810.xyz');
	assert.equal(normalizeHost('[::1]:443'), '');
});
