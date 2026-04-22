/**
 * PVE API Client
 *
 * Thin HTTP client for the Proxmox VE REST API.
 * All calls go through the auth manager for ticket + CSRF token.
 */

import { httpRequest } from './http.js'
import type { PveAuthManager } from './pve-auth.js'
import { listVmDiskEntries, type VmDiskEntry } from './pve-disk-config.js'

export interface VncProxyResult {
	port: string
	ticket: string
	password: string
}

export interface TermProxyResult {
	port: string
	ticket: string
	user: string
}

export interface VmStatus {
	vmid: number
	name: string
	status: string
	node: string
	type: string
	tags: string[]
}

export interface VmConfig {
	name?: string
	description?: string
	tags: string[]
	disks: VmDiskEntry[]
}

interface RawVmStatus {
	vmid: number
	name: string
	status: string
	node: string
	type: string
	tags?: string
}

interface RawVmConfig {
	name?: string
	description?: string
	tags?: string
	[key: string]: unknown
}

export interface Snapshot {
	name: string
	description?: string
	snaptime?: number
	vmstate?: boolean
	parent?: string
}

export interface BackupVolume {
	volid: string
	size: number
	ctime: number
	format: string
	vmid?: number
	notes?: string
	protected?: boolean
}

/** Raw response from PVE exec-status endpoint */
interface GuestExecRaw {
	exited: boolean
	exitcode?: number
	'out-data'?: string
	'err-data'?: string
	'out-truncated'?: boolean
	'err-truncated'?: boolean
}

export interface GuestExecResult {
	exitcode: number
	stdout: string
	stderr: string
}

const GUEST_EXEC_POLL_INITIAL_MS = 50
const GUEST_EXEC_POLL_MAX_MS = 1000
const DEFAULT_GUEST_EXEC_TIMEOUT_MS = 30_000

function parseVmTags(tags?: string): string[] {
	if (!tags) return []
	return tags
		.split(';')
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0)
}

function normalizeVmStatus(vm: RawVmStatus): VmStatus {
	return {
		...vm,
		tags: parseVmTags(vm.tags),
	}
}

function normalizeVmConfig(config: RawVmConfig): VmConfig {
	return {
		name: config.name,
		description: config.description,
		tags: parseVmTags(config.tags),
		disks: listVmDiskEntries(config),
	}
}

export class PveApiClient {
	constructor(private auth: PveAuthManager) {}

	private async request<T>(
		method: string,
		path: string,
		body?: Record<string, string> | URLSearchParams,
		extraHeaders?: Record<string, string>,
	): Promise<T> {
		const resp = await this.doRequest(method, path, body, extraHeaders)

		// On 403, force a fresh ticket and retry once — permissions may have changed
		if (resp.status === 403) {
			await this.auth.forceRefresh()
			const retry = await this.doRequest(method, path, body, extraHeaders)
			if (!retry.ok) {
				const text = await retry.text()
				throw new Error(`PVE API ${method} ${path} failed (${retry.status}): ${text}`)
			}
			const json = (await retry.json()) as { data: T }
			return json.data
		}

		if (!resp.ok) {
			const text = await resp.text()
			throw new Error(`PVE API ${method} ${path} failed (${resp.status}): ${text}`)
		}

		const json = (await resp.json()) as { data: T }
		return json.data
	}

	private async doRequest(
		method: string,
		path: string,
		body?: Record<string, string> | URLSearchParams,
		extraHeaders?: Record<string, string>,
	) {
		const ticket = await this.auth.getTicket()

		const headers: Record<string, string> = {
			Cookie: `PVEAuthCookie=${ticket.ticket}`,
		}

		if (method !== 'GET') {
			headers['CSRFPreventionToken'] = ticket.csrfToken
		}

		if (extraHeaders) {
			Object.assign(headers, extraHeaders)
		}

		let reqBody: string | undefined
		if (body) {
			headers['Content-Type'] = 'application/x-www-form-urlencoded'
			const params = body instanceof URLSearchParams ? body : new URLSearchParams(body)
			reqBody = params.toString()
		}

		return httpRequest(`${this.auth.baseUrl}/api2/json${path}`, {
			method,
			headers,
			body: reqBody,
			verifySsl: this.auth.verifySsl,
		})
	}

	/**
	 * Request a VNC proxy session for a QEMU VM.
	 * Returns port, VNC ticket, and password needed for WebSocket connection.
	 */
	async vncProxy(node: string, vmid: number): Promise<VncProxyResult> {
		return this.request<VncProxyResult>('POST', `/nodes/${node}/qemu/${vmid}/vncproxy`, {
			websocket: '1',
			'generate-password': '1',
		})
	}

