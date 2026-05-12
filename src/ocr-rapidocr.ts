/**
 * Long-lived RapidOCR worker client.
 *
 * Spawns `uv run ocr/rapidocr_server.py` as a child process and exchanges
 * length-prefixed images for JSON responses over stdin/stdout. One worker is
 * reused for the lifetime of the process.
 *
 * Protocol (matches ocr/rapidocr_server.py):
 *   request:  <4-byte BE length><N bytes image>
 *   response: one JSON line per request
 *   shutdown: write length=0
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export interface OcrItem {
	/** Quadrilateral [[x,y], [x,y], [x,y], [x,y]] in source image coordinates. */
	box: [number, number][]
	text: string
	conf: number
}

export interface RapidOcrResult {
	items: OcrItem[]
	/** Inference time inside the Python worker (ms). */
	ms: number
}

interface PendingRequest {
	resolve: (r: RapidOcrResult) => void
	reject: (e: Error) => void
	abortListener?: () => void
	signal?: AbortSignal
}

class RapidOcrClient {
	private proc: ChildProcessWithoutNullStreams | null = null
	private ready: Promise<void> | null = null
	private queue: PendingRequest[] = []
	private stdoutBuf = ''

	async ensureStarted(): Promise<void> {
		if (this.ready) return this.ready
		this.ready = this.start()
		try {
			await this.ready
		} catch (e) {
			this.ready = null
			throw e
		}
	}

	private async start(): Promise<void> {
		const uv = await locateUv()
		const script = locateServerScript()
		const child = spawn(uv, ['run', script], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, PYTHONUNBUFFERED: '1' },
		})
		this.proc = child

		child.on('error', (err) => {
			this.failAll(new Error(`OCR worker error: ${err.message}`))
		})
		child.on('exit', (code, signal) => {
			this.proc = null
			this.ready = null
			if (this.queue.length > 0) {
				this.failAll(new Error(`OCR worker exited (code=${code}, signal=${signal})`))
			}
		})

		// Stderr is purely diagnostic — drop it unless DEBUG is set.
		child.stderr.on('data', (d: Buffer) => {
			if (process.env.PVE_OCR_DEBUG) process.stderr.write(`[rapidocr] ${d}`)
		})

		// EPIPE on stdin (worker died mid-write) is reported via the exit handler
		// and the queued request rejection; swallow the stream-level error event
		// so it doesn't propagate as unhandled.
		child.stdin.on('error', () => {})

		// Wait for the readiness line, then attach the main line handler.
		const ready = await readJsonLine(child)
		if (ready.ready !== true) {
			child.kill('SIGTERM')
			throw new Error(`OCR worker failed to start: ${JSON.stringify(ready)}`)
		}
		this.attachStdout(child)
	}

	private attachStdout(child: ChildProcessWithoutNullStreams) {
		child.stdout.on('data', (chunk: Buffer) => {
			this.stdoutBuf += chunk.toString('utf8')
			let idx: number
			while ((idx = this.stdoutBuf.indexOf('\n')) !== -1) {
				const line = this.stdoutBuf.slice(0, idx).trim()
				this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
				if (!line) continue
				const pending = this.queue.shift()
				if (!pending) continue
				if (pending.abortListener && pending.signal) {
					pending.signal.removeEventListener('abort', pending.abortListener)
				}
				try {
					const parsed = JSON.parse(line) as { ms?: number; items?: OcrItem[]; error?: string }
					if (parsed.error) {
						pending.reject(new Error(parsed.error))
					} else {
						pending.resolve({ items: parsed.items ?? [], ms: parsed.ms ?? 0 })
					}
				} catch (e) {
					pending.reject(new Error(`bad worker response: ${line.slice(0, 200)}`))
				}
			}
		})
	}

	async recognize(image: Buffer, signal?: AbortSignal): Promise<RapidOcrResult> {
		signal?.throwIfAborted()
		await this.ensureStarted()
		const proc = this.proc
		if (!proc || !proc.stdin.writable) throw new Error('OCR worker not running')
		return new Promise<RapidOcrResult>((resolve, reject) => {
			const pending: PendingRequest = { resolve, reject, signal }
			if (signal) {
				pending.abortListener = () => {
					// Mark this entry as cancelled; the worker will still produce a
					// response which `attachStdout` will discard via the marker.
					const idx = this.queue.indexOf(pending)
					if (idx >= 0) this.queue[idx] = { ...pending, resolve: () => {}, reject: () => {} }
					reject(signal.reason ?? new Error('aborted'))
				}
				signal.addEventListener('abort', pending.abortListener, { once: true })
			}
			this.queue.push(pending)
			const hdr = Buffer.alloc(4)
			hdr.writeUInt32BE(image.length, 0)
			const ok1 = proc.stdin.write(hdr)
			const ok2 = proc.stdin.write(image)
			if (!ok1 || !ok2) {
				// Backpressure: still legal, the kernel will buffer; the response
				// path is unaffected. No special handling needed.
			}
		})
	}

	private failAll(err: Error) {
		const pending = this.queue
		this.queue = []
		for (const p of pending) p.reject(err)
	}

	async shutdown(): Promise<void> {
		const proc = this.proc
		if (!proc) return
		try {
			const zero = Buffer.alloc(4)
			proc.stdin.end(zero)
		} catch {}
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				try {
					proc.kill('SIGTERM')
				} catch {}
				resolve()
			}, 2000)
			proc.once('exit', () => {
				clearTimeout(t)
				resolve()
			})
		})
		this.proc = null
		this.ready = null
	}
}

