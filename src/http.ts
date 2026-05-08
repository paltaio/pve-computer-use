/**
 * HTTP client wrapper that handles TLS verification bypass for PVE.
 *
 * Bun and Node.js take different paths for self-signed cert support:
 * - Bun: native fetch accepts a `tls: { rejectUnauthorized }` option.
 * - Node: undici fetch with a custom dispatcher whose `connect` options
 *   set `rejectUnauthorized: false`. Undici's dispatcher option is not
 *   honored by Bun's compiled binary, so we cannot rely on it cross-runtime.
 */

import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

let secureDispatcher: Dispatcher | null = null
let insecureDispatcher: Dispatcher | null = null

function getDispatcher(verifySsl: boolean): Dispatcher {
	if (verifySsl) {
		if (!secureDispatcher) {
			secureDispatcher = new Agent()
		}
		return secureDispatcher
	}
	if (!insecureDispatcher) {
		insecureDispatcher = new Agent({
			connect: { rejectUnauthorized: false },
		})
	}
	return insecureDispatcher
}

export interface HttpOptions {
	method?: string
	headers?: Record<string, string>
	body?: string
	verifySsl?: boolean
}

export async function httpRequest(
	url: string,
	options: HttpOptions = {},
): Promise<{
	status: number
	ok: boolean
	text: () => Promise<string>
	json: () => Promise<unknown>
}> {
	const verifySsl = options.verifySsl ?? true

	type FetchResponse = {
		status: number
		ok: boolean
		text(): Promise<string>
		json(): Promise<unknown>
	}

	const init: {
		method?: string
		headers?: Record<string, string>
		body?: string
		dispatcher?: Dispatcher
		tls?: { rejectUnauthorized?: boolean }
	} = {
		method: options.method ?? 'GET',
		headers: options.headers,
		body: options.body,
	}

	let resp: FetchResponse
	if (isBun) {
		init.tls = { rejectUnauthorized: verifySsl }
		resp = (await fetch(url, init as RequestInit)) as FetchResponse
	} else {
		init.dispatcher = getDispatcher(verifySsl)
		resp = (await undiciFetch(url, init)) as FetchResponse
	}

	return {
		status: resp.status,
		ok: resp.ok,
		text: () => resp.text(),
		json: () => resp.json(),
	}
}

export function destroyDispatchers(): void {
	secureDispatcher?.close()
	secureDispatcher = null
	insecureDispatcher?.close()
	insecureDispatcher = null
}
