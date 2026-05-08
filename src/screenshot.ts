/**
 * Screenshot capture
 *
 * Converts the RGBA framebuffer to JPEG at native resolution.
 */

import { encode as encodeJpeg } from 'jpeg-js'
import type { Framebuffer } from './framebuffer.js'

export interface Screenshot {
	/** Base64-encoded JPEG image */
	data: string
	/** Image dimensions */
	width: number
	height: number
}

/**
 * Capture the current framebuffer as a JPEG screenshot at native resolution.
 */
export async function captureScreenshot(
	fb: Framebuffer,
	quality: number = 85,
): Promise<Screenshot> {
	const { width, height } = fb

	// PVE VNC pixel format: BGRX. jpeg-js expects RGBA.
	const rgbaBuffer = swapRedBlue(fb.buffer, width * height)

	const { data: jpegBuffer } = encodeJpeg(
		{ data: rgbaBuffer, width, height },
		quality,
	)

	return {
		data: jpegBuffer.toString('base64'),
		width,
		height,
	}
}

function swapRedBlue(buffer: Buffer, pixelCount: number): Buffer {
	const out = Buffer.from(buffer)
	for (let i = 0; i < pixelCount; i++) {
		const offset = i * 4
		const b = out[offset]
		const r = out[offset + 2]
		out[offset] = r
		out[offset + 2] = b
		out[offset + 3] = 255
	}
	return out
}
