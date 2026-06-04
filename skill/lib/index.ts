/**
 * pve-vm skill - scriptable Proxmox VE KVM/guest-agent automation.
 *
 * Default export is a lazy singleton initialised from PVE_HOST / PVE_USER /
 * PVE_PASSWORD / PVE_PORT / PVE_VERIFY_SSL on first use.
 *
 *   import pve, { act } from '<absolute-path-to-repo>/skill/lib/index.ts'
 *   const vm = pve.use(100)
 *   await vm.start()
 *   await vm.kvm.press('ctrl+alt+t')
 */

import { writeFile } from 'node:fs/promises'

import { PveAuthManager, loadCredentials, type PveCredentialInput } from '../../src/pve-auth.js'
import { PveApiClient, type VmConfig } from '../../src/pve-api.js'
import {
	VncSessionManager,
	type VncSession,
	type EasingType,
	type KeyboardLayout,
} from '../../src/vnc-session.js'
import { TerminalSessionManager } from '../../src/terminal-session.js'
import { captureScreenshot } from '../../src/screenshot.js'
import {
	matchScreen,
	regionToJpeg,
	type Region,
	type ScreenMatchOptions,
	type ScreenMatchResult,
} from '../../src/screen-match.js'
import { isWindowsGuest, typeTextWindowsClipboard } from '../../src/windows-guest.js'
import { parseKeyCombo } from '../../src/rfb.js'
import { mouseButtonToBit, sleep } from '../../src/helpers.js'
import { destroyDispatchers } from '../../src/http.js'
import { ocrImage, shutdownOcr, type OcrItem } from '../../src/ocr.js'

export type { Region, OcrItem }

if (process.env.PVE_VERIFY_SSL !== 'true') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// ---------- Types ----------

export type MouseButton = 'left' | 'right' | 'middle'
export type TypeStrategy = 'auto' | 'clipboard' | 'vnc'
export type VmRunState = 'running' | 'stopped' | 'paused' | 'suspended'

export interface TypeOptions {
	/** Chars per second (overrides delayMs). */
	cps?: number
	/** Milliseconds between characters. Default 8. */
	delayMs?: number
	/** Default 'en-US'. */
	layout?: KeyboardLayout
	/** 'auto' tries clipboard on Windows then falls back to VNC keys. */
	strategy?: TypeStrategy
}

export interface MoveOptions {
	/** Animate from current position. Default: jump. */
	from?: 'current'
	durationMs?: number
	steps?: number
	easing?: EasingType
	signal?: AbortSignal
}

export interface DragOptions {
	from: [number, number]
	to: [number, number]
	durationMs?: number
	steps?: number
	easing?: EasingType
	holdStartMs?: number
	holdEndMs?: number
}

export interface ScrollOptions {
	direction: 'up' | 'down'
	amount?: number
}

export interface WaitForOptions {
	timeoutMs?: number
	intervalMs?: number
	signal?: AbortSignal
}

export interface ReadScreenOptions {
	/** Restrict OCR to this region (source-image pixels). Default: full screen. */
	region?: Region
	/** Integer nearest-neighbor upscale before OCR. Default 1. */
	scale?: number
	/** Force a fresh VNC update before reading. Default: true. */
	refresh?: boolean
	signal?: AbortSignal
}

export interface ReadScreenResult {
	/** Concatenated text from all detected blocks. */
	text: string
	/** Detected text blocks with quadrilateral boxes in source-image pixels. */
	items: OcrItem[]
	/** Inference time inside the OCR worker (ms). */
	ms: number
	/** Framebuffer dimensions at the time of capture. */
	width: number
	height: number
}

export interface ReadScreenIncrementalOptions {
	/** Drop dirty rects smaller than this area (w*h). Default 100. */
	minArea?: number
	/** Integer nearest-neighbor upscale applied per region before OCR. Default 1. */
	scale?: number
	signal?: AbortSignal
}

export interface ReadScreenIncrementalResult extends ReadScreenResult {
	/** Number of dirty regions OCRed in this call (0 when nothing changed). */
	regionsOcrd: number
	/** 1 when the call returned without OCR (nothing changed); 0 otherwise. */
	framesSkipped: number
}

// ---------- Action descriptors (data, runnable by run/timeline) ----------

