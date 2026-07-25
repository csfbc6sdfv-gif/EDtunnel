import { parseVlessHeader } from './vless.js';

const WS_OPEN = 1;
const MAX_EARLY_DATA_BYTES = 8192;
export const MAX_PENDING_OUTBOUND_BYTES = 64 * 1024;

function closeWebSocket(socket, code = 1000) {
	try {
		if (socket.readyState === WS_OPEN) {
			socket.close(code, '');
		}
	} catch {
		// Closure is best-effort and never logged with connection metadata.
	}
}

function closeTcp(socket) {
	try {
		socket?.close();
	} catch {
		// Closure is best-effort.
	}
}

function clearPending(state) {
	state.pendingChunks.length = 0;
	state.pendingBytes = 0;
}

function terminate(state, webSocket, code) {
	if (state.closed) return;
	state.closed = true;
	clearPending(state);
	closeTcp(state.openingSocket);
	closeTcp(state.socket);
	closeWebSocket(webSocket, code);
}

function toBytes(value) {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	return null;
}

function decodeEarlyData(header) {
	if (!header) return null;
	const token = header.split(',')[0].trim();
	if (!token || token.length > Math.ceil((MAX_EARLY_DATA_BYTES * 4) / 3) + 4) {
		return null;
	}
	try {
		const normalized = token.replaceAll('-', '+').replaceAll('_', '/');
		const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
		const binary = atob(normalized + padding);
		if (binary.length > MAX_EARLY_DATA_BYTES) return null;
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

function waitForOpen(socket, milliseconds) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timeout')), milliseconds);
		Promise.resolve(socket.opened).then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

async function writeToSocket(socket, bytes) {
	if (!bytes || bytes.byteLength === 0) return;
	const writer = socket.writable.getWriter();
	try {
		await writer.write(bytes);
	} finally {
		writer.releaseLock();
	}
}

async function openSocket(connect, endpoint, timeout, state) {
	let socket;
	try {
		socket = connect(endpoint);
		state.openingSocket = socket;
		await waitForOpen(socket, timeout);
		if (state.closed) {
			closeTcp(socket);
			return null;
		}
		return socket;
	} catch {
		closeTcp(socket);
		return null;
	} finally {
		if (state.openingSocket === socket) state.openingSocket = null;
	}
}

function sendChunk(webSocket, state, chunk) {
	if (webSocket.readyState !== WS_OPEN) return false;
	const bytes = toBytes(chunk);
	if (!bytes) return false;

	state.candidateCommitted = true;
	if (state.responseHeader) {
		const combined = new Uint8Array(
			state.responseHeader.byteLength + bytes.byteLength
		);
		combined.set(state.responseHeader, 0);
		combined.set(bytes, state.responseHeader.byteLength);
		state.responseHeader = null;
		webSocket.send(combined.buffer);
	} else {
		webSocket.send(bytes);
	}
	state.forwardedBytes += bytes.byteLength;
	return true;
}

async function pumpRemote(socket, webSocket, state) {
	let receivedData = false;
	try {
		const reader = socket.readable.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				let sent;
				try {
					sent = sendChunk(webSocket, state, value);
				} catch {
					terminate(state, webSocket, 1011);
					break;
				}
				if (!sent) {
					terminate(state, webSocket, 1011);
					break;
				}
				receivedData = true;
			}
		} finally {
			reader.releaseLock();
		}
	} catch {
		// The caller decides whether a no-data connection may use a retry.
	}
	return receivedData;
}

function enqueuePending(state, bytes) {
	if (
		bytes.byteLength > MAX_PENDING_OUTBOUND_BYTES - state.pendingBytes
	) {
		return false;
	}
	if (bytes.byteLength > 0) {
		state.pendingChunks.push(bytes.slice());
		state.pendingBytes += bytes.byteLength;
	}
	return true;
}

async function drainPending(socket, webSocket, state) {
	while (
		!state.closed &&
		state.socket === socket &&
		state.pendingChunks.length > 0
	) {
		const bytes = state.pendingChunks[0];
		// A write can partially reach the peer before rejecting, so the candidate
		// is committed before the first write attempt rather than after it.
		state.candidateCommitted = true;
		try {
			await writeToSocket(socket, bytes);
		} catch {
			terminate(state, webSocket, 1011);
			return;
		}
		if (state.closed || state.socket !== socket) return;
		state.pendingChunks.shift();
		state.pendingBytes -= bytes.byteLength;
		state.forwardedBytes += bytes.byteLength;
	}
}

