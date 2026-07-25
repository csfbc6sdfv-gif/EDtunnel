import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
	MAX_PENDING_OUTBOUND_BYTES,
	upgradeVlessWebSocket,
} from '../src/ws.js';

const TEST_UUID = ['55555555', '5555', '4555', '8555', '555555555555'].join('-');

function uuidBytes(uuid) {
	const hex = uuid.replaceAll('-', '');
	return Uint8Array.from(
		{ length: 16 },
		(_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
	);
}

function packet(initialData = []) {
	const address = new TextEncoder().encode('example.com');
	return Uint8Array.from([
		0,
		...uuidBytes(TEST_UUID),
		0,
		1,
		1,
		187,
		2,
		address.length,
		...address,
		...initialData,
	]);
}

function deferred() {
	let resolve;
	let reject;
	let settled = false;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = (value) => {
			if (settled) return;
			settled = true;
			resolvePromise(value);
		};
		reject = (error) => {
			if (settled) return;
			settled = true;
			rejectPromise(error);
		};
	});
	return { promise, reject, resolve };
}

function fakeSocket({
	manualOpen = false,
	readableClosed = false,
	writeFailure = false,
} = {}) {
	const open = deferred();
	const writes = [];
	let closeCount = 0;
	let readableController;
	let readableEnded = false;
	const readable = new ReadableStream({
		start(controller) {
			readableController = controller;
			if (readableClosed) {
				readableEnded = true;
				controller.close();
			}
		},
	});
	const writable = new WritableStream({
		write(chunk) {
			if (writeFailure) throw new Error('write failed');
			writes.push(Uint8Array.from(chunk));
		},
	});
	const socket = {
		close() {
			closeCount += 1;
			open.reject(new Error('closed'));
			if (!readableEnded) {
				readableEnded = true;
				try {
					readableController.close();
				} catch {
					// The readable may already be closing.
				}
			}
		},
		endReadable() {
			if (readableEnded) return;
			readableEnded = true;
			readableController.close();
		},
		get closeCount() {
			return closeCount;
		},
		opened: open.promise,
		readable,
		resolveOpen: open.resolve,
		writable,
		writes,
	};
	if (!manualOpen) open.resolve();
	return socket;
}

class FakeWebSocket {
	constructor() {
		this.closeCalls = [];
		this.listeners = new Map();
		this.readyState = 1;
		this.sent = [];
	}

	accept() {}