export type Step =
	| { kind: 'wait'; ms: number }
	| { kind: 'press'; combo: string }
	| { kind: 'down'; combo: string }
	| { kind: 'up'; combo: string }
	| { kind: 'releaseAll' }
	| { kind: 'type'; text: string; opts?: TypeOptions }
	| { kind: 'move'; x: number; y: number; opts?: MoveOptions }
	| { kind: 'click'; x: number; y: number; button?: MouseButton; holdMs?: number }
	| { kind: 'doubleClick'; x: number; y: number; button?: MouseButton }
	| { kind: 'mouseDown'; button: MouseButton; x?: number; y?: number }
	| { kind: 'mouseUp'; button: MouseButton | 'all'; x?: number; y?: number }
	| { kind: 'drag'; opts: DragOptions }
	| { kind: 'scroll'; x: number; y: number; opts: ScrollOptions }
	| { kind: 'path'; points: [number, number][]; opts?: Omit<MoveOptions, 'from'> }
	| { kind: 'exec'; fn: (vm: Vm) => unknown | Promise<unknown> }

export const act = {
	wait: (ms: number): Step => ({ kind: 'wait', ms }),
	press: (combo: string): Step => ({ kind: 'press', combo }),
	down: (combo: string): Step => ({ kind: 'down', combo }),
	up: (combo: string): Step => ({ kind: 'up', combo }),
	releaseAll: (): Step => ({ kind: 'releaseAll' }),
	type: (text: string, opts?: TypeOptions): Step => ({ kind: 'type', text, opts }),
	move: (x: number, y: number, opts?: MoveOptions): Step => ({ kind: 'move', x, y, opts }),
	click: (x: number, y: number, button: MouseButton = 'left', holdMs?: number): Step => ({
		kind: 'click',
		x,
		y,
		button,
		holdMs,
	}),
	doubleClick: (x: number, y: number, button: MouseButton = 'left'): Step => ({
		kind: 'doubleClick',
		x,
		y,
		button,
	}),
	mouseDown: (button: MouseButton, x?: number, y?: number): Step => ({
		kind: 'mouseDown',
		button,
		x,
		y,
	}),
	mouseUp: (button: MouseButton | 'all' = 'all', x?: number, y?: number): Step => ({
		kind: 'mouseUp',
		button,
		x,
		y,
	}),
	drag: (opts: DragOptions): Step => ({ kind: 'drag', opts }),
	scroll: (x: number, y: number, opts: ScrollOptions): Step => ({ kind: 'scroll', x, y, opts }),
	path: (points: [number, number][], opts?: Omit<MoveOptions, 'from'>): Step => ({
		kind: 'path',
		points,
		opts,
	}),
	exec: (fn: (vm: Vm) => unknown | Promise<unknown>): Step => ({ kind: 'exec', fn }),
}

export interface TimelineStep {
	/** Absolute offset from timeline start (ms). Steps without `at` run after the previous. */
	at?: number
	do: Step
}

export interface RunOptions {
	releaseOnExit?: boolean
	signal?: AbortSignal
}

export interface RepeatOptions {
	times?: number
	durationMs?: number
	/** Inverse of intervalMs; one of the two is required. */
	ratePerSec?: number
	intervalMs?: number
	jitterMs?: number
	signal?: AbortSignal
}

// ---------- Singleton runtime ----------

class Runtime {
	auth?: PveAuthManager
	api?: PveApiClient
	sessions?: VncSessionManager
	terms?: TerminalSessionManager
	private initPromise?: Promise<void>
	private credentials?: PveCredentialInput
	private cleanupInstalled = false
	private disposed = false

	configure(credentials: PveCredentialInput): void {
		if (this.api) throw new Error('PVE runtime is already connected')
		this.credentials = credentials
	}

	async ensure(): Promise<void> {
		if (this.api) return
		if (!this.initPromise) this.initPromise = this.init()
		await this.initPromise
	}

	private async init(): Promise<void> {
		const auth = new PveAuthManager(loadCredentials(this.credentials))
		await auth.authenticate()
		const api = new PveApiClient(auth)
		this.auth = auth
		this.api = api
		this.sessions = new VncSessionManager(api)
		this.terms = new TerminalSessionManager(api)
		this.installCleanup()
	}

