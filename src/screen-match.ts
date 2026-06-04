/**
 * Screen matching primitives: color presence + OCR text against the raw framebuffer.
 *
 * Framebuffer pixel layout is BGRX (see screenshot.ts). Color checks operate on the
 * raw buffer to avoid re-decoding. OCR encodes a (cropped) region to JPEG and pipes
 * it to rapidocr.
 */

import { encode as encodeJpeg } from 'jpeg-js'

import type { Framebuffer, FramebufferSnapshot } from './framebuffer.js'
import { ocrImage, type OcrItem } from './ocr.js'

type FbLike = Framebuffer | FramebufferSnapshot

function isLiveFramebuffer(fb: FbLike): fb is Framebuffer {
	// Framebuffer has updateSeq; FramebufferSnapshot exposes seq instead.
	return 'updateSeq' in fb
}

export interface Region {
	x: number
	y: number
	w: number
	h: number
}

export interface ColorMatch {
	/** Target color as '#rrggbb' or [r,g,b]. */
	near: string | [number, number, number]
	/**
	 * Similarity threshold 0..1 (1 = exact match, 0 = anything). Default 0.9.
	 * Internally: 1 - rgbDistance/maxDistance.
	 */
	threshold?: number
	/** Min fraction of region pixels that must match (0..1). Default 0.01 (>=1%). */
	area?: number
	/** Restrict color search to this region. */
	region?: Region
}

export interface TextMatch {
	pattern: string | RegExp
	/**
	 * Optional fuzzy threshold for string patterns, 0..1. If omitted, string
	 * patterns use exact substring matching and RegExp patterns use RegExp.test.
	 */
	threshold?: number
	/**
	 * Optional region hint. rapidocr usually doesn't need one - every detected
	 * text block on the full screen is checked individually.
	 */
	region?: Region
	/** Integer nearest-neighbor upscale applied before OCR. Default 1. */
	scale?: number
}

export interface ScreenMatchOptions {
	text?: TextMatch | string | RegExp
	color?: ColorMatch
	/** Combine text+color: require both ('all', default) or either ('any'). */
	match?: 'all' | 'any'
}

export interface ScreenMatchResult {
	matched: boolean
	/** Concatenated OCR text (if a text check ran). */
	text?: string
	/** Detected text blocks (if a text check ran). */
	items?: OcrItem[]
	/** The specific text block that satisfied the pattern, if any. */
	matchedItem?: OcrItem
	/** Best fuzzy text score observed, if a text threshold was used. */
	textScore?: number
	colorRatio?: number
}

function parseColor(c: string | [number, number, number]): [number, number, number] {
	if (Array.isArray(c)) return c
	const m = /^#?([0-9a-f]{6})$/i.exec(c.trim())
	if (!m) throw new Error(`invalid color: ${c}`)
	const n = parseInt(m[1], 16)
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function normalizeText(t: TextMatch | string | RegExp): TextMatch {
	if (typeof t === 'string' || t instanceof RegExp) return { pattern: t }
	return t
}

function normalizeComparableText(text: string): string {
	return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function clampRegion(fb: FbLike, r?: Region): Region {
	if (!r) return { x: 0, y: 0, w: fb.width, h: fb.height }
	const x = Math.max(0, Math.min(fb.width - 1, r.x | 0))
	const y = Math.max(0, Math.min(fb.height - 1, r.y | 0))
	const w = Math.max(1, Math.min(fb.width - x, r.w | 0))
	const h = Math.max(1, Math.min(fb.height - y, r.h | 0))
	return { x, y, w, h }
}

/** Returns fraction of region pixels within similarity threshold of target color. */
export function colorRatio(fb: FbLike, opts: ColorMatch): number {
	if (fb.width === 0 || fb.height === 0) return 0
	const [tr, tg, tb] = parseColor(opts.near)
	const threshold = opts.threshold ?? 0.9
	// Per-channel tolerance: threshold=1 is exact, threshold=0 allows any colour.
	// At 0.9, each R/G/B channel may drift up to ~25 units. Chebyshev distance,
	// which is more intuitive than Euclidean for "how close is this to my color".
	const tol = Math.round((1 - threshold) * 255)
	const region = clampRegion(fb, opts.region)
	const buf = fb.buffer
	const stride = fb.width * 4
	const total = region.w * region.h
	if (total === 0) return 0
	let hits = 0
	for (let row = 0; row < region.h; row++) {
		let off = (region.y + row) * stride + region.x * 4
		for (let col = 0; col < region.w; col++) {
			const b = buf[off]
			const g = buf[off + 1]
			const r = buf[off + 2]
			if (Math.abs(r - tr) <= tol && Math.abs(g - tg) <= tol && Math.abs(b - tb) <= tol) {
				hits++
			}
			off += 4
		}
	}
	return hits / total
}

/**
 * Encode a region of the BGRX framebuffer to a JPEG buffer (RGBA expected by jpeg-js),
 * with an optional integer nearest-neighbor upscale.
 */
export function regionToJpeg(fb: FbLike, r: Region, quality = 85, scale = 1): Buffer {
	const region = clampRegion(fb, r)
	const s = Math.max(1, Math.floor(scale))
	const outW = region.w * s
	const outH = region.h * s
	const out = Buffer.alloc(outW * outH * 4)
	const srcStride = fb.width * 4
	const dstStride = outW * 4
	const src = fb.buffer
	for (let row = 0; row < region.h; row++) {
		let srcOff = (region.y + row) * srcStride + region.x * 4
		const dstRowBase = row * s * dstStride
		for (let col = 0; col < region.w; col++) {
			const b = src[srcOff]
			const g = src[srcOff + 1]
			const r2 = src[srcOff + 2]
			for (let dy = 0; dy < s; dy++) {
				let dstOff = dstRowBase + dy * dstStride + col * s * 4
				for (let dx = 0; dx < s; dx++) {
					out[dstOff] = r2
					out[dstOff + 1] = g
					out[dstOff + 2] = b
					out[dstOff + 3] = 255
					dstOff += 4
				}
			}
			srcOff += 4
		}
	}
	return encodeJpeg({ data: out, width: outW, height: outH }, quality).data
}

function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0
	if (a.length === 0) return b.length
	if (b.length === 0) return a.length

	let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
	let curr = new Array<number>(b.length + 1)

	for (let i = 1; i <= a.length; i++) {
		curr[0] = i
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
		}
		const tmp = prev
		prev = curr
		curr = tmp
	}

	return prev[b.length]
}

