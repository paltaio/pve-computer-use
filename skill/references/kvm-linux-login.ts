#!/usr/bin/env bun
// Wait for the Debian GNOME / GDM greeter and sign in with a password.
// Handles the user-select stage (Enter on focused tile) and the password
// stage. Uses qemu-guest-agent loginctl as the authoritative signal for
// "already logged in" / "login succeeded".
//
//   VMID=210 LINUX_PASSWORD=... bun skill/references/kvm-linux-login.ts
//   VMID=210 LINUX_USER=alice LINUX_PASSWORD=... bun skill/references/kvm-linux-login.ts

import pve from '../lib/index.js'

const vmid = Number(process.env.VMID)
const user = process.env.LINUX_USER ?? 'debian'
const password = process.env.LINUX_PASSWORD
if (!Number.isInteger(vmid) || !password) {
	console.error('VMID and LINUX_PASSWORD env vars are required')
	process.exit(2)
}

const vm = pve.use(vmid)
const t0 = Date.now()
const log = (msg: string) => console.log(`[+${String(Date.now() - t0).padStart(5)}ms] ${msg}`)

async function getActiveSession(target: string): Promise<string | null> {
	try {
		const r = await vm.guest.exec('loginctl', ['list-sessions', '--no-legend'])
		if (r.exitcode !== 0) return null
		// Columns: SESSION UID USER SEAT LEADER CLASS TTY IDLE SINCE
		for (const line of r.stdout.split('\n')) {
			const parts = line.trim().split(/\s+/)
			if (parts.length < 6) continue
			const [sid, , u, seat, , klass] = parts
			if (u === target && seat === 'seat0' && klass === 'user') return sid
		}
		return null
	} catch {
		return null
	}
}

async function isLocked(sid: string): Promise<boolean> {
	try {
		const r = await vm.guest.exec('loginctl', [
			'show-session',
			sid,
			'--property=LockedHint',
			'--value',
		])
		return r.stdout.trim() === 'yes'
	} catch {
		return false
	}
}

try {
	log(`vmid=${vmid} user=${user}`)

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

	log('check active session via guest-agent')
	const sid = await getActiveSession(user)
	const locked = sid ? await isLocked(sid) : false
	log(`session=${sid ?? 'none'} locked=${locked}`)

	if (sid && !locked) {
		log(`${user} already has active graphical session, nothing to do`)
	} else if (sid && locked) {
		log('wake lock screen')
		await vm.kvm.press('escape')
		log('waitForScreen: password field')
		await vm.waitForScreen({
			text: /Password|Enter password/i,
			timeoutMs: 30_000,
			intervalMs: 400,
		})
		log(`type password (${password.length} chars, vnc strategy)`)
		await vm.kvm.type(password, { strategy: 'vnc' })
		log('press enter')
		await vm.kvm.press('enter')

		log('wait for unlock or auth-error')
		const deadline = Date.now() + 30_000
		let outcome: 'unlocked' | 'error' | 'timeout' = 'timeout'
		while (Date.now() < deadline) {
			await pve.wait(1_500)
			if (!(await isLocked(sid))) {
				outcome = 'unlocked'
				break
			}
			const s = await vm.readScreen()
			if (/didn.?t work|authentication failed|try again|incorrect/i.test(s.text)) {
				outcome = 'error'
				break
			}
		}
		log(`outcome: ${outcome}`)
		if (outcome !== 'unlocked') process.exitCode = 1
	} else {
		const userEsc = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		log('waitForScreen: GDM greeter (user list or password prompt)')
		const first = await vm.waitForScreen({
			text: /Password|Not listed/i,
			timeoutMs: 180_000,
			intervalMs: 1000,
		})
		const matched = first.matchedItem!.text
		log(`matched: "${matched.slice(0, 60)}"`)

		if (!/Password/i.test(matched)) {
			const screen = await vm.readScreen()
			const tile = screen.items.find((i) => new RegExp(`^${userEsc}$`, 'i').test(i.text.trim()))
			if (tile) {
				const [[x1, y1], , [x2, y2]] = tile.box
				log(`click user tile "${user}" at center`)
				await vm.kvm.click((x1 + x2) >> 1, (y1 + y2) >> 1)
			} else {
				log('user tile not found by name; pressing enter on focused tile')
				await vm.kvm.press('enter')
			}
			log('waitForScreen: password field')
			const second = await vm.waitForScreen({
				text: /Password/i,
				timeoutMs: 15_000,
				intervalMs: 400,
			})
			log(`password field: "${second.matchedItem?.text.slice(0, 60)}"`)
		}

		log(`type password (${password.length} chars, vnc strategy)`)
		await vm.kvm.type(password, { strategy: 'vnc' })
		log('press enter')
		await vm.kvm.press('enter')

		log('wait for active session or auth-error')
		const deadline = Date.now() + 30_000
		let outcome: 'desktop' | 'error' | 'timeout' = 'timeout'
		while (Date.now() < deadline) {
			await pve.wait(1_500)
			if (await getActiveSession(user)) {
				outcome = 'desktop'
				break
			}
			const s = await vm.readScreen()
			if (/didn.?t work|authentication failed|try again/i.test(s.text)) {
				outcome = 'error'
				break
			}
		}
		log(`outcome: ${outcome}`)
		if (outcome !== 'desktop') process.exitCode = 1
	}
} finally {
	await pve.disconnect()
	log('disconnected')
}
