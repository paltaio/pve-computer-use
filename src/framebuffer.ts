/**
 * In-memory framebuffer fed by VNC FramebufferUpdate rectangles.
 *
 * Supports RAW + CopyRect rectangle encodings and the DesktopSize pseudo-
 * encoding (resolution change). State changes that touch pixels bump a
 * monotonic `updateSeq` so consumers can subscribe to "next paint" without
 * the boolean-dirty conflation that bit us before.
 */

export interface FramebufferSnapshot {
	width: number
	height: number
	/** Owned copy. Safe to read across await boundaries. */
	buffer: Buffer
	/** Monotonic sequence at the moment of the snapshot. */
	seq: number
}

export class Framebuffer {
	private _width: number
	private _height: number
	/** RGBA pixel data, 4 bytes per pixel */
	private _buffer: Buffer
	/** Monotonic counter incremented once per applied paint (not per pseudo-encoding). */
	private _updateSeq = 0

	constructor(width: number, height: number) {
		this._width = width
		this._height = height
		this._buffer = Buffer.alloc(width * height * 4)
	}

	get width(): number {
		return this._width
	}

	get height(): number {
		return this._height
	}

	/** Live buffer — racy across await boundaries. Prefer `snapshot()` for reads. */
	get buffer(): Buffer {
		return this._buffer
	}

	/** Monotonic counter, increments each time pixel content changes. Starts at 0. */
	get updateSeq(): number {
		return this._updateSeq
	}

	/** Bump after a pixel-producing operation. Internal. */
	private bump(): void {
		this._updateSeq++
	}

	/** Owned, await-safe snapshot of the current frame. */
	snapshot(): FramebufferSnapshot {
		return {
			width: this._width,
			height: this._height,
			buffer: Buffer.from(this._buffer),
			seq: this._updateSeq,
		}
	}

	/** Apply a RAW-encoded rectangle. Pixels are 4 bytes each (PVE pixel format). */
	applyRaw(x: number, y: number, w: number, h: number, data: Buffer): void {
		const bpp = 4
		const stride = this._width * bpp
		for (let row = 0; row < h; row++) {
			const srcOffset = row * w * bpp
			const dstOffset = (y + row) * stride + x * bpp
			data.copy(this._buffer, dstOffset, srcOffset, srcOffset + w * bpp)
		}
		this.bump()
	}

	/** Apply a CopyRect rectangle: blit from (srcX,srcY) to (dstX,dstY). */
	applyCopyRect(
		dstX: number,
		dstY: number,
		w: number,
		h: number,
		srcX: number,
		srcY: number,
	): void {
		const bpp = 4
		const stride = this._width * bpp

		// Overlapping copies must respect source/dest row order.
		if (srcY < dstY || (srcY === dstY && srcX < dstX)) {
			for (let row = h - 1; row >= 0; row--) {
				const src = (srcY + row) * stride + srcX * bpp
				const dst = (dstY + row) * stride + dstX * bpp
				this._buffer.copy(this._buffer, dst, src, src + w * bpp)
			}
		} else {
			for (let row = 0; row < h; row++) {
				const src = (srcY + row) * stride + srcX * bpp
				const dst = (dstY + row) * stride + dstX * bpp
				this._buffer.copy(this._buffer, dst, src, src + w * bpp)
			}
		}
		this.bump()
	}

	/** Handle DesktopSize pseudo-encoding: resize the framebuffer. */
	resize(newWidth: number, newHeight: number): void {
		this._width = newWidth
		this._height = newHeight
		this._buffer = Buffer.alloc(newWidth * newHeight * 4)
		this.bump()
	}
}
