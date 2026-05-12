/**
 * OCR dispatcher.
 *
 * Backends, in default order: rapidocr (PP-OCRv4 mobile via OpenVINO / ONNX
 * runtime) → tesseract (PATH → `nix run nixpkgs#tesseract`). Override with
 * the PVE_OCR env var: 'rapidocr', 'tesseract', or 'auto' (default).
 *
 * Rapidocr returns structured boxes per detected text block; tesseract
 * returns a single concatenated text dump.
 */

import { spawn } from 'node:child_process'

import {
	getRapidOcrClient,
	shutdownRapidOcr,
	type OcrItem,
} from './ocr-rapidocr.js'

export type OcrBackend = 'rapidocr' | 'tesseract'

export interface OcrOptions {
	/** Tesseract-only: PSM (page segmentation mode). Default 6. */
	psm?: number
	/** Tesseract-only: language code. Default 'eng'. */
	lang?: string
	/** Tesseract-only: char whitelist. */
	whitelist?: string
}

export interface OcrResult {
	/** Concatenated text. For rapidocr this is `items.map(i => i.text).join('\n')`. */
	text: string
	/** Structured detections (rapidocr only). */
	items?: OcrItem[]
	backend: OcrBackend
	/** Inference time (ms). */
	ms: number
}

export type { OcrItem }

// ---------- tesseract backend ----------

type TessCmd = { argv0: string; prefix: string[] }
let tesseractResolved: Promise<TessCmd> | null = null

function tryRun(argv0: string, prefix: string[]): Promise<boolean> {
	return new Promise((res) => {
		const child = spawn(argv0, [...prefix, '--version'], { stdio: 'ignore' })
		child.once('error', () => res(false))
		child.once('exit', (code) => res(code === 0))
	})
}

async function resolveTesseract(): Promise<TessCmd> {
	if (await tryRun('tesseract', [])) return { argv0: 'tesseract', prefix: [] }
	if (await tryRun('nix', ['run', 'nixpkgs#tesseract', '--']))
		return { argv0: 'nix', prefix: ['run', 'nixpkgs#tesseract', '--'] }
	throw new Error(
		'tesseract not available: install `tesseract` or ensure `nix` with flakes is on PATH',
	)
}

async function tesseractOcr(
	image: Buffer,
	opts: OcrOptions,
	signal?: AbortSignal,
): Promise<OcrResult> {
	if (!tesseractResolved) tesseractResolved = resolveTesseract()
	const { argv0, prefix } = await tesseractResolved
	const psm = opts.psm ?? 6
	const lang = opts.lang ?? 'eng'
	const args = [...prefix, 'stdin', 'stdout', '-l', lang, '--psm', String(psm)]
	if (opts.whitelist) args.push('-c', `tessedit_char_whitelist=${opts.whitelist}`)

	const t0 = Date.now()
	const text = await new Promise<string>((resolve, reject) => {
		const child = spawn(argv0, args, { stdio: ['pipe', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		const onAbort = () => {
			child.kill('SIGTERM')
			reject(signal!.reason ?? new Error('aborted'))
		}
		if (signal) {
			if (signal.aborted) {
				child.kill('SIGTERM')
				return reject(signal.reason ?? new Error('aborted'))
			}
			signal.addEventListener('abort', onAbort, { once: true })
		}
		child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
		child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
		child.stdin.on('error', () => {}) // swallow EPIPE if child died mid-write
		child.once('error', (e) => {
			signal?.removeEventListener('abort', onAbort)
			reject(e)
		})
		child.once('exit', (code) => {
			signal?.removeEventListener('abort', onAbort)
			if (code === 0) resolve(stdout)
			else reject(new Error(`tesseract exited ${code}: ${stderr.trim()}`))
		})
		child.stdin.end(image)
	})
	return { text, backend: 'tesseract', ms: Date.now() - t0 }
}

// ---------- rapidocr backend ----------

async function rapidocrOcr(image: Buffer, signal?: AbortSignal): Promise<OcrResult> {
	const client = getRapidOcrClient()
	const res = await client.recognize(image, signal)
	const text = res.items.map((i) => i.text).join('\n')
	return { text, items: res.items, backend: 'rapidocr', ms: res.ms }
}

// ---------- dispatcher ----------

let pickedBackend: Promise<OcrBackend> | null = null

async function pickBackend(): Promise<OcrBackend> {
	const want = (process.env.PVE_OCR || 'auto').toLowerCase()
	if (want === 'rapidocr') return 'rapidocr'
	if (want === 'tesseract') return 'tesseract'

	// auto: probe rapidocr by attempting to start the worker once; fall back to tesseract.
	try {
		await getRapidOcrClient().ensureStarted()
		return 'rapidocr'
	} catch {
		return 'tesseract'
	}
}

/** Resolve which backend OCR will use, without running a recognition. */
export async function getOcrBackend(): Promise<OcrBackend> {
	if (!pickedBackend) pickedBackend = pickBackend()
	return pickedBackend
}

/**
 * Run OCR on an encoded image buffer (PNG/JPEG/etc).
 */
export async function ocrImage(
	image: Buffer,
	opts: OcrOptions = {},
	signal?: AbortSignal,
): Promise<OcrResult> {
	const backend = await getOcrBackend()
	signal?.throwIfAborted()
	if (backend === 'rapidocr') return rapidocrOcr(image, signal)
	return tesseractOcr(image, opts, signal)
}

/** Release any persistent OCR resources (workers, child processes). */
export async function shutdownOcr(): Promise<void> {
	await shutdownRapidOcr()
	pickedBackend = null
}