async function readJsonLine(
	child: ChildProcessWithoutNullStreams,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let buf = ''
		const onData = (chunk: Buffer) => {
			buf += chunk.toString('utf8')
			const idx = buf.indexOf('\n')
			if (idx !== -1) {
				child.stdout.removeListener('data', onData)
				child.removeListener('exit', onExit)
				const line = buf.slice(0, idx).trim()
				if (!line) {
					reject(new Error('empty readiness line'))
					return
				}
				try {
					resolve(JSON.parse(line))
				} catch (e) {
					reject(new Error(`bad readiness line: ${line.slice(0, 200)}`))
				}
			}
		}
		const onExit = (code: number | null) => {
			child.stdout.removeListener('data', onData)
			reject(new Error(`worker exited before ready (code=${code})`))
		}
		child.stdout.on('data', onData)
		child.once('exit', onExit)
	})
}

async function locateUv(): Promise<string> {
	const which = await new Promise<string | null>((resolve) => {
		const p = spawn('command', ['-v', 'uv'], { stdio: ['ignore', 'pipe', 'ignore'], shell: true })
		let out = ''
		p.stdout.on('data', (d) => (out += d.toString('utf8')))
		p.once('error', () => resolve(null))
		p.once('exit', (code) => resolve(code === 0 ? out.trim() : null))
	})
	if (which) return which
	throw new Error('rapidocr backend needs `uv` on PATH (see https://docs.astral.sh/uv/)')
}

function locateServerScript(): string {
	const here = dirname(fileURLToPath(import.meta.url))
	// dev: ../ocr/rapidocr_server.py relative to src/
	// build: ../ocr/rapidocr_server.py relative to dist/
	const candidates = [
		resolve(here, '..', 'ocr', 'rapidocr_server.py'),
		resolve(here, '..', '..', 'ocr', 'rapidocr_server.py'),
	]
	for (const c of candidates) if (existsSync(c)) return c
	throw new Error(`rapidocr_server.py not found (looked in: ${candidates.join(', ')})`)
}

let singleton: RapidOcrClient | null = null

export function getRapidOcrClient(): RapidOcrClient {
	if (!singleton) singleton = new RapidOcrClient()
	return singleton
}

export async function shutdownRapidOcr(): Promise<void> {
	if (singleton) {
		await singleton.shutdown()
		singleton = null
	}
}
