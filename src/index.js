import { connect } from 'cloudflare:sockets';
import { handleRequest } from './worker.js';

export default {
	async fetch(request, env) {
		return handleRequest(request, env, connect);
	}
};
