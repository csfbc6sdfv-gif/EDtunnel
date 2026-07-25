import { loadConfig, normalizeHost } from './config.js';
import { upgradeVlessWebSocket } from './ws.js';

function plainResponse(status) {
	return new Response(null, {
		status,
		headers: {
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		},
	});
}

export async function handleRequest(request, env, connect) {
	const loaded = loadConfig(env);
	if (!loaded.ok) return plainResponse(503);
	const config = loaded.value;

	let url;
	try {
		url = new URL(request.url);
	} catch {
		return plainResponse(404);
	}

	const requestHost = normalizeHost(request.headers.get('host'));
	if (
		!requestHost ||
		requestHost !== url.hostname.toLowerCase() ||
		!config.allowedHosts.has(requestHost)
	) {
		return plainResponse(404);
	}

	const upgrade = (request.headers.get('upgrade') || '').toLowerCase();
	if (
		request.method === 'GET' &&
		upgrade !== 'websocket' &&
		url.pathname === '/healthz' &&
		url.search === ''
	) {
		return plainResponse(204);
	}

	if (
		request.method !== 'GET' ||
		upgrade !== 'websocket' ||
		url.pathname !== config.wsPath ||
		url.search !== ''
	) {
		return plainResponse(404);
	}

	return upgradeVlessWebSocket(request, config, connect);
}