	addEventListener(type, listener) {
		const listeners = this.listeners.get(type) || [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	close(code, reason) {
		if (this.readyState !== 1) return;
		this.closeCalls.push({ code, reason });
		this.readyState = 3;
		this.emit('close', {});
	}

	emit(type, event) {
		for (const listener of this.listeners.get(type) || []) listener(event);
	}

	message(data) {
		this.emit('message', { data });
	}

	send(data) {
		if (this.readyState !== 1) throw new Error('socket closed');
		this.sent.push(Uint8Array.from(data));
	}
}

let latestPair;
class FakeWebSocketPair {
	constructor() {
		const client = new FakeWebSocket();
		const server = new FakeWebSocket();
		latestPair = { client, server };
		this[0] = client;
		this[1] = server;
	}
}

class FakeUpgradeResponse {
	constructor(_body, init) {
		this.status = init.status;
		this.webSocket = init.webSocket;
	}
}

const originalResponse = globalThis.Response;
const originalWebSocketPair = globalThis.WebSocketPair;
globalThis.Response = FakeUpgradeResponse;
globalThis.WebSocketPair = FakeWebSocketPair;
after(() => {
	globalThis.Response = originalResponse;
	globalThis.WebSocketPair = originalWebSocketPair;
});

function config(overrides = {}) {
	return {
		proxyFallback: false,
		proxyPool: [],
		proxyTimeout: 1000,
		userID: TEST_UUID,
		...overrides,
	};
}

function start(connect, overrides = {}) {
	latestPair = null;
	const response = upgradeVlessWebSocket(
		{ headers: new Headers() },
		config(overrides),
		connect
	);
	assert.equal(response.status, 101);
	assert.ok(latestPair);
	return latestPair.server;
}

async function waitUntil(predicate, message) {
	const deadline = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			assert.fail(message);
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

test('delayed socket buffers multiple frames and drains them in order', async () => {
	const socket = fakeSocket({ manualOpen: true });
	const endpoints = [];
	const server = start((endpoint) => {
		endpoints.push(endpoint);
		return socket;
	});

	server.message(packet([1, 2]));
	server.message(Uint8Array.from([3]));
	server.message(Uint8Array.from([4, 5]));
	await waitUntil(() => endpoints.length === 1, 'direct connection did not start');
	assert.equal(server.closeCalls.length, 0);

	socket.resolveOpen();
	await waitUntil(() => socket.writes.length === 3, 'buffer did not drain');
	assert.deepEqual(
		socket.writes.map((chunk) => [...chunk]),
		[[1, 2], [3], [4, 5]]
	);
	assert.equal(server.closeCalls.length, 0);
	server.emit('close', {});
});

test('pending buffer overflow closes with 1009 and aborts the opening socket', async () => {
	const socket = fakeSocket({ manualOpen: true });
	const server = start(() => socket);

	server.message(packet());
	server.message(new Uint8Array(MAX_PENDING_OUTBOUND_BYTES));
	server.message(Uint8Array.of(1));
	await waitUntil(() => server.closeCalls.length === 1, 'overflow did not close');

	assert.equal(server.closeCalls[0].code, 1009);
	assert.ok(socket.closeCount >= 1);
	assert.equal(socket.writes.length, 0);
});

test('a pre-forwarding open failure may switch to the next candidate', async () => {
	const first = fakeSocket({ manualOpen: true });
	first.close();
	const second = fakeSocket();
	const endpoints = [];
	const server = start(
		(endpoint) => {
			endpoints.push(endpoint);
			return endpoints.length === 1 ? first : second;
		},
		{
			proxyPool: [{ hostname: '8.8.8.8', port: 443 }],
		}
	);

	server.message(packet([9]));
	await waitUntil(() => second.writes.length === 1, 'proxy candidate was not used');
	assert.deepEqual(endpoints, [
		{ hostname: 'example.com', port: 443 },
		{ hostname: '8.8.8.8', port: 443 },
	]);
	assert.deepEqual([...second.writes[0]], [9]);
	server.emit('close', {});
});

test('a candidate may switch after a no-byte close', async () => {
	const first = fakeSocket({ readableClosed: true });
	const second = fakeSocket();
	const endpoints = [];
	const server = start(
		(endpoint) => {
			endpoints.push(endpoint);
			return endpoints.length === 1 ? first : second;
		},
		{
			proxyPool: [{ hostname: '8.8.4.4', port: 443 }],
		}
	);

	server.message(packet());
	await waitUntil(() => endpoints.length === 2, 'no-byte retry did not occur');
	assert.equal(server.closeCalls.length, 0);
	server.emit('close', {});
});

test('no candidate switch is allowed after bytes are forwarded', async () => {
	const first = fakeSocket();
	const endpoints = [];
	const server = start(
		(endpoint) => {
			endpoints.push(endpoint);
			return first;
		},
		{
			proxyPool: [{ hostname: '1.1.1.1', port: 443 }],
		}
	);

	server.message(packet([7]));
	await waitUntil(() => first.writes.length === 1, 'initial bytes were not sent');
	first.endReadable();
	await waitUntil(() => server.closeCalls.length === 1, 'session did not close');

	assert.equal(endpoints.length, 1);
	assert.equal(server.closeCalls[0].code, 1000);
});

test('an uncertain failed write commits the candidate and forbids retry', async () => {
	const first = fakeSocket({ writeFailure: true });
	const endpoints = [];
	const server = start(
		(endpoint) => {
			endpoints.push(endpoint);
			return first;
		},
		{
			proxyPool: [{ hostname: '9.9.9.9', port: 443 }],
		}
	);

	server.message(packet([6]));
	await waitUntil(() => server.closeCalls.length === 1, 'write failure did not close');

	assert.equal(endpoints.length, 1);
	assert.equal(server.closeCalls[0].code, 1011);
});