function scheduleDrain(webSocket, state) {
	if (
		state.closed ||
		!state.socket ||
		state.drainRunning ||
		state.pendingChunks.length === 0
	) {
		return;
	}
	const socket = state.socket;
	state.drainRunning = true;
	state.drainPromise = drainPending(socket, webSocket, state).finally(() => {
		state.drainRunning = false;
		if (
			!state.closed &&
			state.socket === socket &&
			state.pendingChunks.length > 0
		) {
			scheduleDrain(webSocket, state);
		}
	});
}

async function waitForDrain(socket, state) {
	while (!state.closed && state.socket === socket && state.drainRunning) {
		const current = state.drainPromise;
		await current;
		if (state.drainPromise === current && !state.drainRunning) return;
	}
}

function candidateEndpoints(config, target) {
	const direct = { hostname: target.address, port: target.port };
	const endpoints = [direct, ...config.proxyPool];
	if (config.proxyFallback && config.proxyPool.length > 0) {
		endpoints.push(direct);
	}
	return endpoints;
}

async function runOutbound(connect, webSocket, state, target) {
	for (const endpoint of candidateEndpoints(state.config, target)) {
		if (state.closed || state.candidateCommitted) break;
		const socket = await openSocket(
			connect,
			endpoint,
			state.config.proxyTimeout,
			state
		);
		if (!socket) continue;

		state.socket = socket;
		scheduleDrain(webSocket, state);
		await pumpRemote(socket, webSocket, state);
		await waitForDrain(socket, state);
		if (state.socket === socket) state.socket = null;
		closeTcp(socket);

		if (state.closed) return;
		if (state.candidateCommitted) {
			terminate(state, webSocket, 1000);
			return;
		}
	}
	terminate(state, webSocket, 1011);
}

async function handleClientChunk(chunk, connect, webSocket, state) {
	const bytes = toBytes(chunk);
	if (!bytes || bytes.byteLength === 0 || state.closed) {
		terminate(state, webSocket, 1008);
		return;
	}

	if (!state.headerAccepted) {
		const parsed = parseVlessHeader(bytes, state.config.userID);
		if (!parsed.ok) {
			terminate(state, webSocket, 1008);
			return;
		}
		state.headerAccepted = true;
		state.responseHeader = parsed.value.responseHeader;
		if (!enqueuePending(state, parsed.value.initialData)) {
			terminate(state, webSocket, 1009);
			return;
		}
		void runOutbound(connect, webSocket, state, parsed.value).catch(() =>
			terminate(state, webSocket, 1011)
		);
		return;
	}

	if (!enqueuePending(state, bytes)) {
		terminate(state, webSocket, 1009);
		return;
	}
	scheduleDrain(webSocket, state);
}

export function upgradeVlessWebSocket(request, config, connect) {
	const pair = new WebSocketPair();
	const [client, server] = Object.values(pair);
	server.accept();

	const state = {
		closed: false,
		config,
		candidateCommitted: false,
		drainPromise: null,
		drainRunning: false,
		forwardedBytes: 0,
		headerAccepted: false,
		openingSocket: null,
		pendingBytes: 0,
		pendingChunks: [],
		responseHeader: null,
		socket: null,
	};
	let queue = Promise.resolve();

	server.addEventListener('message', (event) => {
		queue = queue
			.then(() => handleClientChunk(event.data, connect, server, state))
			.catch(() => closeWebSocket(server));
	});
	server.addEventListener('close', () => {
		state.closed = true;
		clearPending(state);
		closeTcp(state.openingSocket);
		closeTcp(state.socket);
	});
	server.addEventListener('error', () => {
		terminate(state, server, 1011);
	});

	const earlyData = decodeEarlyData(
		request.headers.get('sec-websocket-protocol') || ''
	);
	if (earlyData) {
		queue = queue
			.then(() => handleClientChunk(earlyData, connect, server, state))
			.catch(() => closeWebSocket(server));
	}

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}
