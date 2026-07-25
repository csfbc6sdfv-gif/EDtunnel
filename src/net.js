const IPV4_BLOCKS = [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
];

const CLOUDFLARE_IPV4_BLOCKS = [
	['173.245.48.0', 20],
	['103.21.244.0', 22],
	['103.22.200.0', 22],
	['103.31.4.0', 22],
	['141.101.64.0', 18],
	['108.162.192.0', 18],
	['190.93.240.0', 20],
	['188.114.96.0', 20],
	['197.234.240.0', 22],
	['198.41.128.0', 17],
	['162.158.0.0', 15],
	['104.16.0.0', 13],
	['104.24.0.0', 14],
	['172.64.0.0', 13],
	['131.0.72.0', 22],
];

const DENIED_DOMAIN_SUFFIXES = [
	'.arpa',
	'.example',
	'.home',
	'.internal',
	'.invalid',
	'.lan',
	'.local',
	'.localhost',
	'.test',
];

const DENIED_DOMAIN_NAMES = new Set([
	'localhost',
	'metadata',
	'metadata.aws.internal',
	'metadata.google.internal',
]);

export function parseIPv4(value) {
	if (typeof value !== 'string') return null;
	const parts = value.split('.');
	if (parts.length !== 4) return null;
	const bytes = [];
	for (const part of parts) {
		if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
		const byte = Number(part);
		if (byte > 255) return null;
		bytes.push(byte);
	}
	return bytes;
}

function ipv4ToNumber(bytes) {
	return (
		((bytes[0] << 24) >>> 0) +
		(bytes[1] << 16) +
		(bytes[2] << 8) +
		bytes[3]
	) >>> 0;
}

function isInIPv4Cidr(bytes, network, prefix) {
	const networkBytes = parseIPv4(network);
	if (!networkBytes) return false;
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (ipv4ToNumber(bytes) & mask) === (ipv4ToNumber(networkBytes) & mask);
}

export function isPublicIPv4(value) {
	const bytes = parseIPv4(value);
	if (!bytes) return false;
	return !IPV4_BLOCKS.some(([network, prefix]) =>
		isInIPv4Cidr(bytes, network, prefix)
	);
}

export function isCloudflareIPv4(value) {
	const bytes = parseIPv4(value);
	if (!bytes) return false;
	return CLOUDFLARE_IPV4_BLOCKS.some(([network, prefix]) =>
		isInIPv4Cidr(bytes, network, prefix)
	);
}

function parseIPv6(value) {
	if (typeof value !== 'string' || !value || value.includes('%')) return null;
	let normalized = value.toLowerCase();

	if (normalized.includes('.')) {
		const lastColon = normalized.lastIndexOf(':');
		if (lastColon < 0) return null;
		const ipv4 = parseIPv4(normalized.slice(lastColon + 1));
		if (!ipv4) return null;
		normalized =
			normalized.slice(0, lastColon) +
			':' +
			((ipv4[0] << 8) | ipv4[1]).toString(16) +
			':' +
			((ipv4[2] << 8) | ipv4[3]).toString(16);
	}

	if ((normalized.match(/::/g) || []).length > 1) return null;
	const hasCompression = normalized.includes('::');
	const [leftText, rightText = ''] = normalized.split('::');
	const left = leftText ? leftText.split(':') : [];
	const right = rightText ? rightText.split(':') : [];
	if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
		return null;
	}

	let groups;
	if (hasCompression) {
		const missing = 8 - left.length - right.length;
		if (missing < 1) return null;
		groups = [...left, ...Array(missing).fill('0'), ...right];
	} else {
		if (left.length !== 8) return null;
		groups = left;
	}

	const bytes = [];
	for (const group of groups) {
		const word = Number.parseInt(group, 16);
		bytes.push(word >>> 8, word & 0xff);
	}
	return bytes;
}

export function isPublicIPv6(value) {
	const bytes = parseIPv6(value);
	if (!bytes) return false;

	const isMappedIPv4 =
		bytes.slice(0, 10).every((byte) => byte === 0) &&
		bytes[10] === 0xff &&
		bytes[11] === 0xff;
	if (isMappedIPv4) {
		return isPublicIPv4(bytes.slice(12).join('.'));
	}

	if ((bytes[0] & 0xe0) !== 0x20) return false;
	if (
		bytes[0] === 0x20 &&
		bytes[1] === 0x01 &&
		bytes[2] === 0x0d &&
		bytes[3] === 0xb8
	) {
		return false;
	}
	if (
		bytes[0] === 0x20 &&
		bytes[1] === 0x01 &&
		bytes[2] === 0x00 &&
		(bytes[3] & 0xf0) === 0x10
	) {
		return false;
	}
	if (
		bytes[0] === 0x20 &&
		bytes[1] === 0x01 &&
		bytes[2] === 0x00 &&
		bytes[3] === 0x02 &&
		bytes[4] === 0 &&
		bytes[5] === 0
	) {
		return false;
	}
	return true;
}

export function isSafeDomain(value) {
	if (typeof value !== 'string') return false;
	const domain = value.toLowerCase().replace(/\.$/, '');
	if (DENIED_DOMAIN_NAMES.has(domain)) return false;
	if (DENIED_DOMAIN_SUFFIXES.some((suffix) => domain.endsWith(suffix))) {
		return false;
	}
	if (domain.length > 253 || !domain.includes('.')) return false;
	return domain.split('.').every(
		(label) =>
			label.length > 0 &&
			label.length <= 63 &&
			/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
	);
}

export function isSafeTarget(addressType, value) {
	if (addressType === 1) return isPublicIPv4(value);
	if (addressType === 2) return isSafeDomain(value);
	if (addressType === 3) return isPublicIPv6(value);
	return false;
}