	/**
	 * Get the WebSocket URL for VNC connection.
	 * The vncticket must be URL-encoded.
	 */
	getVncWebSocketUrl(node: string, vmid: number, port: string, vncticket: string): string {
		const encodedTicket = encodeURIComponent(vncticket)
		return `wss://${this.auth.baseUrl.replace('https://', '')}/api2/json/nodes/${node}/qemu/${vmid}/vncwebsocket?port=${port}&vncticket=${encodedTicket}`
	}

	/**
	 * Request a terminal proxy session for a QEMU VM serial console.
	 * Returns port and ticket needed for WebSocket connection.
	 */
	async termProxy(node: string, vmid: number, serial?: string): Promise<TermProxyResult> {
		const body: Record<string, string> | undefined = serial !== undefined ? { serial } : undefined
		// Referer with xtermjs=1 tells PVE to use text-mode protocol instead of VNC binary
		const referer = `${this.auth.baseUrl}/?console=kvm&xtermjs=1&vmid=${vmid}&node=${node}`
		return this.request<TermProxyResult>('POST', `/nodes/${node}/qemu/${vmid}/termproxy`, body, {
			Referer: referer,
		})
	}

	/**
	 * Get the WebSocket URL for terminal connection.
	 * Uses the same vncwebsocket endpoint as VNC — PVE reuses it for terminal proxy.
	 */
	getTermWebSocketUrl(node: string, vmid: number, port: string, vncticket: string): string {
		const encodedTicket = encodeURIComponent(vncticket)
		return `wss://${this.auth.baseUrl.replace('https://', '')}/api2/json/nodes/${node}/qemu/${vmid}/vncwebsocket?port=${port}&vncticket=${encodedTicket}`
	}

	/**
	 * Get the auth cookie value for WebSocket connection headers.
	 */
	async getAuthCookie(): Promise<string> {
		const ticket = await this.auth.getTicket()
		return ticket.ticket
	}

	async getVmStatus(
		node: string,
		vmid: number,
	): Promise<{ status: string; name?: string; qmpstatus?: string }> {
		return this.request('GET', `/nodes/${node}/qemu/${vmid}/status/current`)
	}

	async getVmConfig(node: string, vmid: number): Promise<VmConfig> {
		const config = await this.request<RawVmConfig>('GET', `/nodes/${node}/qemu/${vmid}/config`)
		return normalizeVmConfig(config)
	}

	async updateVmConfig(
		node: string,
		vmid: number,
		body: Record<string, string> | URLSearchParams,
	): Promise<void> {
		await this.request<null>('PUT', `/nodes/${node}/qemu/${vmid}/config`, body)
	}

	async setVmConfigValue(node: string, vmid: number, key: string, value: string): Promise<void> {
		await this.updateVmConfig(node, vmid, { [key]: value })
	}

	async deleteVmConfigValue(node: string, vmid: number, key: string): Promise<void> {
		await this.updateVmConfig(node, vmid, { delete: key })
	}

	async setVmNotes(node: string, vmid: number, notes: string): Promise<void> {
		const normalized = notes.trim()
		if (normalized.length === 0) {
			await this.deleteVmConfigValue(node, vmid, 'description')
			return
		}

		await this.setVmConfigValue(node, vmid, 'description', notes)
	}

	async getVmDiskConfig(node: string, vmid: number): Promise<VmDiskEntry[]> {
		const config = await this.getVmConfig(node, vmid)
		return config.disks
	}

	async startVm(node: string, vmid: number): Promise<string> {
		const upid = await this.request<string>('POST', `/nodes/${node}/qemu/${vmid}/status/start`)
		await this.waitForTask(node, upid)
		return upid
	}

	async stopVm(node: string, vmid: number): Promise<string> {
		const upid = await this.request<string>('POST', `/nodes/${node}/qemu/${vmid}/status/stop`)
		await this.waitForTask(node, upid)
		return upid
	}

	async shutdownVm(node: string, vmid: number): Promise<string> {
		const upid = await this.request<string>('POST', `/nodes/${node}/qemu/${vmid}/status/shutdown`)
		await this.waitForTask(node, upid)
		return upid
	}

