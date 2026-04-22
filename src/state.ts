import type { PveAuthManager } from './pve-auth.js'
import type { PveApiClient } from './pve-api.js'
import type { VncSessionManager } from './vnc-session.js'
import type { TerminalSessionManager } from './terminal-session.js'
import { isWindowsGuest, typeTextWindowsClipboard } from './windows-guest.js'
import { sleep } from './helpers.js'

// --- Services (initialized by main) ---

export let auth!: PveAuthManager
export let api!: PveApiClient
export let sessions!: VncSessionManager
export let termSessions!: TerminalSessionManager

export function initServices(services: {
	auth: PveAuthManager
	api: PveApiClient
	sessions: VncSessionManager
	termSessions: TerminalSessionManager
}): void {
	auth = services.auth
	api = services.api
	sessions = services.sessions
	termSessions = services.termSessions
}

// --- Session tracking ---

/** Track screen size at time of last screenshot per VM */
export const lastScreenSize = new Map<number, { width: number; height: number }>()

/** Track active vmid for single-session convenience (VNC) */
export let activeVmid: number | null = null

/** Track active vmid for single-session convenience (terminal) */
export let activeTermVmid: number | null = null

export function setActiveVmid(v: number | null): void {
	activeVmid = v
}

export function setActiveTermVmid(v: number | null): void {
	activeTermVmid = v
}

// --- Resolvers ---

export function resolveVmid(vmid?: number): number {
	if (vmid !== undefined) return vmid
	if (activeVmid !== null) return activeVmid
	throw new Error('No vmid provided and no active session. Call connect first.')
}

export function resolveTermVmid(vmid?: number): number {
	if (vmid !== undefined) return vmid
	if (activeTermVmid !== null) return activeTermVmid
	throw new Error('No vmid provided and no active terminal session. Call serial_connect first.')
}

export function resolveTimelineVmid(
	stepVmid: number | undefined,
	timelineVmid: number | undefined,
): number {
	if (stepVmid !== undefined) return stepVmid
	if (timelineVmid !== undefined) return timelineVmid
	if (activeVmid !== null) return activeVmid
	throw new Error(
		'No vmid provided for timeline step and no active VNC session. Provide timeline vmid, step vmid, or call connect first.',
	)
}

/**
 * Validate coordinates against the current framebuffer.
 * Returns warnings if resolution changed since last screenshot or coords are out of bounds.
 */
export function validateCoordinates(
	id: number,
	coords: { x: number; y: number }[],
	fb: { width: number; height: number },
): string[] {
	const warnings: string[] = []
	const last = lastScreenSize.get(id)

	if (last && (last.width !== fb.width || last.height !== fb.height)) {
		warnings.push(
			`WARNING: Screen resolution changed from ${last.width}x${last.height} to ${fb.width}x${fb.height} since last screenshot. Take a new screenshot before clicking.`,
		)
	}

	for (const { x, y } of coords) {
		if (x >= fb.width || y >= fb.height) {
			warnings.push(
				`WARNING: Coordinate (${x}, ${y}) is out of bounds for ${fb.width}x${fb.height} screen.`,
			)
		}
	}

	return warnings
}

// --- VNC session helpers ---

export async function getOrConnectVncSession(vmid: number, node?: string) {
	const existing = sessions.getSession(vmid)
	if (existing?.connected) return existing
	const session = await sessions.connect(vmid, node)
	setActiveVmid(vmid)
	return session
}

async function pasteClipboardViaVnc(
	session: ReturnType<VncSessionManager['getConnectedSession']>,
): Promise<void> {
	session.pressKey('ctrl+v')
	await sleep(120)
}

export type TextStrategy = 'auto' | 'clipboard' | 'vnc_keys'

export async function typeTextByStrategy(
	vmid: number,
	session: ReturnType<VncSessionManager['getConnectedSession']>,
	text: string,
	keyboardLayout: 'en-US' | 'es-ES',
	delayMs: number,
	strategy: TextStrategy,
): Promise<string> {
	const node = session.node
	const isWindows = await isWindowsGuest(api, node, vmid)
	const performVnc = async () => {
		await session.typeText(text, keyboardLayout, delayMs)
		return 'vnc_keys'
	}

	if (strategy === 'vnc_keys') return performVnc()
	if (strategy === 'clipboard') {
		if (!isWindows) return performVnc()
		await typeTextWindowsClipboard(api, node, vmid, text)
		await pasteClipboardViaVnc(session)
		return 'clipboard'
	}

	if (!isWindows) return performVnc()

	// auto: clipboard -> vnc keys
	try {
		await typeTextWindowsClipboard(api, node, vmid, text)
		await pasteClipboardViaVnc(session)
		return 'clipboard'
	} catch {
		return performVnc()
	}
}
