#!/usr/bin/env bun
// Record OCR text from a VM screen as fast as the OCR worker allows, with
// per-line dedup. Each unique line is logged once with the timestamp of its
// first appearance - useful for catching transient boot logs, kernel panics,
// installer output, anything that flashes by too fast to read live.
//
//   VMID=210 STOP_PATTERN='Not listed|Password' bun skill/references/kvm-record-text.ts
//   VMID=200 MAX_MS=120000 bun skill/references/kvm-record-text.ts
//   VMID=200 STOP_PATTERN='login:' OUT_DIR=/tmp/myrun bun skill/references/kvm-record-text.ts

import pve from '../lib/index.js'
import { mkdir, appendFile, writeFile } from 'node:fs/promises'

const vmid = Number(process.env.VMID)
if (!Number.isInteger(vmid)) {
	console.error('VMID env var is required')
	process.exit(2)
}

const stopPatternStr = process.env.STOP_PATTERN
const stopPattern = stopPatternStr ? new RegExp(stopPatternStr, 'i') : null
const maxMs = Number(process.env.MAX_MS ?? 300_000)
const startVm = process.env.START_VM !== 'false'
const maxInFlight = resolveInFlight()
const saveFinalScreenshot = process.env.SAVE_FINAL_SCREENSHOT === 'true'
const captureIntervalMs = Number(process.env.CAPTURE_INTERVAL_MS ?? 50)

const tsTag = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
const outDir = process.env.OUT_DIR ?? `/tmp/pve-record-${vmid}-${tsTag}`
await mkdir(outDir, { recursive: true })

const transcriptPath = `${outDir}/transcript.txt`
const framesPath = `${outDir}/frames.jsonl`

const vm = pve.use(vmid)
const t0 = Date.now()
const stamp = (ms?: number) => `[+${String(ms ?? Date.now() - t0).padStart(7)}ms]`
const log = (msg: string) => console.log(`${stamp()} ${msg}`)

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const seen = new Set<string>()
let frames = 0
let ocrFrames = 0
let stopReason: 'stop-pattern' | 'maxMs' = 'maxMs'
let lastProgressMs = 0
let nextFrameId = 0

interface PendingFrame {
	id: number
	promise: Promise<FrameOutcome>
}

interface FrameOutcome {
	id: number
	frameMs: number
	screen: Awaited<ReturnType<typeof vm.readScreenIncremental>>
}

try {
	log(`vmid=${vmid} out=${outDir}`)
	log(`stop: ${stopPattern ?? '(maxMs only)'}  maxMs=${maxMs}`)
	log(`ocr-in-flight=${maxInFlight}`)
	log(`capture-interval-ms=${captureIntervalMs}`)

	if (startVm) {
		const status = (await vm.status()).status
		log(`status=${status}`)
		if (status !== 'running') {
			log('start')
			try {
				await vm.start()
			} catch {}
			await vm.waitFor('running', { timeoutMs: 30_000, intervalMs: 500 })
			log('running')
		}
	}

	log('warming OCR worker')
	const deadline = Date.now() + maxMs
	const pending = new Set<PendingFrame>()
	const launch = (frameMs: number) => {
		const id = nextFrameId++
		const promise = vm.readScreenIncremental().then((screen) => ({ id, frameMs, screen }))
		pending.add({ id, promise })
		frames++
	}
	const drainOne = async () => {
		if (pending.size === 0) return
		const out = await Promise.race([...pending].map((p) => p.promise))
		for (const p of pending) {
			if (p.id === out.id) {
				pending.delete(p)
				break
			}
		}
		await recordFrame(out.frameMs, out.screen)
	}

	while (Date.now() < deadline && stopReason === 'maxMs') {
		if (pending.size >= maxInFlight) {
			await drainOne()
			continue
		}
		launch(Date.now() - t0)
		await pve.wait(captureIntervalMs)
	}

	if (stopReason === 'maxMs') log('maxMs reached')
	while (pending.size > 0) await drainOne()

	if (saveFinalScreenshot) await vm.screenshot(`${outDir}/final.jpg`)
	await writeFile(
		`${outDir}/summary.txt`,
		[
			`vmid=${vmid}`,
			`frames=${frames}`,
			`ocr-frames=${ocrFrames}`,
			`unique-lines=${seen.size}`,
			`duration-ms=${Date.now() - t0}`,
			`stop-reason=${stopReason}`,
			`stop-pattern=${stopPatternStr ?? ''}`,
		].join('\n') + '\n',
	)

	log(`done: frames=${frames} unique-lines=${seen.size}`)
	log(`-> ${outDir}`)
} finally {
	await pve.disconnect()
	log('disconnected')
}

async function recordFrame(
	frameMs: number,
	s: Awaited<ReturnType<typeof vm.readScreenIncremental>>,
) {
	if (s.framesSkipped) return
	ocrFrames++

	const newThis: string[] = []
	for (const item of s.items) {
		const line = norm(item.text)
		if (!line || seen.has(line)) continue
		seen.add(line)
		newThis.push(line)
	}
	if (newThis.length) {
		const ts = stamp(frameMs)
		await appendFile(transcriptPath, newThis.map((l) => `${ts} ${l}`).join('\n') + '\n')
	}
	await appendFile(
		framesPath,
		JSON.stringify({
			ms: frameMs,
			itemCount: s.items.length,
			items: s.items.map((item) => ({
				text: item.text,
				box: item.box,
				conf: item.conf,
			})),
			ocrMs: s.ms,
			newLines: newThis.length,
			regionsOcrd: s.regionsOcrd,
			w: s.width,
			h: s.height,
		}) + '\n',
	)

	if (ocrFrames === 1)
		log(`first frame: ${s.width}x${s.height}, ${s.items.length} items, OCR ${s.ms}ms`)
	if (Date.now() - lastProgressMs > 5_000) {
		log(`frame ${frames}, ocr ${ocrFrames}, ${seen.size} unique lines`)
		lastProgressMs = Date.now()
	}

	if (stopPattern && stopPattern.test(s.text)) {
		stopReason = 'stop-pattern'
		log('stop pattern matched')
	}
}

function resolveInFlight(): number {
	const raw = Number(process.env.PVE_RECORD_OCR_IN_FLIGHT ?? process.env.PVE_OCR_WORKERS ?? 2)
	if (!Number.isFinite(raw)) return 2
	return Math.max(1, Math.min(4, Math.floor(raw)))
}
