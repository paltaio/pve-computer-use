import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { parseKeyCombo } from '../rfb.js'
import {
	api,
	sessions,
	resolveTimelineVmid,
	validateCoordinates,
	getOrConnectVncSession,
	typeTextByStrategy,
} from '../state.js'
import { mouseButtonToBit, sleep } from '../helpers.js'

const timelineActionSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('wait'),
		duration_ms: z.number().int().nonnegative().describe('Milliseconds to wait before next step'),
	}),
	z.object({
		type: z.literal('connect'),
		vmid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('VM ID (falls back to timeline vmid/active session)'),
		node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
	}),
	z.object({
		type: z.literal('mouse_click'),
		vmid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('VM ID (falls back to timeline vmid/active session)'),
		node: z.string().optional().describe('Used only when auto-connecting VNC'),
		x: z.number().int().nonnegative(),
		y: z.number().int().nonnegative(),
		button: z.enum(['left', 'right', 'middle']).default('left'),
	}),
	z.object({
		type: z.literal('mouse_move'),
		vmid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('VM ID (falls back to timeline vmid/active session)'),
		node: z.string().optional().describe('Used only when auto-connecting VNC'),
		x: z.number().int().nonnegative(),
		y: z.number().int().nonnegative(),
	}),
	z.object({
		type: z.literal('mouse_down'),
		vmid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('VM ID (falls back to timeline vmid/active session)'),
		node: z.string().optional().describe('Used only when auto-connecting VNC'),
		button: z.enum(['left', 'right', 'middle']).default('left'),
		x: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe('Optional X (uses last pointer position if omitted)'),
		y: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe('Optional Y (uses last pointer position if omitted)'),
	}),
	z.object({
		type: z.literal('mouse_up'),
		vmid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('VM ID (falls back to timeline vmid/active session)'),
		node: z.string().optional().describe('Used only when auto-connecting VNC'),
		button: z.enum(['left', 'right', 'middle', 'all']).default('left'),
		x: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe('Optional X (uses last pointer position if omitted)'),
		y: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe('Optional Y (uses last pointer position if omitted)'),
	}),
	z.object({
		type: z.literal('type_text'),
		vmid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('VM ID (falls back to timeline vmid/active session)'),
		node: z.string().optional().describe('Used only when auto-connecting VNC'),
		text: z.string().min(1),
		keyboard_layout: z
			.enum(['en-US', 'es-ES'])
			.default('en-US')
			.describe('Keyboard layout for deterministic text typing'),
		delay_ms: z
			.number()
			.int()
			.nonnegative()
			.default(8)
			.describe('Delay between characters in milliseconds'),
		text_strategy: z
			.enum(['auto', 'clipboard', 'vnc_keys'])
			.default('auto')
			.describe('Text input strategy'),
	}),
	z.object({
		type: z.literal('press_key'),
		vmid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('VM ID (falls back to timeline vmid/active session)'),
		node: z.string().optional().describe('Used only when auto-connecting VNC'),
		key: z.string().min(1),
	}),
	z.object({
		type: z.literal('key_down'),
		vmid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('VM ID (falls back to timeline vmid/active session)'),
		node: z.string().optional().describe('Used only when auto-connecting VNC'),
		key: z.string().min(1).describe('Key or combo (e.g. "shift", "ctrl", "a", "ctrl+shift")'),
	}),
	z.object({
		type: z.literal('key_up'),
		vmid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('VM ID (falls back to timeline vmid/active session)'),
		node: z.string().optional().describe('Used only when auto-connecting VNC'),
		key: z.string().min(1).describe('Key or combo (e.g. "shift", "ctrl", "a", "ctrl+shift")'),
	}),
	z.object({
		type: z.literal('drag'),
		vmid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('VM ID (falls back to timeline vmid/active session)'),
		node: z.string().optional().describe('Used only when auto-connecting VNC'),
		from_x: z.number().int().nonnegative(),
		from_y: z.number().int().nonnegative(),
		to_x: z.number().int().nonnegative(),
		to_y: z.number().int().nonnegative(),
		steps: z.number().int().positive().default(20),
		duration_ms: z.number().int().positive().default(500),
		easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']).default('ease-in-out'),
		hold_start_ms: z
			.number()
			.int()
			.nonnegative()
			.default(50)
			.describe('Pause after move+press before drag interpolation'),
		hold_end_ms: z
			.number()
			.int()
			.nonnegative()
			.default(50)
			.describe('Pause before releasing button at end of drag'),
	}),
	z.object({
		type: z.literal('scroll'),
		vmid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('VM ID (falls back to timeline vmid/active session)'),
		node: z.string().optional().describe('Used only when auto-connecting VNC'),
		x: z.number().int().nonnegative(),
		y: z.number().int().nonnegative(),
		direction: z.enum(['up', 'down']),
		amount: z.number().int().positive().default(3),
	}),
	z.object({
		type: z.literal('exec_command'),
		vmid: z.number().int().positive().optional().describe('VM ID (falls back to timeline vmid)'),
		node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
		command: z.string().min(1),
		args: z.array(z.string()).optional(),
		timeout_ms: z
			.number()
			.int()
			.positive()
			.default(30_000)
			.describe('Command timeout in milliseconds'),
	}),
])

