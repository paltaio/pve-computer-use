/**
 * VNC Session Manager
 *
 * Manages persistent WebSocket VNC connections to PVE virtual machines.
 * Handles the full lifecycle:
 * 1. vncproxy API call to get port + ticket
 * 2. WebSocket connection (within 10s window)
 * 3. RFB 3.8 handshake (security type 1 = None via PVE proxy)
 * 4. Continuous framebuffer updates
 * 5. Reconnection on drop
 */

import WebSocket from 'ws'
import { EventEmitter } from 'events'
import type { PveApiClient } from './pve-api.js'
import { vncDesEncrypt } from './des.js'
import { Framebuffer } from './framebuffer.js'
import {
	RFB_ENCODING_RAW,
	RFB_ENCODING_COPYRECT,
	RFB_ENCODING_CURSOR,
	RFB_ENCODING_DESKTOP_SIZE,
	RFB_ENCODING_EXTENDED_KEY,
	RFB_ENCODING_LAST_RECT,
	RFB_ENCODING_CONTINUOUS_UPDATES,
	MSG_FB_UPDATE,
	MSG_SET_COLOUR_MAP,
	MSG_BELL,
	MSG_SERVER_CUT_TEXT,
	MSG_END_OF_CONTINUOUS_UPDATES,
	buildSetPixelFormat,
	buildSetEncodings,
	buildFbUpdateRequest,
	buildEnableContinuousUpdates,
	buildKeyEvent,
	buildPointerEvent,
	buildExtendedKeyEvent,
	charToKeysym,
	parseKeyCombo,
} from './rfb.js'

/** Promise-based delay for animated operations. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Supported easing curves for drag animation. */
export type EasingType = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
export type KeyboardLayout = 'en-US' | 'es-ES'