	private installCleanup(): void {
		if (this.cleanupInstalled) return
		this.cleanupInstalled = true
		const cleanup = () => {
			if (this.disposed) return
			this.disposed = true
			this.sessions?.disconnectAll()
			this.terms?.disconnectAll()
			this.auth?.destroy()
			destroyDispatchers()
			void shutdownOcr().catch(() => {})
		}
		process.once('exit', cleanup)
		process.once('SIGINT', () => {
			cleanup()
			process.exit(130)
		})
		process.once('SIGTERM', () => {
			cleanup()
			process.exit(143)
		})
	}

	async disconnect(): Promise<void> {
		this.disposed = true
		this.sessions?.disconnectAll()
		this.terms?.disconnectAll()
		this.auth?.destroy()
		destroyDispatchers()
		await shutdownOcr().catch(() => {})
	}
}

const rt = new Runtime()

// ---------- Per-VM held state for safe cleanup ----------

interface HeldState {
	keys: Set<number>
	mask: number
	pointer: { x: number; y: number }
}

const held: Map<number, HeldState> = new Map()

function getHeld(vmid: number): HeldState {
	let s = held.get(vmid)
	if (!s) {
		s = { keys: new Set(), mask: 0, pointer: { x: 0, y: 0 } }
		held.set(vmid, s)
	}
	return s
}

async function getSession(vmid: number, node?: string): Promise<VncSession> {
	await rt.ensure()
	const mgr = rt.sessions!
	const existing = mgr.getSession(vmid)
	if (existing?.connected) return existing
	return mgr.connect(vmid, node)
}

// ---------- Vm handle ----------

export class Vm {
	readonly id: number
	private lastIncrementalSeq?: number

	constructor(id: number) {
		this.id = id
	}

	// Lifecycle
	async status(): Promise<{ status: string; name?: string; qmpstatus?: string }> {
		await rt.ensure()
		const node = await rt.api!.findVmNode(this.id)
		return rt.api!.getVmStatus(node, this.id)
	}

	async config(): Promise<VmConfig> {
		await rt.ensure()
		const node = await rt.api!.findVmNode(this.id)
		return rt.api!.getVmConfig(node, this.id)
	}

	async notes(): Promise<string> {
		return (await this.config()).description ?? ''
	}

	async setNotes(notes: string): Promise<void> {
		await rt.ensure()
		const node = await rt.api!.findVmNode(this.id)
		await rt.api!.setVmNotes(node, this.id, notes)
	}

	async start(): Promise<void> {
		await rt.ensure()
		const node = await rt.api!.findVmNode(this.id)
		await rt.api!.startVm(node, this.id)
	}

	async shutdown(): Promise<void> {
		await rt.ensure()
		const node = await rt.api!.findVmNode(this.id)
		await rt.api!.shutdownVm(node, this.id)
	}

	async stop(): Promise<void> {
		await rt.ensure()
		const node = await rt.api!.findVmNode(this.id)
		await rt.api!.stopVm(node, this.id)
	}

	async reset(): Promise<void> {
		await this.stop()
		await this.start()
	}

	async waitForScreen(opts: ScreenMatchOptions & WaitForOptions): Promise<ScreenMatchResult> {
		const timeoutMs = opts.timeoutMs ?? 30_000
		const intervalMs = opts.intervalMs ?? 1_000
		const deadline = Date.now() + timeoutMs
		const session = await getSession(this.id)
		let last: ScreenMatchResult = { matched: false }
		let lastMatchedSeq = 0
		for (;;) {
			opts.signal?.throwIfAborted()
			if (session.screen) {
				const snap = session.screen.snapshot()
				// Match only paint-bearing frames we haven't already evaluated.
				if (snap.seq > 0 && snap.seq !== lastMatchedSeq) {
					lastMatchedSeq = snap.seq
					last = await matchScreen(snap, opts, opts.signal)
					if (last.matched) return last
				}
			}
			if (Date.now() >= deadline) {
				const items = last.items?.length ?? 0
				const sample = last.text
					? ` text: ${JSON.stringify(last.text.replace(/\s+/g, ' ').slice(0, 160))}`
					: ''
				throw new Error(`waitForScreen timed out after ${timeoutMs}ms (${items} items).${sample}`)
			}
			// Force a non-incremental refresh, then wait either for the next
			// paint or the poll interval. ContinuousUpdates handles changing
			// screens; this kick is the safety net for genuinely quiet servers
			// (early boot, DPMS off) where nothing would arrive otherwise.
			const baseline = session.updateSeq
			session.requestFullUpdate()
			const remaining = deadline - Date.now()
			const cap = Math.min(intervalMs, remaining)
			if (cap > 0) {
				await session.waitForUpdate(cap, baseline).catch(() => sleep(cap))
			}
		}
	}

