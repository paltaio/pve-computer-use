#!/usr/bin/env bun
// Wait for the Windows 10/11 lock/login screen and sign in with a password.
// Handles both the lock-screen-first layout (clock then password field) and
// direct login. Assumes the target user is the default focused account on the
// login screen; if multiple users are listed, click the right tile first.
//
//   VMID=204 WIN_PASSWORD=... bun skill/references/kvm-windows-login.ts
//   VMID=204 WIN_USER=admin WIN_PASSWORD=... bun skill/references/kvm-windows-login.ts

import pve from '../lib/index.js'

const vmid = Number(process.env.VMID)
const user = process.env.WIN_USER ?? 'iot'
const password = process.env.WIN_PASSWORD
if (!Number.isInteger(vmid) || !password) {
	console.error('VMID and WIN_PASSWORD env vars are required')
	process.exit(2)
}

const vm = pve.use(vmid)
const t0 = Date.now()
const log = (msg: string) => console.log(`[+${String(Date.now() - t0).padStart(5)}ms] ${msg}`)

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

	log('readScreen: check current state')
	const initial = await vm.readScreen()
	const hasLoginText = /Password|Sign in|Other user/i.test(initial.text)
	// Lock/login screens are sparse (clock+date, or username+password field).
	// Desktops show taskbar app names, desktop icons, tray clock - many items.
	const looksLikeDesktop = !hasLoginText && initial.items.length >= 5
	log(
		`items=${initial.items.length} hasLoginText=${hasLoginText} -> ${looksLikeDesktop ? 'desktop' : 'lock-or-login'}`,
	)

	if (looksLikeDesktop) {
		log('already unlocked, nothing to do')
	} else {
		log('poll: wait for lock or login screen')
		const loginDeadline = Date.now() + 180_000
		let dismissed = false
		let reachedLogin = false
		while (Date.now() < loginDeadline) {
			const s = await vm.readScreen()
			if (/Password|Sign in|Other user/i.test(s.text)) {
				log(`login screen ready (items=${s.items.length})`)
				reachedLogin = true
				break
			}
			const looksLikeLock =
				s.items.length >= 1 && s.items.length <= 3 && /\d{1,2}:\d{2}/.test(s.text)
			if (looksLikeLock && !dismissed) {
				log('lock screen detected; dismiss with space')
				await vm.kvm.press('space')
				dismissed = true
			}
			await pve.wait(1_500)
		}
		if (!reachedLogin) throw new Error('login screen did not appear within 180s')

		log(`type password (${password.length} chars, vnc strategy)`)
		await vm.kvm.type(password, { strategy: 'vnc' })
		log('press enter')
		await vm.kvm.press('enter')

		log('wait for desktop or password-error')
		const deadline = Date.now() + 30_000
		let outcome: 'desktop' | 'error' | 'timeout' = 'timeout'
		while (Date.now() < deadline) {
			await pve.wait(1_000)
			const s = await vm.readScreen()
			if (/incorrect|try again/i.test(s.text)) {
				outcome = 'error'
				break
			}
			if (!/Password|Sign in/i.test(s.text) && s.items.length >= 5) {
				outcome = 'desktop'
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