const EASING_FUNCTIONS: Record<EasingType, (t: number) => number> = {
	linear: (t) => t,
	'ease-in': (t) => t * t * t,
	'ease-out': (t) => 1 - (1 - t) ** 3,
	'ease-in-out': (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
}

/** XT Set 1 scancodes for US keyboard layout (subset used by typeText). */
const XT_SCANCODES: Record<string, number> = {
	'1': 0x02,
	'2': 0x03,
	'3': 0x04,
	'4': 0x05,
	'5': 0x06,
	'6': 0x07,
	'7': 0x08,
	'8': 0x09,
	'9': 0x0a,
	'0': 0x0b,
	'-': 0x0c,
	'=': 0x0d,
	tab: 0x0f,
	q: 0x10,
	w: 0x11,
	e: 0x12,
	r: 0x13,
	t: 0x14,
	y: 0x15,
	u: 0x16,
	i: 0x17,
	o: 0x18,
	p: 0x19,
	'[': 0x1a,
	']': 0x1b,
	enter: 0x1c,
	a: 0x1e,
	s: 0x1f,
	d: 0x20,
	f: 0x21,
	g: 0x22,
	h: 0x23,
	j: 0x24,
	k: 0x25,
	l: 0x26,
	';': 0x27,
	"'": 0x28,
	'`': 0x29,
	shift: 0x2a, // left shift
	'\\': 0x2b,
	z: 0x2c,
	x: 0x2d,
	c: 0x2e,
	v: 0x2f,
	b: 0x30,
	n: 0x31,
	m: 0x32,
	',': 0x33,
	'.': 0x34,
	'/': 0x35,
	space: 0x39,
}

const SHIFTED_BASE_KEYS: Record<string, string> = {
	'~': '`',
	'!': '1',
	'@': '2',
	'#': '3',
	$: '4',
	'%': '5',
	'^': '6',
	'&': '7',
	'*': '8',
	'(': '9',
	')': '0',
	_: '-',
	'+': '=',
	'{': '[',
	'}': ']',
	'|': '\\',
	':': ';',
	'"': "'",
	'<': ',',
	'>': '.',
	'?': '/',
}

function getUsKeyForChar(
	char: string,
): { key: string; shift: boolean; keysymToken: string } | null {
	if (char === ' ') return { key: 'space', shift: false, keysymToken: 'space' }
	if (char === '\n') return { key: 'enter', shift: false, keysymToken: 'enter' }
	if (char === '\t') return { key: 'tab', shift: false, keysymToken: 'tab' }

	if (SHIFTED_BASE_KEYS[char]) {
		return { key: SHIFTED_BASE_KEYS[char], shift: true, keysymToken: char }
	}

	if (char.length === 1 && char >= 'A' && char <= 'Z') {
		return { key: char.toLowerCase(), shift: true, keysymToken: char }
	}

	if (char.length === 1 && XT_SCANCODES[char] !== undefined) {
		return { key: char, shift: false, keysymToken: char }
	}

	return null
}

export interface VncSessionOptions {
	node: string
	vmid: number
}

type HandshakeState =
	| 'awaiting_version'
	| 'awaiting_security_types'
	| 'awaiting_vnc_challenge'
	| 'awaiting_security_result'
	| 'awaiting_server_init'
	| 'connected'

export class VncSession extends EventEmitter {
	readonly node: string
	readonly vmid: number

	private api: PveApiClient
	private ws: WebSocket | null = null
	private framebuffer: Framebuffer | null = null
	private recvBuffer = Buffer.alloc(0)
	private state: HandshakeState = 'awaiting_version'
	private _connected = false
	private supportsExtendedKey = false
	private continuousUpdatesEnabled = false
	private vncPassword: string = ''

	constructor(api: PveApiClient, options: VncSessionOptions) {
		super()
		this.api = api
		this.node = options.node
		this.vmid = options.vmid
		// Prevent emit("error") from throwing when no external listener is registered.
		// Without this, any error in handleServerMessage/handleFramebufferUpdate
		// causes an unhandled throw that gets silently swallowed by the connect() catch.
		this.on('error', (err: Error) => {
			console.error(`[VNC ${this.vmid}] ${err.message}`)
		})
	}

	get connected(): boolean {
		return this._connected
	}

	get screen(): Framebuffer | null {
		return this.framebuffer
	}

	async connect(): Promise<{ width: number; height: number }> {
		// Step 1: Get VNC proxy ticket
		const proxy = await this.api.vncProxy(this.node, this.vmid)
		this.vncPassword = proxy.password

		// Step 2: Build WebSocket URL and connect (must happen within 10s)
		const wsUrl = this.api.getVncWebSocketUrl(this.node, this.vmid, proxy.port, proxy.ticket)
		const cookie = await this.api.getAuthCookie()

		return new Promise<{ width: number; height: number }>((resolve, reject) => {
			let settled = false

			const fail = (err: Error) => {
				if (!settled) {
					settled = true
					clearTimeout(timeout)
					reject(err)
				}
			}

			const succeed = (width: number, height: number) => {
				if (!settled) {
					settled = true
					clearTimeout(timeout)
					resolve({ width, height })
				}
			}

			const timeout = setTimeout(() => {
				fail(new Error('VNC WebSocket connection timed out (10s)'))
				this.ws?.close()
			}, 10000)

			this.ws = new WebSocket(wsUrl, ['binary'], {
				headers: { Cookie: `PVEAuthCookie=${cookie}` },
				rejectUnauthorized: false,
			})

			this.ws.binaryType = 'arraybuffer'

			this.ws.on('open', () => {
				this.recvBuffer = Buffer.alloc(0)
				this.state = 'awaiting_version'
			})

			this.ws.on('message', (data: ArrayBuffer | Buffer) => {
				try {
					const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
					this.recvBuffer = Buffer.concat([this.recvBuffer, chunk])
					this.processReceiveBuffer()
				} catch (err) {
					const error = err instanceof Error ? err : new Error(String(err))
					if (!settled) {
						fail(error)
					} else {
						console.error(`[VNC ${this.vmid}] post-handshake error:`, error.message)
					}
				}
			})

			this.once('_init_done', (width: number, height: number) => {
				succeed(width, height)
			})

			this.ws.on('error', (err) => {
				fail(err)
				this.emit('error', err)
			})

			this.ws.on('close', () => {
				const wasConnected = this._connected
				this._connected = false
				if (!wasConnected) {
					fail(new Error('WebSocket closed before handshake completed'))
				}
				this.emit('close')
			})
		})
	}

	private send(data: Buffer): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(data)
		}
	}

	private processReceiveBuffer(): void {
		// Keep processing as long as we have enough data
		let progress = true
		while (progress) {
			progress = false
			switch (this.state) {
				case 'awaiting_version':
					progress = this.handleVersion()
					break
				case 'awaiting_security_types':
					progress = this.handleSecurityTypes()
					break
				case 'awaiting_vnc_challenge':
					progress = this.handleVncChallenge()
					break
				case 'awaiting_security_result':
					progress = this.handleSecurityResult()
					break
				case 'awaiting_server_init':
					progress = this.handleServerInit()
					break
				case 'connected':
					progress = this.handleServerMessage()
					break
			}
		}
	}

	/**
	 * Server sends "RFB 003.008\n" (12 bytes). We echo it back.
	 */
	private handleVersion(): boolean {
		if (this.recvBuffer.length < 12) return false

		const version = this.recvBuffer.subarray(0, 12).toString('ascii')
		this.recvBuffer = this.recvBuffer.subarray(12)

		if (!version.startsWith('RFB ')) {
			this.emit('error', new Error(`Unexpected RFB version: ${version.trim()}`))
			return false
		}

		// Echo the same version
		this.send(Buffer.from('RFB 003.008\n', 'ascii'))
		this.state = 'awaiting_security_types'
		return true
	}

	/**
	 * Server lists security types. Through PVE proxy, expect type 1 (None).
	 * Format: number-of-types (1 byte), then that many type bytes.
	 */
	private handleSecurityTypes(): boolean {
		if (this.recvBuffer.length < 1) return false

		const count = this.recvBuffer.readUInt8(0)

		if (count === 0) {
			// Server sent failure — next 4 bytes are reason length, then reason string
			if (this.recvBuffer.length < 5) return false
			const reasonLen = this.recvBuffer.readUInt32BE(1)
			if (this.recvBuffer.length < 5 + reasonLen) return false
			const reason = this.recvBuffer.subarray(5, 5 + reasonLen).toString('utf-8')
			this.recvBuffer = this.recvBuffer.subarray(5 + reasonLen)
			this.emit('error', new Error(`VNC authentication failed: ${reason}`))
			return false
		}

		if (this.recvBuffer.length < 1 + count) return false

		const types: number[] = []
		for (let i = 0; i < count; i++) {
			types.push(this.recvBuffer.readUInt8(1 + i))
		}
		this.recvBuffer = this.recvBuffer.subarray(1 + count)

		// Prefer type 2 (VNC Authentication) which PVE uses, fall back to type 1 (None)
		if (types.includes(2)) {
			this.send(Buffer.from([2]))
			this.state = 'awaiting_vnc_challenge'
		} else if (types.includes(1)) {
			this.send(Buffer.from([1]))
			this.state = 'awaiting_security_result'
		} else {
			this.emit(
				'error',
				new Error(`No supported VNC security type. Available: ${types.join(', ')}`),
			)
			return false
		}
		return true
	}

	/**
	 * VNC Authentication (type 2): server sends 16-byte challenge.
	 * Client encrypts it with DES using the VNC password as key.
	 */
	private handleVncChallenge(): boolean {
		if (this.recvBuffer.length < 16) return false

		const challenge = Buffer.from(this.recvBuffer.subarray(0, 16))
		this.recvBuffer = this.recvBuffer.subarray(16)

		const response = vncDesEncrypt(this.vncPassword, challenge)
		this.send(response)
		this.state = 'awaiting_security_result'
		return true
	}

	/**
	 * SecurityResult: 4 bytes, 0 = OK.
	 */
	private handleSecurityResult(): boolean {
		if (this.recvBuffer.length < 4) return false

		const result = this.recvBuffer.readUInt32BE(0)
		this.recvBuffer = this.recvBuffer.subarray(4)

		if (result !== 0) {
			this.emit('error', new Error(`VNC SecurityResult failed: ${result}`))
			return false
		}

		// ClientInit: shared-flag = 1
		this.send(Buffer.from([1]))
		this.state = 'awaiting_server_init'
		return true
	}

	/**
	 * ServerInit: width(2) + height(2) + pixel-format(16) + name-length(4) + name.
	 */
	private handleServerInit(): boolean {
		if (this.recvBuffer.length < 24) return false

		const width = this.recvBuffer.readUInt16BE(0)
		const height = this.recvBuffer.readUInt16BE(2)
		// Skip server pixel format (bytes 4-19), we'll set our own
		const nameLen = this.recvBuffer.readUInt32BE(20)

		if (this.recvBuffer.length < 24 + nameLen) return false

		this.recvBuffer = this.recvBuffer.subarray(24 + nameLen)

		// Initialize framebuffer
		this.framebuffer = new Framebuffer(width, height)

		// Configure our pixel format and encodings. ContinuousUpdates lets the
		// server push deltas without per-frame requests; Cursor + LastRect are
		// helper pseudo-encodings the server uses with it.
		this.send(buildSetPixelFormat())
		this.send(
			buildSetEncodings([
				RFB_ENCODING_COPYRECT,
				RFB_ENCODING_RAW,
				RFB_ENCODING_DESKTOP_SIZE,
				RFB_ENCODING_CURSOR,
				RFB_ENCODING_LAST_RECT,
				RFB_ENCODING_CONTINUOUS_UPDATES,
				RFB_ENCODING_EXTENDED_KEY,
			]),
		)

		// ContinuousUpdates is advertised in SetEncodings; the server confirms
		// support via a pseudo-encoding rect — only then is EnableContinuousUpdates
		// safe to send. We let the per-update incremental loop carry idle servers.
		this.send(buildFbUpdateRequest(false, 0, 0, width, height))

		this._connected = true
		this.state = 'connected'
		// connect() resolves after handshake — callers that need real pixels
		// should `await session.waitForUpdate(N, 0)` (seq===0 means no paint yet).
		this.emit('_init_done', width, height)
		return true
	}

	/**
	 * Handle server messages once connected.
	 */
	private handleServerMessage(): boolean {
		if (this.recvBuffer.length < 1) return false

		const msgType = this.recvBuffer.readUInt8(0)

		switch (msgType) {
			case MSG_FB_UPDATE:
				return this.handleFramebufferUpdate()
			case MSG_SET_COLOUR_MAP:
				return this.handleSetColourMap()
			case MSG_BELL:
				this.recvBuffer = this.recvBuffer.subarray(1)
				return true
			case MSG_SERVER_CUT_TEXT:
				return this.handleServerCutText()
			case MSG_END_OF_CONTINUOUS_UPDATES:
				// Sent only when continuous updates are disabled by us (we never do).
				// Consume the 1-byte header and move on.
				this.recvBuffer = this.recvBuffer.subarray(1)
				return true
			default:
				this.emit('error', new Error(`Unknown server message type: ${msgType}`))
				return false
		}
	}

	/**
	 * FramebufferUpdate: header(4) + N rectangles.
	 * Header: type(1) + padding(1) + rect-count(2)
	 * Rectangle: x(2) + y(2) + w(2) + h(2) + encoding(4) + data
	 */
	private handleFramebufferUpdate(): boolean {
		if (this.recvBuffer.length < 4) return false
		// FB messages can only arrive after handshake, which allocates framebuffer.
		const fb = this.framebuffer
		if (!fb) return false

		const rectCount = this.recvBuffer.readUInt16BE(2)
		let offset = 4
		let pixelsApplied = false

		for (let i = 0; i < rectCount; i++) {
			if (this.recvBuffer.length < offset + 12) return false

			const x = this.recvBuffer.readUInt16BE(offset)
			const y = this.recvBuffer.readUInt16BE(offset + 2)
			const w = this.recvBuffer.readUInt16BE(offset + 4)
			const h = this.recvBuffer.readUInt16BE(offset + 6)
			const encoding = this.recvBuffer.readInt32BE(offset + 8)
			offset += 12

			switch (encoding) {
				case RFB_ENCODING_RAW: {
					const dataLen = w * h * 4
					if (this.recvBuffer.length < offset + dataLen) return false
					fb.applyRaw(x, y, w, h, this.recvBuffer.subarray(offset, offset + dataLen))
					offset += dataLen
					pixelsApplied = true
					break
				}

				case RFB_ENCODING_COPYRECT: {
					if (this.recvBuffer.length < offset + 4) return false
					const srcX = this.recvBuffer.readUInt16BE(offset)
					const srcY = this.recvBuffer.readUInt16BE(offset + 2)
					fb.applyCopyRect(x, y, w, h, srcX, srcY)
					offset += 4
					pixelsApplied = true
					break
				}

				case RFB_ENCODING_DESKTOP_SIZE: {
					fb.resize(w, h)
					this.emit('resize', w, h)
					if (this.continuousUpdatesEnabled) {
						this.send(buildEnableContinuousUpdates(true, 0, 0, w, h))
					}
					pixelsApplied = true
					break
				}

				case RFB_ENCODING_CURSOR: {
					// Cursor pixels + mask; we don't render the cursor into the FB.
					const pixelsLen = w * h * 4
					const maskLen = Math.floor((w + 7) / 8) * h
					if (this.recvBuffer.length < offset + pixelsLen + maskLen) return false
					offset += pixelsLen + maskLen
					break
				}

				case RFB_ENCODING_LAST_RECT: {
					// Terminator pseudo-encoding.
					i = rectCount
					break
				}

				case RFB_ENCODING_EXTENDED_KEY: {
					this.supportsExtendedKey = true
					break
				}

				case RFB_ENCODING_CONTINUOUS_UPDATES: {
					if (!this.continuousUpdatesEnabled) {
						this.continuousUpdatesEnabled = true
						this.send(buildEnableContinuousUpdates(true, 0, 0, fb.width, fb.height))
					}
					break
				}

				default:
					this.emit('error', new Error(`Unsupported encoding: ${encoding}`))
					return false
			}
		}

		this.recvBuffer = this.recvBuffer.subarray(offset)

		// Fallback per-update incremental request — cheap, lets servers without
		// ContinuousUpdates still push deltas.
		this.send(buildFbUpdateRequest(true, 0, 0, fb.width, fb.height))

		if (pixelsApplied) this.emit('update', fb.updateSeq)
		return true
	}

	/**
	 * SetColourMapEntries: type(1) + padding(1) + first-colour(2) + num-colours(2) + data.
	 * We don't use indexed colour but must consume the message.
	 */
	private handleSetColourMap(): boolean {
		if (this.recvBuffer.length < 6) return false
		const numColours = this.recvBuffer.readUInt16BE(4)
		const totalLen = 6 + numColours * 6
		if (this.recvBuffer.length < totalLen) return false
		this.recvBuffer = this.recvBuffer.subarray(totalLen)
		return true
	}

	/**
	 * ServerCutText: type(1) + padding(3) + length(4) + text.
	 */
	private handleServerCutText(): boolean {
		if (this.recvBuffer.length < 8) return false
		const textLen = this.recvBuffer.readUInt32BE(4)
		const totalLen = 8 + textLen
		if (this.recvBuffer.length < totalLen) return false
		this.recvBuffer = this.recvBuffer.subarray(totalLen)
		return true
	}

	// --- Input methods ---

	sendKeyEvent(down: boolean, keysym: number): void {
		this.send(buildKeyEvent(down, keysym))
	}

	sendPointerEvent(buttonMask: number, x: number, y: number): void {
		this.send(buildPointerEvent(buttonMask, x, y))
	}

	sendExtendedKeyEvent(down: boolean, keysym: number, scancode: number): void {
		if (this.supportsExtendedKey) {
			this.send(buildExtendedKeyEvent(down, keysym, scancode))
		} else {
			this.send(buildKeyEvent(down, keysym))
		}
	}

	/**
	 * Type a string by sending key down+up for each character.
	 */
	async typeText(
		text: string,
		layout: KeyboardLayout = 'en-US',
		delayMs: number = 8,
	): Promise<void> {
		for (const char of text) {
			if (layout === 'es-ES') {
				if (char === '\n') {
					const enter = charToKeysym('enter')
					this.sendKeyEvent(true, enter)
					this.sendKeyEvent(false, enter)
					if (delayMs > 0) await sleep(delayMs)
					continue
				}
				// ES layouts use dead keys for several punctuation characters.
				// Sending pure keysyms avoids US scancode/dead-key interference.
				const keysym = charToKeysym(char)
				this.sendKeyEvent(true, keysym)
				this.sendKeyEvent(false, keysym)
				if (delayMs > 0) await sleep(delayMs)
				continue
			}

			const mapped = getUsKeyForChar(char)
			if (mapped) {
				this.sendMappedKey(mapped.key, mapped.shift, mapped.keysymToken)
			} else {
				// Fallback for non-US/non-ASCII chars.
				const keysym = charToKeysym(char)
				this.sendKeyEvent(true, keysym)
				this.sendKeyEvent(false, keysym)
			}

			if (delayMs > 0) await sleep(delayMs)
		}
	}

	private sendMappedKey(baseKey: string, withShift: boolean, keysymToken: string): void {
		const scancode = XT_SCANCODES[baseKey]
		if (scancode === undefined) {
			throw new Error(`No XT scancode mapping for key "${baseKey}"`)
		}

		const keysym = charToKeysym(keysymToken)
		const shiftKeysym = charToKeysym('shift')
		const shiftScancode = XT_SCANCODES.shift

		if (withShift) {
			this.sendExtendedKeyEvent(true, shiftKeysym, shiftScancode)
		}

		this.sendExtendedKeyEvent(true, keysym, scancode)
		this.sendExtendedKeyEvent(false, keysym, scancode)

		if (withShift) {
			this.sendExtendedKeyEvent(false, shiftKeysym, shiftScancode)
		}
	}

	/**
	 * Press a key combo like "ctrl+c", "alt+tab", "Return".
	 * Modifiers are held down, then key pressed, then all released in reverse order.
	 */
	pressKey(combo: string): void {
		const keysyms = parseKeyCombo(combo)

		// Press all keys down in order
		for (const keysym of keysyms) {
			this.sendKeyEvent(true, keysym)
		}

		// Release in reverse order
		for (let i = keysyms.length - 1; i >= 0; i--) {
			this.sendKeyEvent(false, keysyms[i])
		}
	}

	/**
	 * Click at a position. Sends move → button down → button up.
	 */
	click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): void {
		const buttonBit = button === 'left' ? 1 : button === 'middle' ? 2 : 4
		this.sendPointerEvent(0, x, y) // move
		this.sendPointerEvent(buttonBit, x, y) // down
		this.sendPointerEvent(0, x, y) // up
	}

	/**
	 * Scroll at a position.
	 */
	scroll(x: number, y: number, direction: 'up' | 'down', amount: number = 3): void {
		const buttonBit = direction === 'up' ? 8 : 16
		for (let i = 0; i < amount; i++) {
			this.sendPointerEvent(buttonBit, x, y) // scroll press
			this.sendPointerEvent(0, x, y) // release
		}
	}

	/**
	 * Drag from one point to another with animated intermediate steps.
	 *
	 * @param steps      Number of intermediate pointer events (default 20)
	 * @param durationMs Total drag duration in milliseconds (default 500)
	 * @param easing     Easing curve: "linear" | "ease-in" | "ease-out" | "ease-in-out" (default "ease-in-out")
	 */
	async drag(
		fromX: number,
		fromY: number,
		toX: number,
		toY: number,
		steps: number = 20,
		durationMs: number = 500,
		easing: EasingType = 'ease-in-out',
		startHoldMs: number = 50,
		endHoldMs: number = 50,
	): Promise<void> {
		const delay = durationMs / steps
		const ease = EASING_FUNCTIONS[easing]

		// Move to start position
		this.sendPointerEvent(0, fromX, fromY)
		if (startHoldMs > 0) await sleep(startHoldMs)

		// Press button down at start
		this.sendPointerEvent(1, fromX, fromY)
		if (startHoldMs > 0) await sleep(startHoldMs)

		// Interpolate through intermediate points with easing
		for (let i = 1; i <= steps; i++) {
			const t = ease(i / steps)
			const x = Math.round(fromX + (toX - fromX) * t)
			const y = Math.round(fromY + (toY - fromY) * t)
			this.sendPointerEvent(1, x, y)
			await sleep(delay)
		}

		// Small pause before release so the target registers the drop
		if (endHoldMs > 0) await sleep(endHoldMs)

		// Release button at destination
		this.sendPointerEvent(0, toX, toY)
	}

	/**
	 * Request a fresh full framebuffer update.
	 */
	/** Send a non-incremental FB request. Returns the seq at the time of the send. */
	requestFullUpdate(): number {
		if (!this.framebuffer) return 0
		this.send(buildFbUpdateRequest(false, 0, 0, this.framebuffer.width, this.framebuffer.height))
		return this.framebuffer.updateSeq
	}

	/** Current monotonic paint counter (0 before first frame). */
	get updateSeq(): number {
		return this.framebuffer?.updateSeq ?? 0
	}

	/**
	 * Resolve when the framebuffer seq advances past `since` (default: current
	 * seq). Rejects on timeout OR when the session closes/errors, so callers
	 * never sit on a dead socket waiting for paint that will never come.
	 */
	waitForUpdate(timeoutMs: number = 3000, since?: number): Promise<number> {
		const fb = this.framebuffer
		if (!fb) return Promise.reject(new Error('framebuffer not initialised'))
		const baseline = since ?? fb.updateSeq
		return new Promise<number>((resolve, reject) => {
			if (fb.updateSeq > baseline) {
				resolve(fb.updateSeq)
				return
			}
			const cleanup = () => {
				clearTimeout(timer)
				this.removeListener('update', onUpdate)
				this.removeListener('close', onClose)
				this.removeListener('error', onClose)
			}
			const onUpdate = (seq: number) => {
				if (seq > baseline) {
					cleanup()
					resolve(seq)
				}
			}
			const onClose = (err?: Error) => {
				cleanup()
				reject(err ?? new Error('VNC session closed'))
			}
			const timer = setTimeout(() => {
				cleanup()
				reject(new Error(`waitForUpdate timed out after ${timeoutMs}ms (seq=${fb.updateSeq})`))
			}, timeoutMs)
			timer.unref()
			this.on('update', onUpdate)
			this.once('close', onClose)
			this.once('error', onClose)
		})
	}

	/**
	 * Disconnect the VNC session.
	 */
	disconnect(): void {
		this._connected = false
		this.ws?.close()
		this.ws = null
		this.recvBuffer = Buffer.alloc(0)
		this.state = 'awaiting_version'
	}
}

