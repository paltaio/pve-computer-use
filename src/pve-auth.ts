/**
 * PVE Auth Manager
 *
 * Handles ticket-based authentication against the Proxmox VE API.
 * API tokens cannot be used for WebSocket endpoints (VNC),
 * so we must use username+password ticket auth flow.
 *
 * Tickets expire in 2 hours. We auto-refresh at ~1 hour.
 */

import { httpRequest } from './http.js'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PveCredentialInput {
	host?: string
	user?: string
	port?: number
	username?: string
	password?: string
	verifySsl?: boolean
}

export interface PveCredentials {
	host: string
	port: number
	username: string
	password: string
	verifySsl: boolean
}

export interface PveTicket {
	ticket: string
	csrfToken: string
	expiresAt: number
}

export function loadCredentials(input: PveCredentialInput = {}): PveCredentials {
	const fileEnv = loadCredentialFile()
	const host = input.host ?? process.env.PVE_HOST ?? fileEnv.PVE_HOST
	const username = input.username ?? input.user ?? process.env.PVE_USER ?? fileEnv.PVE_USER
	const password = input.password ?? process.env.PVE_PASSWORD ?? fileEnv.PVE_PASSWORD
	const port = input.port ?? Number(process.env.PVE_PORT ?? fileEnv.PVE_PORT ?? 8006)
	const verifySsl =
		input.verifySsl ?? (process.env.PVE_VERIFY_SSL ?? fileEnv.PVE_VERIFY_SSL) !== 'false'

	return {
		host: requiredValue('PVE_HOST', host),
		port: Number.isFinite(port) ? port : 8006,
		username: requiredValue('PVE_USER', username),
		password: requiredValue('PVE_PASSWORD', password),
		verifySsl,
	}
}

function requiredValue(name: string, value: string | undefined): string {
	if (value) return value
	throw new Error(`${name} is required.${credentialHint()}`)
}

function credentialHint(): string {
	const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pve.env')
	if (existsSync(envPath)) {
		return `\nProvide config, set PVE_HOST/PVE_USER/PVE_PASSWORD, or fix ${envPath}.`
	}
	return '\nProvide config or set PVE_HOST, PVE_USER, and PVE_PASSWORD.'
}

function loadCredentialFile(): Record<string, string> {
	const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pve.env')
	if (!existsSync(envPath)) return {}
	const out: Record<string, string> = {}
	for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
		if (!match) continue
		out[match[1]] = parseEnvValue(match[2].trim())
	}
	return out
}

function parseEnvValue(value: string): string {
	if (value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/'\\''/g, "'")
	}
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
	}
	return value
}

export class PveAuthManager {
	private credentials: PveCredentials
	private currentTicket: PveTicket | null = null
	private refreshTimer: ReturnType<typeof setTimeout> | null = null

	private static readonly REFRESH_MARGIN_MS = 5 * 60 * 1000 // 5 minutes
	private static readonly TICKET_LIFETIME_MS = 2 * 60 * 60 * 1000 // 2 hours

	constructor(credentials: PveCredentials) {
		this.credentials = credentials
	}

	get baseUrl(): string {
		return `https://${this.credentials.host}:${this.credentials.port}`
	}

	get verifySsl(): boolean {
		return this.credentials.verifySsl
	}

	async getTicket(): Promise<PveTicket> {
		if (
			this.currentTicket &&
			Date.now() < this.currentTicket.expiresAt - PveAuthManager.REFRESH_MARGIN_MS
		) {
			return this.currentTicket
		}
		return this.authenticate()
	}

	/**
	 * Force a fresh ticket, ignoring the cache. Useful after permission changes.
	 */
	async forceRefresh(): Promise<PveTicket> {
		this.currentTicket = null
		return this.authenticate()
	}

	/**
	 * Authenticate or refresh. On refresh, the old ticket is used as the password.
	 */
	async authenticate(): Promise<PveTicket> {
		const password = this.currentTicket?.ticket ?? this.credentials.password

		const body = new URLSearchParams({
			username: this.credentials.username,
			password,
		})

		const resp = await httpRequest(`${this.baseUrl}/api2/json/access/ticket`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
			verifySsl: this.credentials.verifySsl,
		})

		if (!resp.ok) {
			const text = await resp.text()
			throw new Error(`PVE authentication failed (${resp.status}): ${text}`)
		}

		const json = (await resp.json()) as {
			data: { ticket: string; CSRFPreventionToken: string }
		}

		this.currentTicket = {
			ticket: json.data.ticket,
			csrfToken: json.data.CSRFPreventionToken,
			expiresAt: Date.now() + PveAuthManager.TICKET_LIFETIME_MS,
		}

		this.scheduleRefresh()
		return this.currentTicket
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer)
		}

		const refreshIn = PveAuthManager.TICKET_LIFETIME_MS - PveAuthManager.REFRESH_MARGIN_MS
		this.refreshTimer = setTimeout(() => {
			this.authenticate().catch((err) => {
				console.error('PVE ticket refresh failed:', err)
			})
		}, refreshIn)

		this.refreshTimer.unref()
	}

	destroy(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer)
			this.refreshTimer = null
		}
		this.currentTicket = null
	}
}
