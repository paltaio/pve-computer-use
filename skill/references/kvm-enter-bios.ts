#!/usr/bin/env bun
// Reset a VM, spam a key during POST, and land in UEFI/BIOS setup.
//
// In Proxmox OVMF, F2 opens the boot device menu rather than setup directly;
// from there, the last entry "EFI Firmware Setup" gets you in. This script
// auto-navigates that menu when it appears.
//
//   VMID=200 bun skill/references/kvm-enter-bios.ts
//   VMID=200 KEY=esc bun skill/references/kvm-enter-bios.ts
//   VMID=200 KEY=del DURATION_MS=10000 bun skill/references/kvm-enter-bios.ts

import pve, { act } from '../lib/index.js'
import type { ScreenMatchResult } from '../../src/screen-match.js'

const vmid = Number(process.env.VMID)
if (!Number.isInteger(vmid)) {
	console.error('VMID env var is required')
	process.exit(2)
}

const key = process.env.KEY ?? 'f2'
const maxMs = Number(process.env.MAX_MS ?? 30_000)
const ratePerSec = Number(process.env.RATE_PER_SEC ?? 20)
// Pre-spam delay: VNC handshake fails if we touch the session during the
// stop/start blip, so wait briefly for the start to settle.
const settleMs = Number(process.env.SETTLE_MS ?? 500)
const detectPattern = /select boot device|EFI Firmware Setup|Device Manager/i

type Winner = { kind: 'spam-ended' } | { kind: 'matched'; result: ScreenMatchResult }

const vm = pve.use(vmid)
const t0 = Date.now()
const log = (msg: string) => console.log(`[+${String(Date.now() - t0).padStart(5)}ms] ${msg}`)

try {
	log(`vmid=${vmid} key=${key} maxMs=${maxMs} rate=${ratePerSec}/s settle=${settleMs}ms`)

	log('reset: stop+start')
	try {
		await vm.reset()
	} catch {}

	log('waitFor running...')
	await vm.waitFor('running', { timeoutMs: 30_000, intervalMs: 500 })
	log('running')

	await pve.wait(settleMs)

	log(`race: spam '${key}' @${ratePerSec}/s  vs  waitForScreen(${detectPattern})`)
	let pressCount = 0
	const winner = await pve.race<Winner>([
		async (signal) => {
			await vm.repeat(
				act.exec(async () => {
					await vm.kvm.press(key)
					pressCount++
				}),
				{ ratePerSec, durationMs: maxMs, signal },
			)
			return { kind: 'spam-ended' }
		},
		async (signal) => {
			const result = await vm.waitForScreen({
				text: detectPattern,
				timeoutMs: maxMs,
				intervalMs: 400,
				signal,
			})
			return { kind: 'matched', result }
		},
	])
	log(`race resolved: ${winner.kind} after ${pressCount} presses`)

	if (winner.kind === 'spam-ended') {
		log('spam window elapsed without detecting boot menu / setup')
	} else {
		const r = winner.result
		const hit = r.matchedItem?.text ?? ''
		log(`matched: "${hit.slice(0, 80)}"`)
		if (/select boot device/i.test(hit) || /select boot device/i.test(r.text ?? '')) {
			// Re-read so we get the full menu, not just the header line.
			const screen = await vm.readScreen()
			const items = screen.items
				.filter((i) => i.box[0][0] > 100 && i.box[0][0] < screen.width - 100)
				.sort((a, b) => a.box[0][1] - b.box[0][1])
			const headerIdx = items.findIndex((i) => /select boot device/i.test(i.text))
			const setupIdx = items.findIndex((i) => /EFI Firmware Setup/i.test(i.text))
			log(`menu items: header@${headerIdx} setup@${setupIdx}`)
			if (headerIdx >= 0 && setupIdx > headerIdx) {
				const steps = setupIdx - headerIdx - 1
				log(`navigate: down x${steps} + enter`)
				for (let n = 0; n < steps; n++) await vm.kvm.press('down')
				await vm.kvm.press('enter')
				await pve.wait(2_000)
			} else {
				log('setup entry not found; stopping at boot menu')
			}
		} else {
			log('already in setup, nothing to navigate')
		}
	}
} finally {
	await pve.disconnect()
	log('disconnected')
}
