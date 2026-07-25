import {
	isCloudflareIPv4,
	isPublicIPv4,
	parseIPv4,
} from './net.js';

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WS_PATH = /^\/[A-Za-z0-9_-]{24,}$/;

function isValidHostname(value) {
	if (typeof value !== 'string' || value.length > 253 || !value.includes('.')) {
		return false;
	}
	return value.split('.').every(
		(label) =>
			label.length > 0 &&
			label.length <= 63 &&
			/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
	);
}

export function normalizeHost(value) {
	if (typeof value !== 'string') return '';
	const host = value.trim().toLowerCase();
	if (!host || host.startsWith('[')) return '';
	const colon = host.lastIndexOf(':');
	if (colon > -1) {
		const port = host.slice(colon + 1);
		if (!/^\d+$/.test(port)) return '';
		return host.slice(0, colon);
	}
	return host;
}

function parseAllowedHosts(value) {
	if (typeof value !== 'string') return null;
	const hosts = value
		.split(',')
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
	if (hosts.length === 0 || new Set(hosts).size !== hosts.length) return null;
	if (!hosts.every(isValidHostname)) return null;
	return new Set(hosts);
}

function parseBoolean(value, fallback) {
	if (value === undefined || value === null || value === '') return fallback;
	if (value === true || value === 'true') return true;
	if (value === false || value === 'false') return false;
	return null;
}

function parseTimeout(value) {
	if (value === undefined || value === null || value === '') return 2000;
	if (!/^\d+$/.test(String(value))) return null;
	const timeout = Number(value);
	return timeout >= 1000 && timeout <= 5000 ? timeout : null;
}

function parseProxyEndpoint(value) {
	const match = /^((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/.exec(value);
	if (!match) return null;
	const host = match[1];
	const port = Number(match[2]);
	if (!parseIPv4(host) || !isPublicIPv4(host) || isCloudflareIPv4(host)) {
		return null;
	}
	if (port < 1 || port > 65535) return null;
	return { hostname: host, port };
}

function parseProxyPool(value) {
	if (value === undefined || value === null || value.trim() === '') return [];
	if (typeof value !== 'string' || /:\/\/|[/?#@]/.test(value)) return null;
	const parts = value.split(',').map((item) => item.trim());
	if (parts.length < 1 || parts.length > 3 || parts.some((item) => !item)) {
		return null;
	}
	const endpoints = parts.map(parseProxyEndpoint);
	if (endpoints.some((endpoint) => endpoint === null)) return null;
	const unique = new Set(endpoints.map((item) => `${item.hostname}:${item.port}`));
	return unique.size === endpoints.length ? endpoints : null;
}

export function loadConfig(env) {
	if (!env || typeof env !== 'object') return { ok: false };
	if (typeof env.UUID !== 'string' || !UUID_V4.test(env.UUID)) {
		return { ok: false };
	}
	if (typeof env.WS_PATH !== 'string' || !WS_PATH.test(env.WS_PATH)) {
		return { ok: false };
	}

	const allowedHosts = parseAllowedHosts(env.ALLOWED_HOSTS);
	const proxyPool = parseProxyPool(env.PROXYIP);
	const proxyTimeout = parseTimeout(env.PROXY_TIMEOUT);
	const proxyFallback = parseBoolean(env.PROXY_FALLBACK, true);
	if (
		!allowedHosts ||
		proxyPool === null ||
		proxyTimeout === null ||
		proxyFallback === null
	) {
		return { ok: false };
	}

	return {
		ok: true,
		value: Object.freeze({
			allowedHosts,
			proxyFallback,
			proxyPool: Object.freeze(proxyPool),
			proxyTimeout,
			userID: env.UUID.toLowerCase(),
			wsPath: env.WS_PATH,
		}),
	};
}