const timelineStepSchema = z.object({
	at_ms: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe('Optional absolute offset from timeline start in milliseconds'),
	action: timelineActionSchema,
})

export function registerTimelineTool(server: McpServer): void {
	server.registerTool(
		'timeline',
		{
			title: 'Run Timeline',
			description: 'Execute a sequence of scheduled actions (KVM + guest-agent) in one call.',
			inputSchema: {
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('Default VM ID for steps that omit vmid.'),
				continue_on_error: z
					.boolean()
					.default(false)
					.describe('Continue executing remaining steps after an error.'),
				release_inputs_at_end: z
					.boolean()
					.default(true)
					.describe('Release held mouse buttons/keys at timeline end (recommended).'),
				steps: z
					.array(timelineStepSchema)
					.min(1)
					.describe('Timeline steps. Use at_ms for absolute scheduling from start.'),
			},
		},
		async ({ vmid, continue_on_error, release_inputs_at_end, steps }) => {
			const startedAt = Date.now()
			const logs: string[] = []
			let successCount = 0
			let failedCount = 0
			let aborted = false
			const pointerMaskByVm = new Map<number, number>()
			const pointerPosByVm = new Map<number, { x: number; y: number }>()
			const heldKeysByVm = new Map<number, Set<number>>()

			for (let i = 0; i < steps.length; i++) {
				const step = steps[i]
				const stepNo = i + 1

				if (step.at_ms !== undefined) {
					const elapsed = Date.now() - startedAt
					const delay = step.at_ms - elapsed
					if (delay > 0) await sleep(delay)
				}

				try {
					const action = step.action
					let message: string

					switch (action.type) {
						case 'wait': {
							await sleep(action.duration_ms)
							message = `waited ${action.duration_ms}ms`
							break
						}
						case 'connect': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							await getOrConnectVncSession(id, action.node)
							message = `connected VNC session for VM ${id}`
							break
						}
						case 'mouse_click': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							const session = await getOrConnectVncSession(id, action.node)
							const fb = session.screen
							if (!fb) throw new Error('Framebuffer not ready')
							const warnings = validateCoordinates(id, [{ x: action.x, y: action.y }], fb)
							const currentMask = pointerMaskByVm.get(id) ?? 0
							const buttonBit = mouseButtonToBit(action.button)
							const downMask = currentMask | buttonBit
							session.sendPointerEvent(currentMask, action.x, action.y)
							session.sendPointerEvent(downMask, action.x, action.y)
							session.sendPointerEvent(currentMask, action.x, action.y)
							pointerPosByVm.set(id, { x: action.x, y: action.y })
							message = `${warnings.length ? `${warnings.join(' | ')} | ` : ''}clicked ${action.button} at (${action.x}, ${action.y})`
							break
						}
						case 'mouse_move': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							const session = await getOrConnectVncSession(id, action.node)
							const fb = session.screen
							if (!fb) throw new Error('Framebuffer not ready')
							const warnings = validateCoordinates(id, [{ x: action.x, y: action.y }], fb)
							const currentMask = pointerMaskByVm.get(id) ?? 0
							session.sendPointerEvent(currentMask, action.x, action.y)
							pointerPosByVm.set(id, { x: action.x, y: action.y })
							message = `${warnings.length ? `${warnings.join(' | ')} | ` : ''}moved mouse to (${action.x}, ${action.y})`
							break
						}
						case 'mouse_down': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							const session = await getOrConnectVncSession(id, action.node)
							const fb = session.screen
							if (!fb) throw new Error('Framebuffer not ready')
							const currentMask = pointerMaskByVm.get(id) ?? 0
							const lastPos = pointerPosByVm.get(id)
							const x = action.x ?? lastPos?.x
							const y = action.y ?? lastPos?.y
							if (x === undefined || y === undefined) {
								throw new Error(
									'mouse_down requires x/y or a previous mouse position in the same timeline',
								)
							}
							const warnings = validateCoordinates(id, [{ x, y }], fb)
							const newMask = currentMask | mouseButtonToBit(action.button)
							session.sendPointerEvent(newMask, x, y)
							pointerMaskByVm.set(id, newMask)
							pointerPosByVm.set(id, { x, y })
							message = `${warnings.length ? `${warnings.join(' | ')} | ` : ''}mouse down ${action.button} at (${x}, ${y})`
							break
						}
						case 'mouse_up': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							const session = await getOrConnectVncSession(id, action.node)
							const fb = session.screen
							if (!fb) throw new Error('Framebuffer not ready')
							const currentMask = pointerMaskByVm.get(id) ?? 0
							const lastPos = pointerPosByVm.get(id)
							const x = action.x ?? lastPos?.x
							const y = action.y ?? lastPos?.y
							if (x === undefined || y === undefined) {
								throw new Error(
									'mouse_up requires x/y or a previous mouse position in the same timeline',
								)
							}
							const warnings = validateCoordinates(id, [{ x, y }], fb)
							const newMask =
								action.button === 'all' ? 0 : currentMask & ~mouseButtonToBit(action.button)
							session.sendPointerEvent(newMask, x, y)
							pointerMaskByVm.set(id, newMask)
							pointerPosByVm.set(id, { x, y })
							message = `${warnings.length ? `${warnings.join(' | ')} | ` : ''}mouse up ${action.button} at (${x}, ${y})`
							break
						}
						case 'type_text': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							const session = await getOrConnectVncSession(id, action.node)
							const backend = await typeTextByStrategy(
								id,
								session,
								action.text,
								action.keyboard_layout,
								action.delay_ms,
								action.text_strategy,
							)
							message = `typed ${action.text.length} character(s) via ${backend}`
							break
						}
						case 'press_key': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							const session = await getOrConnectVncSession(id, action.node)
							session.pressKey(action.key)
							message = `pressed key: ${action.key}`
							break
						}
						case 'key_down': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							const session = await getOrConnectVncSession(id, action.node)
							const keysyms = parseKeyCombo(action.key)
							for (const keysym of keysyms) session.sendKeyEvent(true, keysym)
							let held = heldKeysByVm.get(id)
							if (!held) {
								held = new Set<number>()
								heldKeysByVm.set(id, held)
							}
							for (const keysym of keysyms) held.add(keysym)
							message = `key down: ${action.key}`
							break
						}
						case 'key_up': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							const session = await getOrConnectVncSession(id, action.node)
							const keysyms = parseKeyCombo(action.key)
							for (let j = keysyms.length - 1; j >= 0; j--) session.sendKeyEvent(false, keysyms[j])
							const held = heldKeysByVm.get(id)
							if (held) {
								for (const keysym of keysyms) held.delete(keysym)
							}
							message = `key up: ${action.key}`
							break
						}
						case 'drag': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							const session = await getOrConnectVncSession(id, action.node)
							const fb = session.screen
							if (!fb) throw new Error('Framebuffer not ready')
							const warnings = validateCoordinates(
								id,
								[
									{ x: action.from_x, y: action.from_y },
									{ x: action.to_x, y: action.to_y },
								],
								fb,
							)
							await session.drag(
								action.from_x,
								action.from_y,
								action.to_x,
								action.to_y,
								action.steps,
								action.duration_ms,
								action.easing,
								action.hold_start_ms,
								action.hold_end_ms,
							)
							pointerPosByVm.set(id, { x: action.to_x, y: action.to_y })
							pointerMaskByVm.set(id, 0)
							message = `${warnings.length ? `${warnings.join(' | ')} | ` : ''}dragged (${action.from_x},${action.from_y})->(${action.to_x},${action.to_y})`
							break
						}
						case 'scroll': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							const session = await getOrConnectVncSession(id, action.node)
							const fb = session.screen
							if (!fb) throw new Error('Framebuffer not ready')
							const warnings = validateCoordinates(id, [{ x: action.x, y: action.y }], fb)
							const currentMask = pointerMaskByVm.get(id) ?? 0
							const wheelBit = action.direction === 'up' ? 8 : 16
							for (let w = 0; w < action.amount; w++) {
								session.sendPointerEvent(currentMask | wheelBit, action.x, action.y)
								session.sendPointerEvent(currentMask, action.x, action.y)
							}
							pointerPosByVm.set(id, { x: action.x, y: action.y })
							message = `${warnings.length ? `${warnings.join(' | ')} | ` : ''}scrolled ${action.direction} x${action.amount} at (${action.x}, ${action.y})`
							break
						}
						case 'exec_command': {
							const id = resolveTimelineVmid(action.vmid, vmid)
							const resolvedNode = action.node ?? (await api.findVmNode(id))
							const result = await api.guestExec(
								resolvedNode,
								id,
								action.command,
								action.args,
								action.timeout_ms,
							)
							message = `exec (${action.command}) exit=${result.exitcode}`
							break
						}
					}

					successCount++
					logs.push(`[${Date.now() - startedAt}ms] step ${stepNo} OK: ${message}`)
				} catch (err) {
					failedCount++
					const msg = err instanceof Error ? err.message : String(err)
					logs.push(`[${Date.now() - startedAt}ms] step ${stepNo} ERROR: ${msg}`)
					if (!continue_on_error) {
						aborted = true
						break
					}
				}
			}

			if (release_inputs_at_end) {
				for (const [id, mask] of pointerMaskByVm) {
					if (mask !== 0) {
						const session = sessions.getSession(id)
						if (session?.connected) {
							const pos = pointerPosByVm.get(id) ?? { x: 0, y: 0 }
							session.sendPointerEvent(0, pos.x, pos.y)
						}
					}
				}
				for (const [id, held] of heldKeysByVm) {
					if (held.size > 0) {
						const session = sessions.getSession(id)
						if (session?.connected) {
							const toRelease = Array.from(held.values())
							for (let i = toRelease.length - 1; i >= 0; i--) {
								session.sendKeyEvent(false, toRelease[i])
							}
						}
					}
				}
			}

			const status = aborted ? 'aborted' : 'completed'
			return {
				content: [
					{
						type: 'text' as const,
						text: `Timeline ${status}: ${successCount} succeeded, ${failedCount} failed, total=${steps.length}\n${logs.join('\n')}`,
					},
				],
			}
		},
	)
}
