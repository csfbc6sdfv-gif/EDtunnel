import { parseVlessHeader } from './vless.js';

const WS_OPEN = 1;
const WS_CLOSING = 2;
const MAX_EARLY_DATA_BYTES = 8192;

function closeWebSocket(socket) {
	try {
		if (socket.readyState === WS_OPEN || socket.readyState === WS_CLOSING) {
			socket.close(1000, '');
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

function timeoutAfter(milliseconds) {
	return new Promise((_, reject) => {
		setTimeout(() => reject(new Error('timeout')), milliseconds);
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

async function openSocket(connect, endpoint, initialData, timeout) {
	let socket;
	try {
		socket = connect(endpoint);
		await Promise.race([socket.opened, timeoutAfter(timeout)]);
		await writeToSocket(socket, initialData);
		return socket;
	} catch {
		closeTcp(socket);
		return null;
	}
}

function sendChunk(webSocket, state, chunk) {
	if (webSocket.readyState !== WS_OPEN) return false;
	const bytes = toBytes(chunk);
	if (!bytes) return false;

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
				if (!sendChunk(webSocket, state, value)) break;
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

async function connectProxySequence(connect, webSocket, state) {
	for (const endpoint of state.config.proxyPool) {
		if (state.closed) return false;
		const socket = await openSocket(
			connect,
			endpoint,
			state.initialData,
			state.config.proxyTimeout
		);
		if (!socket) continue;
		state.socket = socket;
		const receivedData = await pumpRemote(socket, webSocket, state);
		closeTcp(socket);
		if (receivedData) return true;
	}
	return false;
}

async function runOutbound(connect, webSocket, state, target) {
	const directEndpoint = { hostname: target.address, port: target.port };
	let direct = await openSocket(
		connect,
		directEndpoint,
		state.initialData,
		state.config.proxyTimeout
	);
	let receivedData = false;

	if (direct) {
		state.socket = direct;
		receivedData = await pumpRemote(direct, webSocket, state);
		closeTcp(direct);
		if (receivedData || state.closed) {
			closeWebSocket(webSocket);
			return;
		}
	}

	if (state.config.proxyPool.length > 0) {
		receivedData = await connectProxySequence(connect, webSocket, state);
		if (receivedData || state.closed) {
			closeWebSocket(webSocket);
			return;
		}
	}

	if (state.config.proxyFallback && state.config.proxyPool.length > 0) {
		direct = await openSocket(
			connect,
			directEndpoint,
			state.initialData,
			state.config.proxyTimeout
		);
		if (direct) {
			state.socket = direct;
			await pumpRemote(direct, webSocket, state);
			closeTcp(direct);
		}
	}
	closeWebSocket(webSocket);
}

async function handleClientChunk(chunk, connect, webSocket, state) {
	const bytes = toBytes(chunk);
	if (!bytes || bytes.byteLength === 0 || state.closed) {
		closeWebSocket(webSocket);
		return;
	}

	if (!state.headerAccepted) {
		const parsed = parseVlessHeader(bytes, state.config.userID);
		if (!parsed.ok) {
			closeWebSocket(webSocket);
			return;
		}
		state.headerAccepted = true;
		state.initialData = parsed.value.initialData;
		state.responseHeader = parsed.value.responseHeader;
		void runOutbound(connect, webSocket, state, parsed.value);
		return;
	}

	if (!state.socket) {
		closeWebSocket(webSocket);
		return;
	}
	try {
		await writeToSocket(state.socket, bytes);
	} catch {
		closeWebSocket(webSocket);
	}
}

export function upgradeVlessWebSocket(request, config, connect) {
	const pair = new WebSocketPair();
	const [client, server] = Object.values(pair);
	server.accept();

	const state = {
		closed: false,
		config,
		headerAccepted: false,
		initialData: new Uint8Array(),
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
		closeTcp(state.socket);
	});
	server.addEventListener('error', () => {
		state.closed = true;
		closeTcp(state.socket);
		closeWebSocket(server);
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
