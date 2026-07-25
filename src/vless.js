import { isSafeTarget } from './net.js';

function uuidBytes(uuid) {
	const hex = uuid.replaceAll('-', '');
	const bytes = new Uint8Array(16);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function equalBytes(left, right) {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left[index] ^ right[index];
	}
	return difference === 0;
}

function failure(code) {
	return { ok: false, code };
}

export function parseVlessHeader(input, expectedUuid) {
	const bytes =
		input instanceof Uint8Array
			? input
			: input instanceof ArrayBuffer
				? new Uint8Array(input)
				: null;
	if (!bytes || bytes.byteLength < 24) return failure('invalid_header');

	const version = bytes[0];
	if (!equalBytes(bytes.slice(1, 17), uuidBytes(expectedUuid))) {
		return failure('invalid_identity');
	}

	const optionLength = bytes[17];
	let cursor = 18 + optionLength;
	if (cursor + 4 > bytes.length) return failure('invalid_header');

	const command = bytes[cursor];
	cursor += 1;
	if (command !== 1) return failure('unsupported_command');

	const port = (bytes[cursor] << 8) | bytes[cursor + 1];
	cursor += 2;
	if (port < 1) return failure('invalid_port');

	const addressType = bytes[cursor];
	cursor += 1;
	let address;

	if (addressType === 1) {
		if (cursor + 4 > bytes.length) return failure('invalid_address');
		address = [...bytes.slice(cursor, cursor + 4)].join('.');
		cursor += 4;
	} else if (addressType === 2) {
		if (cursor + 1 > bytes.length) return failure('invalid_address');
		const length = bytes[cursor];
		cursor += 1;
		if (length < 1 || cursor + length > bytes.length) {
			return failure('invalid_address');
		}
		try {
			address = new TextDecoder('utf-8', { fatal: true }).decode(
				bytes.slice(cursor, cursor + length)
			);
		} catch {
			return failure('invalid_address');
		}
		cursor += length;
	} else if (addressType === 3) {
		if (cursor + 16 > bytes.length) return failure('invalid_address');
		const groups = [];
		for (let index = 0; index < 16; index += 2) {
			groups.push(
				((bytes[cursor + index] << 8) | bytes[cursor + index + 1]).toString(16)
			);
		}
		address = groups.join(':');
		cursor += 16;
	} else {
		return failure('invalid_address');
	}

	if (!isSafeTarget(addressType, address)) {
		return failure('target_not_allowed');
	}

	return {
		ok: true,
		value: {
			address,
			addressType,
			initialData: bytes.slice(cursor),
			port,
			responseHeader: new Uint8Array([version, 0]),
		},
	};
}