	/**
	 * OCR the current screen (or a region) once and return detected text blocks
	 * with their bounding boxes. Use this when an agent needs to locate text
	 * to click, rather than polling for a known string with `waitForScreen`.
	 *
	 * Each item's `box` is a quadrilateral [[x,y],[x,y],[x,y],[x,y]] in
	 * source-image pixels - compute its centroid to feed `kvm.click(x, y)`.
	 */
	async readScreen(opts: ReadScreenOptions = {}): Promise<ReadScreenResult> {
		const session = await getSession(this.id)
		if (opts.refresh !== false) {
			const since = session.requestFullUpdate()
			const timeout = since === 0 ? 15_000 : 3_000
			await session.waitForUpdate(timeout, since).catch(() => {})
		}
		opts.signal?.throwIfAborted()
		if (!session.screen) throw new Error('framebuffer not ready')
		const snap = session.screen.snapshot()
		const scale = opts.scale ?? 1
		const region: Region = opts.region ?? { x: 0, y: 0, w: snap.width, h: snap.height }
		const jpeg = regionToJpeg(snap, region, 85, scale)
		const ocr = await ocrImage(jpeg, opts.signal)
		return {
			text: ocr.text,
			items: translateOcrItems(ocr.items, region, scale),
			ms: ocr.ms,
			width: snap.width,
			height: snap.height,
		}
	}

	/**
	 * OCR only the regions of the framebuffer painted since the previous call.
	 *
	 * First call after the session opens reads the whole screen so the caller
	 * sees everything already on screen. Subsequent calls consume the dirty-
	 * rect accumulator and OCR each region concurrently through the OCR pool.
	 * When nothing has changed, returns immediately with `framesSkipped: 1`.
	 */
	async readScreenIncremental(
		opts: ReadScreenIncrementalOptions = {},
	): Promise<ReadScreenIncrementalResult> {
		const session = await getSession(this.id)
		opts.signal?.throwIfAborted()
		if (!session.screen) throw new Error('framebuffer not ready')

		const scale = opts.scale ?? 1
		const minArea = opts.minArea ?? 100

		const fb = session.screen
		const rects = session.consumeDirtyRects()

		// First call after session open: nothing to compare against. OCR the
		// whole screen so the caller's dedup state is seeded with everything
		// currently visible.
		if (this.lastIncrementalSeq === undefined) {
			const snap = fb.snapshot()
			this.lastIncrementalSeq = snap.seq
			const region: Region = { x: 0, y: 0, w: snap.width, h: snap.height }
			const jpeg = regionToJpeg(snap, region, 85, scale)
			const ocr = await ocrImage(jpeg, opts.signal)
			return {
				text: ocr.text,
				items: translateOcrItems(ocr.items, region, scale),
				ms: ocr.ms,
				width: snap.width,
				height: snap.height,
				regionsOcrd: 1,
				framesSkipped: 0,
			}
		}

		if (rects.length === 0 && fb.updateSeq === this.lastIncrementalSeq) {
			return {
				text: '',
				items: [],
				ms: 0,
				width: fb.width,
				height: fb.height,
				regionsOcrd: 0,
				framesSkipped: 1,
			}
		}

		const snap = fb.snapshot()
		this.lastIncrementalSeq = snap.seq

		const filtered = rects.filter((r) => r.w * r.h >= minArea)
		if (filtered.length === 0) {
			return {
				text: '',
				items: [],
				ms: 0,
				width: snap.width,
				height: snap.height,
				regionsOcrd: 0,
				framesSkipped: 1,
			}
		}

		// Coalesce dirty rects into a single OCR region to bound per-frame work.
		const region = expandOcrRegion(
			unionRects(filtered, snap.width, snap.height),
			snap.width,
			snap.height,
		)
		const jpeg = regionToJpeg(snap, region, 85, scale)
		const ocr = await ocrImage(jpeg, opts.signal)
		return {
			text: ocr.text,
			items: translateOcrItems(ocr.items, region, scale),
			ms: ocr.ms,
			width: snap.width,
			height: snap.height,
			regionsOcrd: filtered.length,
			framesSkipped: 0,
		}
	}