/**
 * Manages multiple VNC sessions, one per VM.
 */
export class VncSessionManager {
	private sessions = new Map<number, VncSession>()
	private pending = new Map<number, Promise<VncSession>>()
	private api: PveApiClient

	constructor(api: PveApiClient) {
		this.api = api
	}

	async connect(vmid: number, node?: string): Promise<VncSession> {
		const existing = this.sessions.get(vmid)
		if (existing?.connected) return existing
		// Coalesce concurrent first-callers onto the same handshake.
		const inflight = this.pending.get(vmid)
		if (inflight) return inflight
		if (existing) existing.disconnect()

		const p = (async () => {
			const resolvedNode = node ?? (await this.api.findVmNode(vmid))
			const session = new VncSession(this.api, { node: resolvedNode, vmid })
			try {
				await session.connect()
				this.sessions.set(vmid, session)
				// Drop the session from the map when the underlying WS dies, so
				// getSession() never hands out a half-dead reference.
				session.once('close', () => {
					if (this.sessions.get(vmid) === session) this.sessions.delete(vmid)
				})
				return session
			} catch (err) {
				try { session.disconnect() } catch {}
				throw err
			}
		})()
		this.pending.set(vmid, p)
		try {
			return await p
		} finally {
			this.pending.delete(vmid)
		}
	}

	getSession(vmid: number): VncSession | undefined {
		return this.sessions.get(vmid)
	}

	getConnectedSession(vmid: number): VncSession {
		const session = this.sessions.get(vmid)
		if (!session?.connected) {
			throw new Error(`No active VNC session for VM ${vmid}. Call connect first.`)
		}
		return session
	}

	disconnect(vmid: number): void {
		const session = this.sessions.get(vmid)
		if (session) {
			session.disconnect()
			this.sessions.delete(vmid)
		}
	}

	disconnectAll(): void {
		for (const [vmid, session] of this.sessions) {
			session.disconnect()
			this.sessions.delete(vmid)
		}
	}
}