function similarity(a: string, b: string): number {
	const maxLen = Math.max(a.length, b.length)
	if (maxLen === 0) return 1
	return 1 - levenshteinDistance(a, b) / maxLen
}

function fuzzySubstringScore(pattern: string, text: string): number {
	const needle = normalizeComparableText(pattern)
	const haystack = normalizeComparableText(text)
	if (needle.length === 0) return haystack.length === 0 ? 1 : 0
	if (haystack.includes(needle)) return 1
	if (haystack.length === 0) return 0
	if (haystack.length <= needle.length) return similarity(needle, haystack)

	const minLen = Math.max(1, Math.floor(needle.length * 0.6))
	const maxLen = Math.min(haystack.length, Math.ceil(needle.length * 1.4))
	let best = 0

	for (let start = 0; start < haystack.length; start++) {
		for (let len = minLen; len <= maxLen && start + len <= haystack.length; len++) {
			best = Math.max(best, similarity(needle, haystack.slice(start, start + len)))
			if (best === 1) return best
		}
	}

	return best
}

export interface TextMatchOutcome {
	matched: boolean
	score?: number
}

export function matchText(tm: TextMatch, text: string): TextMatchOutcome {
	if (tm.threshold !== undefined) {
		if (typeof tm.pattern !== 'string') {
			throw new Error('Text threshold is only supported for string patterns')
		}
		if (!Number.isFinite(tm.threshold) || tm.threshold < 0 || tm.threshold > 1) {
			throw new Error('Text threshold must be between 0 and 1')
		}
		const score = fuzzySubstringScore(tm.pattern, text)
		return { matched: score >= tm.threshold, score }
	}

	if (typeof tm.pattern === 'string') return { matched: text.includes(tm.pattern) }
	// Reset lastIndex so /g and /y flags don't desync across calls.
	tm.pattern.lastIndex = 0
	return { matched: tm.pattern.test(text) }
}

/** Run text/color checks against a framebuffer snapshot. */
export async function matchScreen(
	fb: FbLike,
	opts: ScreenMatchOptions,
	signal?: AbortSignal,
): Promise<ScreenMatchResult> {
	const combine = opts.match ?? 'all'
	const checks: boolean[] = []
	const result: ScreenMatchResult = { matched: false }

	// Snapshot the live framebuffer if the caller passed one - incoming VNC
	// updates mutate fb.buffer in place and awaits would tear the frame.
	// Callers that pass a FramebufferSnapshot skip the copy.
	const snap: FramebufferSnapshot = isLiveFramebuffer(fb) ? fb.snapshot() : fb

	if (opts.color) {
		const ratio = colorRatio(snap, opts.color)
		const need = opts.color.area ?? 0.01
		result.colorRatio = ratio
		const ok = ratio >= need
		checks.push(ok)
		if (combine === 'all' && !ok) return result
		if (combine === 'any' && ok) {
			result.matched = true
			return result
		}
	}

	if (opts.text !== undefined) {
		signal?.throwIfAborted()
		const tm = normalizeText(opts.text)
		const region = clampRegion(snap, tm.region)
		const scale = tm.scale ?? 1
		const jpeg = regionToJpeg(snap, region, 85, scale)
		const ocr = await ocrImage(jpeg, signal)
		result.text = ocr.text
		result.items = ocr.items

		let ok = false
		for (const it of ocr.items) {
			const matched = matchText(tm, it.text)
			if (matched.score !== undefined) {
				result.textScore = Math.max(result.textScore ?? 0, matched.score)
			}
			if (matched.matched) {
				ok = true
				result.matchedItem = it
				break
			}
		}
		if (!ok) {
			const matched = matchText(tm, ocr.text)
			if (matched.score !== undefined) {
				result.textScore = Math.max(result.textScore ?? 0, matched.score)
			}
			ok = matched.matched
		}
		checks.push(ok)
	}

	if (checks.length === 0) return result
	result.matched = combine === 'all' ? checks.every(Boolean) : checks.some(Boolean)
	return result
}