	async waitFor(state: VmRunState, opts: WaitForOptions = {}): Promise<void> {
		const timeoutMs = opts.timeoutMs ?? 60_000
		const intervalMs = opts.intervalMs ?? 1_000
		const deadline = Date.now() + timeoutMs
		for (;;) {
			opts.signal?.throwIfAborted()
			const cur = await this.status()
			if (cur.status === state) return
			if (Date.now() >= deadline) {
				throw new Error(
					`VM ${this.id} did not reach state '${state}' within ${timeoutMs}ms (last: ${cur.status})`,
				)
			}
			await sleep(intervalMs)
		}
	}

	// Guest agent
	guest = {
		exec: async (
			command: string,
			args?: string[],
			opts: { timeoutMs?: number } = {},
		): Promise<{ exitcode: number; stdout: string; stderr: string }> => {
			await rt.ensure()
			const node = await rt.api!.findVmNode(this.id)
			return rt.api!.guestExec(node, this.id, command, args, opts.timeoutMs)
		},
	}

	// Snapshots
	snapshot = {
		list: async () => {
			await rt.ensure()
			const node = await rt.api!.findVmNode(this.id)
			return rt.api!.listSnapshots(node, this.id)
		},
		create: async (name: string, description?: string): Promise<void> => {
			await rt.ensure()
			const node = await rt.api!.findVmNode(this.id)
			await rt.api!.createSnapshot(node, this.id, name, description)
		},
		delete: async (name: string): Promise<void> => {
			await rt.ensure()
			const node = await rt.api!.findVmNode(this.id)
			await rt.api!.deleteSnapshot(node, this.id, name)
		},
		rollback: async (name: string): Promise<void> => {
			await rt.ensure()
			const node = await rt.api!.findVmNode(this.id)
			await rt.api!.rollbackSnapshot(node, this.id, name)
		},
	}

	// Screenshot - saves to disk if path given, otherwise returns Buffer
	async screenshot(): Promise<Buffer>
	async screenshot(path: string, quality?: number): Promise<void>
	async screenshot(path?: string, quality = 85): Promise<Buffer | void> {
		const session = await getSession(this.id)
		const since = session.requestFullUpdate()
		// `since` is 0 before the first paint ever; in that case wait longer
		// (Windows during BIOS/early boot can take >10s).
		const timeout = since === 0 ? 15_000 : 3_000
		await session.waitForUpdate(timeout, since).catch(() => {})
		if (!session.screen) throw new Error('framebuffer not ready')
		const shot = await captureScreenshot(session.screen, quality)
		const buf = Buffer.from(shot.data, 'base64')
		if (path) {
			await writeFile(path, buf)
			return
		}
		return buf
	}

