/**
 * OCR dispatcher.
 *
 * Single backend: rapidocr (PP-OCRv4 mobile via OpenVINO / ONNX runtime).
 * Returns structured boxes per detected text block.
 */

import {
	getRapidOcrClient,
	shutdownRapidOcr,
	type OcrItem,
} from './ocr-rapidocr.js'

export interface OcrResult {
	/** Concatenated text: `items.map(i => i.text).join('\n')`. */
	text: string
	/** Structured detections. */
	items: OcrItem[]
	/** Inference time (ms). */
	ms: number
}

export type { OcrItem }

/**
 * Run OCR on an encoded image buffer (PNG/JPEG/etc).
 */
export async function ocrImage(
	image: Buffer,
	signal?: AbortSignal,
): Promise<OcrResult> {
	signal?.throwIfAborted()
	const client = getRapidOcrClient()
	const res = await client.recognize(image, signal)
	const text = res.items.map((i) => i.text).join('\n')
	return { text, items: res.items, ms: res.ms }
}

/** Release any persistent OCR resources (workers, child processes). */
export async function shutdownOcr(): Promise<void> {
	await shutdownRapidOcr()
}
