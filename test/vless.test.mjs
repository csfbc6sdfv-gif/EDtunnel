import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVlessHeader } from '../src/vless.js';

const TEST_UUID = ['22222222', '2222', '4222', '8222', '222222222222'].join('-');

function uuidBytes(uuid) {
	const hex = uuid.replaceAll('-', '');
	return Uint8Array.from(
		{ length: 16 },
		(_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
	);
}

function packet({ address, addressType, command = 1, uuid = TEST_UUID }) {
	let addressBytes;
	if (addressType === 1) {
		addressBytes = Uint8Array.from(address.split('.').map(Number));
	} else if (addressType === 2) {
		const encoded = new TextEncoder().encode(address);
		addressBytes = Uint8Array.from([encoded.length, ...encoded]);
	} else {
		addressBytes = Uint8Array.from(address);
	}
	return Uint8Array.from([
		0,
		...uuidBytes(uuid),
		0,
		command,
		1,
		187,
		addressType,
		...addressBytes,
		1,
		2,
		3,
	]);
}

test('accepts authenticated TCP for a public target', () => {
	const parsed = parseVlessHeader(
		packet({ address: 'example.com', addressType: 2 }),
		TEST_UUID
	);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.value.port, 443);
	assert.deepEqual([...parsed.value.initialData], [1, 2, 3]);
});

test('wrong UUID and UDP are rejected', () => {
	const wrong = ['33333333', '3333', '4333', '8333', '333333333333'].join('-');
	assert.equal(
		parseVlessHeader(packet({ address: 'example.com', addressType: 2 }), wrong).code,
		'invalid_identity'
	);
	assert.equal(
		parseVlessHeader(
			packet({ address: 'example.com', addressType: 2, command: 2 }),
			TEST_UUID
		).code,
		'unsupported_command'
	);
});

test('private, link-local, metadata, and documentation targets are rejected', () => {
	for (const address of [
		'127.0.0.1',
		'10.0.0.1',
		'169.254.169.254',
		'192.0.2.10',
	]) {
		assert.equal(
			parseVlessHeader(packet({ address, addressType: 1 }), TEST_UUID).code,
			'target_not_allowed'
		);
	}
	for (const address of [
		'localhost',
		'metadata',
		'metadata.aws.internal',
		'metadata.google.internal',
		'host.local',
	]) {
		assert.equal(
			parseVlessHeader(packet({ address, addressType: 2 }), TEST_UUID).code,
			'target_not_allowed'
		);
	}
	const loopback = Array(15).fill(0).concat(1);
	assert.equal(
		parseVlessHeader(packet({ address: loopback, addressType: 3 }), TEST_UUID).code,
		'target_not_allowed'
	);
	const uniqueLocal = [0xfd, ...Array(15).fill(0)];
	const linkLocal = [0xfe, 0x80, ...Array(14).fill(0)];
	const documentation = [0x20, 0x01, 0x0d, 0xb8, ...Array(12).fill(0)];
	for (const address of [uniqueLocal, linkLocal, documentation]) {
		assert.equal(
			parseVlessHeader(packet({ address, addressType: 3 }), TEST_UUID).code,
			'target_not_allowed'
		);
	}
});

test('public IPv6 target is accepted', () => {
	const publicAddress = [
		0x20, 0x01, 0x48, 0x60, 0x48, 0x60, 0, 0,
		0, 0, 0, 0, 0, 0, 0x88, 0x88,
	];
	assert.equal(
		parseVlessHeader(
			packet({ address: publicAddress, addressType: 3 }),
			TEST_UUID
		).ok,
		true
	);
});

test('truncated headers fail without throwing', () => {
	assert.deepEqual(parseVlessHeader(new Uint8Array(2), TEST_UUID), {
		ok: false,
		code: 'invalid_header',
	});
});