	// KVM - immediate
	kvm = {
		press: async (combo: string): Promise<void> => {
			const session = await getSession(this.id)
			session.pressKey(combo)
		},
		down: async (combo: string): Promise<void> => {
			const session = await getSession(this.id)
			const keysyms = parseKeyCombo(combo)
			const state = getHeld(this.id)
			for (const k of keysyms) {
				session.sendKeyEvent(true, k)
				state.keys.add(k)
			}
		},
		up: async (combo: string): Promise<void> => {
			const session = await getSession(this.id)
			const keysyms = parseKeyCombo(combo)
			const state = getHeld(this.id)
			for (let i = keysyms.length - 1; i >= 0; i--) {
				session.sendKeyEvent(false, keysyms[i])
				state.keys.delete(keysyms[i])
			}
		},
		releaseAll: async (): Promise<void> => {
			const session = await getSession(this.id)
			const state = getHeld(this.id)
			const keys = Array.from(state.keys)
			for (let i = keys.length - 1; i >= 0; i--) session.sendKeyEvent(false, keys[i])
			state.keys.clear()
			if (state.mask !== 0) {
				session.sendPointerEvent(0, state.pointer.x, state.pointer.y)
				state.mask = 0
			}
		},
		type: async (text: string, opts: TypeOptions = {}): Promise<void> => {
			const session = await getSession(this.id)
			const delayMs = opts.cps ? Math.round(1000 / opts.cps) : (opts.delayMs ?? 8)
			const layout = opts.layout ?? 'en-US'
			const strategy = opts.strategy ?? 'auto'
			await typeWithStrategy(this.id, session, text, layout, delayMs, strategy)
		},
		move: async (x: number, y: number, opts: MoveOptions = {}): Promise<void> => {
			const session = await getSession(this.id)
			const state = getHeld(this.id)
			if (opts.from === 'current') {
				await animateMove(session, state, x, y, opts)
			} else {
				session.sendPointerEvent(state.mask, x, y)
				state.pointer = { x, y }
			}
		},
		click: async (
			x: number,
			y: number,
			button: MouseButton = 'left',
			holdMs = 0,
		): Promise<void> => {
			const session = await getSession(this.id)
			const state = getHeld(this.id)
			const bit = mouseButtonToBit(button)
			session.sendPointerEvent(state.mask, x, y)
			session.sendPointerEvent(state.mask | bit, x, y)
			if (holdMs > 0) await sleep(holdMs)
			session.sendPointerEvent(state.mask, x, y)
			state.pointer = { x, y }
		},
		doubleClick: async (x: number, y: number, button: MouseButton = 'left'): Promise<void> => {
			await this.kvm.click(x, y, button)
			await sleep(40)
			await this.kvm.click(x, y, button)
		},
		mouseDown: async (button: MouseButton, x?: number, y?: number): Promise<void> => {
			const session = await getSession(this.id)
			const state = getHeld(this.id)
			const px = x ?? state.pointer.x
			const py = y ?? state.pointer.y
			const newMask = state.mask | mouseButtonToBit(button)
			session.sendPointerEvent(newMask, px, py)
			state.mask = newMask
			state.pointer = { x: px, y: py }
		},
		mouseUp: async (button: MouseButton | 'all' = 'all', x?: number, y?: number): Promise<void> => {
			const session = await getSession(this.id)
			const state = getHeld(this.id)
			const px = x ?? state.pointer.x
			const py = y ?? state.pointer.y
			const newMask = button === 'all' ? 0 : state.mask & ~mouseButtonToBit(button)
			session.sendPointerEvent(newMask, px, py)
			state.mask = newMask
			state.pointer = { x: px, y: py }
		},
		drag: async (opts: DragOptions): Promise<void> => {
			const session = await getSession(this.id)
			const state = getHeld(this.id)
			await session.drag(
				opts.from[0],
				opts.from[1],
				opts.to[0],
				opts.to[1],
				opts.steps ?? 20,
				opts.durationMs ?? 500,
				opts.easing ?? 'ease-in-out',
				opts.holdStartMs ?? 50,
				opts.holdEndMs ?? 50,
			)
			state.pointer = { x: opts.to[0], y: opts.to[1] }
			state.mask = 0
		},
		scroll: async (x: number, y: number, opts: ScrollOptions): Promise<void> => {
			const session = await getSession(this.id)
			session.scroll(x, y, opts.direction, opts.amount ?? 3)
			const state = getHeld(this.id)
			state.pointer = { x, y }
		},
		path: async (
			points: [number, number][],
			opts: Omit<MoveOptions, 'from'> = {},
		): Promise<void> => {
			if (points.length === 0) return
			const session = await getSession(this.id)
			const state = getHeld(this.id)
			for (const [x, y] of points) {
				await animateMove(session, state, x, y, opts)
			}
		},
	}

	// --- Composition ---

	async do(step: Step, signal?: AbortSignal): Promise<void> {
		await runStep(this, step, signal)
	}

	async run(steps: Step[], opts: RunOptions = {}): Promise<void> {
		const release = opts.releaseOnExit ?? true
		try {
			for (const step of steps) {
				opts.signal?.throwIfAborted()
				await runStep(this, step, opts.signal)
			}
		} finally {
			if (release) await this.kvm.releaseAll().catch(() => {})
		}
	}

