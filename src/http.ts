/**
 * HTTP client wrapper that handles TLS verification bypass for PVE.
 * Uses undici directly so we can pass a custom dispatcher for self-signed certs.
 */

import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'

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
	const dispatcher = getDispatcher(options.verifySsl ?? true)

	const resp = await undiciFetch(url, {
		method: options.method ?? 'GET',
		headers: options.headers,
		body: options.body,
		dispatcher,
	})

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
