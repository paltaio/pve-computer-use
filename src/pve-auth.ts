/**
 * PVE Auth Manager
 *
 * Handles ticket-based authentication against the Proxmox VE API.
 * API tokens cannot be used for WebSocket endpoints (VNC),
 * so we must use username+password → ticket auth flow.
 *
 * Tickets expire in 2 hours. We auto-refresh at ~1 hour.
 */

import { httpRequest } from './http.js'

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

export function loadCredentialsFromEnv(): PveCredentials {
	const host = process.env.PVE_HOST
	if (!host) throw new Error('PVE_HOST environment variable is required')

	const username = process.env.PVE_USER
	if (!username) throw new Error('PVE_USER environment variable is required')

	const password = process.env.PVE_PASSWORD
	if (!password) throw new Error('PVE_PASSWORD environment variable is required')

	return {
		host,
		port: parseInt(process.env.PVE_PORT ?? '8006', 10),
		username,
		password,
		verifySsl: process.env.PVE_VERIFY_SSL !== 'false',
	}
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