	async timeline(steps: TimelineStep[], opts: RunOptions = {}): Promise<void> {
		const release = opts.releaseOnExit ?? true
		const ordered = steps.slice().sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
		const start = Date.now()
		try {
			for (const step of ordered) {
				opts.signal?.throwIfAborted()
				if (step.at !== undefined) {
					const delay = step.at - (Date.now() - start)
					if (delay > 0) await sleep(delay)
				}
				await runStep(this, step.do, opts.signal)
			}
		} finally {
			if (release) await this.kvm.releaseAll().catch(() => {})
		}
	}

	async repeat(step: Step, opts: RepeatOptions): Promise<void> {
		const interval = opts.intervalMs ?? (opts.ratePerSec ? 1000 / opts.ratePerSec : undefined)
		if (interval === undefined) throw new Error('repeat requires intervalMs or ratePerSec')
		const start = Date.now()
		const deadline = opts.durationMs ? start + opts.durationMs : Infinity
		const maxCount = opts.times ?? Infinity
		let count = 0
		while (count < maxCount && Date.now() < deadline) {
			opts.signal?.throwIfAborted()
			await runStep(this, step, opts.signal)
			count++
			const jitter = opts.jitterMs ? Math.random() * opts.jitterMs : 0
			const sleepMs = interval + jitter
			const remaining = deadline - Date.now()
			if (count >= maxCount) break
			await sleep(Math.min(sleepMs, Math.max(0, remaining)))
		}
	}

	async waitForScreenChange(timeoutMs = 3_000): Promise<void> {
		const session = await getSession(this.id)
		await session.waitForUpdate(timeoutMs)
	}

	async disconnectVnc(): Promise<void> {
		await rt.ensure()
		rt.sessions!.disconnect(this.id)
		held.delete(this.id)
	}
}

// ---------- Step runner ----------

async function runStep(vm: Vm, step: Step, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted()
	switch (step.kind) {
		case 'wait':
			await sleep(step.ms)
			return
		case 'press':
			await vm.kvm.press(step.combo)
			return
		case 'down':
			await vm.kvm.down(step.combo)
			return
		case 'up':
			await vm.kvm.up(step.combo)
			return
		case 'releaseAll':
			await vm.kvm.releaseAll()
			return
		case 'type':
			await vm.kvm.type(step.text, step.opts)
			return
		case 'move':
			await vm.kvm.move(step.x, step.y, step.opts)
			return
		case 'click':
			await vm.kvm.click(step.x, step.y, step.button, step.holdMs)
			return
		case 'doubleClick':
			await vm.kvm.doubleClick(step.x, step.y, step.button)
			return
		case 'mouseDown':
			await vm.kvm.mouseDown(step.button, step.x, step.y)
			return
		case 'mouseUp':
			await vm.kvm.mouseUp(step.button, step.x, step.y)
			return
		case 'drag':
			await vm.kvm.drag(step.opts)
			return
		case 'scroll':
			await vm.kvm.scroll(step.x, step.y, step.opts)
			return
		case 'path':
			await vm.kvm.path(step.points, step.opts)
			return
		case 'exec':
			await step.fn(vm)
			return
	}
}

function unionRects(rects: Region[], maxW: number, maxH: number): Region {
	let x1 = rects[0].x
	let y1 = rects[0].y
	let x2 = rects[0].x + rects[0].w
	let y2 = rects[0].y + rects[0].h
	for (let i = 1; i < rects.length; i++) {
		const r = rects[i]
		if (r.x < x1) x1 = r.x
		if (r.y < y1) y1 = r.y
		if (r.x + r.w > x2) x2 = r.x + r.w
		if (r.y + r.h > y2) y2 = r.y + r.h
	}
	if (x1 < 0) x1 = 0
	if (y1 < 0) y1 = 0
	if (x2 > maxW) x2 = maxW
	if (y2 > maxH) y2 = maxH
	return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) }
}

function expandOcrRegion(r: Region, maxW: number, maxH: number): Region {
	if (r.h > maxH / 2) return r
	const y1 = Math.max(0, r.y - 24)
	const y2 = Math.min(maxH, r.y + r.h + 24)
	return { x: 0, y: y1, w: maxW, h: y2 - y1 }
}

