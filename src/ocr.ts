/**
 * OCR dispatcher.
 *
 * Single backend: rapidocr (PP-OCRv4 mobile via OpenVINO / ONNX runtime).
 * Returns structured boxes per detected text block.
 *
 * `OcrPool` multiplexes requests across N persistent Python workers. The
 * module-level default pool sits behind `ocrImage` for callers that don't
 * need to manage their own sizing.
 */

import { RapidOcrClient, type OcrItem } from './ocr-rapidocr.js'

export interface OcrResult {
	/** Concatenated text: `items.map(i => i.text).join('\n')`. */
	text: string
	/** Structured detections. */
	items: OcrItem[]
	/** Inference time (ms). */
	ms: number
}

export type { OcrItem }

interface PoolWorker {
	client: RapidOcrClient
	busy: boolean
}

interface PoolWaiter {
	image: Buffer
	signal?: AbortSignal
	resolve: (r: OcrResult) => void
	reject: (e: Error) => void
	abortListener?: () => void
}

const WORKERS_MIN = 1
const WORKERS_MAX = 4
const WORKERS_DEFAULT = 2

function resolveSize(requested?: number): number {
	const raw = requested ?? Number(process.env.PVE_OCR_WORKERS ?? WORKERS_DEFAULT)
	if (!Number.isFinite(raw)) return WORKERS_DEFAULT
	return Math.max(WORKERS_MIN, Math.min(WORKERS_MAX, Math.floor(raw)))
}

export class OcrPool {
	readonly size: number
	private workers: PoolWorker[] = []
	private waiters: PoolWaiter[] = []
	private bgSpawnTriggered = false

	constructor(size?: number) {
		this.size = resolveSize(size)
	}

	async ocr(image: Buffer, signal?: AbortSignal): Promise<OcrResult> {
		signal?.throwIfAborted()
		if (this.workers.length === 0) {
			this.workers.push({ client: new RapidOcrClient(0), busy: false })
		}
		return new Promise<OcrResult>((resolve, reject) => {
			const waiter: PoolWaiter = { image, signal, resolve, reject }
			if (signal) {
				waiter.abortListener = () => {
					const i = this.waiters.indexOf(waiter)
					if (i >= 0) {
						this.waiters.splice(i, 1)
						reject(signal.reason ?? new Error('aborted'))
					}
					// If already dispatched, RapidOcrClient.recognize handles the abort.
				}
				signal.addEventListener('abort', waiter.abortListener, { once: true })
			}
			this.waiters.push(waiter)
			this.drain()
		})
	}

	private drain(): void {
		while (this.waiters.length > 0) {
			const idx = this.workers.findIndex((w) => !w.busy)
			if (idx < 0) break
			const worker = this.workers[idx]
			const waiter = this.waiters.shift()!
			worker.busy = true
			void this.dispatch(worker, waiter)
		}
		this.maybeBackgroundSpawn()
	}

	private async dispatch(worker: PoolWorker, waiter: PoolWaiter): Promise<void> {
		if (waiter.abortListener && waiter.signal) {
			waiter.signal.removeEventListener('abort', waiter.abortListener)
		}
		try {
			const raw = await worker.client.recognize(waiter.image, waiter.signal)
			const text = raw.items.map((i) => i.text).join('\n')
			waiter.resolve({ text, items: raw.items, ms: raw.ms })
		} catch (e) {
			waiter.reject(e instanceof Error ? e : new Error(String(e)))
		} finally {
			worker.busy = false
			this.drain()
		}
	}

	private maybeBackgroundSpawn(): void {
		if (this.bgSpawnTriggered) return
		if (this.workers.length >= this.size) return
		this.bgSpawnTriggered = true
		void this.spawnRemaining()
	}

	private async spawnRemaining(): Promise<void> {
		try {
			await this.workers[0].client.ensureStarted()
		} catch {
			this.bgSpawnTriggered = false
			return
		}
		while (this.workers.length < this.size) {
			const id = this.workers.length
			const w: PoolWorker = { client: new RapidOcrClient(id), busy: false }
			this.workers.push(w)
			// Pay cold-start in parallel; failures self-heal on next dispatch.
			w.client.ensureStarted().catch(() => {})
		}
	}

	async shutdown(): Promise<void> {
		const workers = this.workers
		this.workers = []
		this.bgSpawnTriggered = false
		const pending = this.waiters
		this.waiters = []
		for (const w of pending) w.reject(new Error('OCR pool shut down'))
		await Promise.all(workers.map((w) => w.client.shutdown().catch(() => {})))
	}
}

let defaultPool: OcrPool | null = null

function getDefaultPool(): OcrPool {
	if (!defaultPool) defaultPool = new OcrPool()
	return defaultPool
}

/**
 * Run OCR on an encoded image buffer (PNG/JPEG/etc) via the default pool.
 */
export async function ocrImage(image: Buffer, signal?: AbortSignal): Promise<OcrResult> {
	return getDefaultPool().ocr(image, signal)
}

/** Release any persistent OCR resources (workers, child processes). */
export async function shutdownOcr(): Promise<void> {
	if (!defaultPool) return
	const p = defaultPool
	defaultPool = null
	await p.shutdown()
}