	/**
	 * Poll a PVE task until it completes. Throws with the task error if it failed.
	 */
	async waitForTask(node: string, upid: string, timeoutMs = 60_000): Promise<void> {
		const interval = 1000
		const maxAttempts = Math.ceil(timeoutMs / interval)

		for (let i = 0; i < maxAttempts; i++) {
			const task = await this.request<{ status: string; exitstatus?: string }>(
				'GET',
				`/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
			)

			if (task.status === 'stopped') {
				if (task.exitstatus && task.exitstatus !== 'OK') {
					throw new Error(`Task failed: ${task.exitstatus}`)
				}
				return
			}

			await new Promise((r) => setTimeout(r, interval))
		}

		throw new Error(`Task did not complete within ${timeoutMs / 1000}s (UPID: ${upid})`)
	}

	/**
	 * List all VMs across the cluster. Returns vmid, name, status, node, and tags.
	 */
	async listVms(): Promise<VmStatus[]> {
		const resources = await this.request<RawVmStatus[]>('GET', '/cluster/resources?type=vm')
		return resources.filter((r) => r.type === 'qemu').map((vm) => normalizeVmStatus(vm))
	}

	/**
	 * Find which node a VM is on. Useful when the caller only knows vmid.
	 */
	async findVmNode(vmid: number): Promise<string> {
		const vms = await this.listVms()
		const vm = vms.find((v) => v.vmid === vmid)
		if (!vm) throw new Error(`VM ${vmid} not found in cluster`)
		return vm.node
	}

	// --- Snapshots ---

	async listSnapshots(node: string, vmid: number): Promise<Snapshot[]> {
		return this.request('GET', `/nodes/${node}/qemu/${vmid}/snapshot`)
	}

	async createSnapshot(
		node: string,
		vmid: number,
		snapname: string,
		description?: string,
		vmstate?: boolean,
	): Promise<string> {
		const body: Record<string, string> = { snapname }
		if (description) body.description = description
		if (vmstate) body.vmstate = '1'
		const upid = await this.request<string>('POST', `/nodes/${node}/qemu/${vmid}/snapshot`, body)
		await this.waitForTask(node, upid)
		return upid
	}

	async deleteSnapshot(
		node: string,
		vmid: number,
		snapname: string,
		force?: boolean,
	): Promise<string> {
		const query = force ? '?force=1' : ''
		const upid = await this.request<string>(
			'DELETE',
			`/nodes/${node}/qemu/${vmid}/snapshot/${encodeURIComponent(snapname)}${query}`,
		)
		await this.waitForTask(node, upid)
		return upid
	}

	async rollbackSnapshot(node: string, vmid: number, snapname: string): Promise<string> {
		const upid = await this.request<string>(
			'POST',
			`/nodes/${node}/qemu/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`,
		)
		await this.waitForTask(node, upid)
		return upid
	}

	// --- Backups ---

	async createBackup(
		node: string,
		vmid: number,
		storage?: string,
		compress?: string,
		mode?: string,
		notes?: string,
	): Promise<string> {
		const body: Record<string, string> = { vmid: String(vmid) }
		if (storage) body.storage = storage
		if (compress) body.compress = compress
		if (mode) body.mode = mode
		if (notes) body['notes-template'] = notes
		const upid = await this.request<string>('POST', `/nodes/${node}/vzdump`, body)
		await this.waitForTask(node, upid, 300_000) // backups can take a while
		return upid
	}

	async listBackups(node: string, storage: string, vmid?: number): Promise<BackupVolume[]> {
		let query = '?content=backup'
		if (vmid !== undefined) query += `&vmid=${vmid}`
		return this.request(
			'GET',
			`/nodes/${node}/storage/${encodeURIComponent(storage)}/content${query}`,
		)
	}

	/**
	 * Execute a command inside the VM via QEMU guest agent.
	 * PVE 8+ expects command as a repeated form param: command[]=/bin/cmd&command[]=arg1&...
	 * Requires qemu-guest-agent running in the VM and VM.GuestAgent.Unrestricted privilege.
	 */
	async guestExec(
		node: string,
		vmid: number,
		command: string,
		args?: string[],
		timeoutMs = DEFAULT_GUEST_EXEC_TIMEOUT_MS,
	): Promise<GuestExecResult> {
		const params = new URLSearchParams()
		params.append('command', command)
		if (args) {
			for (const arg of args) {
				params.append('command', arg)
			}
		}

		const { pid } = await this.request<{ pid: number }>(
			'POST',
			`/nodes/${node}/qemu/${vmid}/agent/exec`,
			params,
		)

		// Poll for completion with exponential backoff. Fast commands (the
		// common case) finish within the first poll, so start at 50ms. Slower
		// commands back off up to GUEST_EXEC_POLL_MAX_MS to keep long-running
		// ops from hammering the API.
		const deadline = Date.now() + timeoutMs
		let delay = GUEST_EXEC_POLL_INITIAL_MS
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, delay))

			const raw = await this.request<GuestExecRaw>(
				'GET',
				`/nodes/${node}/qemu/${vmid}/agent/exec-status?pid=${pid}`,
			)

			if (raw.exited) {
				const outRaw = raw['out-data'] ?? ''
				const errRaw = raw['err-data'] ?? ''
				return {
					exitcode: raw.exitcode ?? -1,
					stdout: outRaw,
					stderr: errRaw,
				}
			}

			delay = Math.min(delay * 2, GUEST_EXEC_POLL_MAX_MS)
		}

		throw new Error(`Guest exec command did not complete within ${timeoutMs}ms`)
	}
}