function translateOcrItems(items: OcrItem[], region: Region, scale: number): OcrItem[] {
	if (scale === 1 && region.x === 0 && region.y === 0) return items
	return items.map((it) => ({
		...it,
		box: it.box.map(([x, y]) => [region.x + x / scale, region.y + y / scale]) as [number, number][],
	}))
}

// ---------- Mouse animation ----------

const EASINGS: Record<EasingType, (t: number) => number> = {
	linear: (t) => t,
	'ease-in': (t) => t * t,
	'ease-out': (t) => t * (2 - t),
	'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
}

async function animateMove(
	session: VncSession,
	state: HeldState,
	x: number,
	y: number,
	opts: Omit<MoveOptions, 'from'> = {},
): Promise<void> {
	const steps = opts.steps ?? 20
	const durationMs = opts.durationMs ?? 250
	const ease = EASINGS[opts.easing ?? 'ease-in-out']
	const fromX = state.pointer.x
	const fromY = state.pointer.y
	const stepDelay = durationMs / steps
	for (let i = 1; i <= steps; i++) {
		opts.signal?.throwIfAborted()
		const t = ease(i / steps)
		const ix = Math.round(fromX + (x - fromX) * t)
		const iy = Math.round(fromY + (y - fromY) * t)
		session.sendPointerEvent(state.mask, ix, iy)
		if (stepDelay > 0) await sleep(stepDelay)
	}
	state.pointer = { x, y }
}

// ---------- Type strategy ----------

async function typeWithStrategy(
	vmid: number,
	session: VncSession,
	text: string,
	layout: KeyboardLayout,
	delayMs: number,
	strategy: TypeStrategy,
): Promise<void> {
	if (strategy === 'vnc') {
		await session.typeText(text, layout, delayMs)
		return
	}
	const node = session.node
	const windows = await isWindowsGuest(rt.api!, node, vmid)
	if (strategy === 'clipboard' || (strategy === 'auto' && windows)) {
		if (!windows) {
			await session.typeText(text, layout, delayMs)
			return
		}
		try {
			await typeTextWindowsClipboard(rt.api!, node, vmid, text)
			session.pressKey('ctrl+v')
			await sleep(120)
			return
		} catch {
			await session.typeText(text, layout, delayMs)
			return
		}
	}
	await session.typeText(text, layout, delayMs)
}

// ---------- Parallel composition ----------

export async function all<T>(tasks: Iterable<Promise<T>>): Promise<T[]> {
	return Promise.all(tasks)
}

export type RaceTask<T> = Promise<T> | ((signal: AbortSignal) => Promise<T>)

export async function race<T>(
	tasks: Iterable<RaceTask<T>>,
	controller?: AbortController,
): Promise<T> {
	const ctrl = controller ?? new AbortController()
	const promises = Array.from(tasks, (t) => (typeof t === 'function' ? t(ctrl.signal) : t))
	try {
		return await Promise.race(promises)
	} finally {
		ctrl.abort()
	}
}

// ---------- Default export: the singleton facade ----------

const pve = {
	/** Return a bound handle. Does not connect; first KVM call connects on demand. */
	use(vmid: number): Vm {
		return new Vm(vmid)
	},
	configure(credentials: PveCredentialInput): void {
		rt.configure(credentials)
	},
	/** List all VMs across the cluster. */
	async list() {
		await rt.ensure()
		return rt.api!.listVms()
	},
	/** Sleep - convenient for ad-hoc scripts. */
	wait: sleep,
	/** Parallel: resolve when all resolve, reject on first error. */
	all,
	/**
	 * Parallel: resolve when first resolves; aborts the supplied controller
	 * so cooperating tasks can stop themselves.
	 */
	race,
	/** Explicit init (rarely needed - first call auto-initialises). */
	async connect() {
		await rt.ensure()
	},
	/** Tear down all sessions and HTTP pools. */
	async disconnect() {
		await rt.disconnect()
	},
	get api() {
		return rt.api
	},
}

export default pve

export * as windows from './windows.js'
export * as linux from './linux.js'
export * as darwin from './darwin.js'
