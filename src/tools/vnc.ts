import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'

import { captureScreenshot } from '../screenshot.js'
import {
	sessions,
	resolveVmid,
	setActiveVmid,
	activeVmid,
	lastScreenSize,
	validateCoordinates,
	typeTextByStrategy,
} from '../state.js'

export function registerVncTools(server: McpServer): void {
	server.registerTool(
		'connect',
		{
			title: 'Connect to VM',
			description:
				"Connect to a Proxmox VE virtual machine's display via VNC. Must be called before other tools.",
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID (e.g. 100)'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, node }) => {
			const session = await sessions.connect(vmid, node)
			const fb = session.screen
			setActiveVmid(vmid)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Connected to VM ${vmid} on node ${session.node}. Screen size: ${fb?.width}x${fb?.height}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'screenshot',
		{
			title: 'Screenshot',
			description: "Capture a screenshot of the VM's current display. Returns a JPEG image.",
			inputSchema: {
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active session if omitted.'),
				save_path: z
					.string()
					.optional()
					.describe('Optional host path to save the JPEG file (e.g. /tmp/vm-500.jpg).'),
			},
		},
		async ({ vmid, save_path }) => {
			const id = resolveVmid(vmid)
			const session = sessions.getConnectedSession(id)

			session.requestFullUpdate()
			await session.waitForUpdate(3000)

			const fb = session.screen
			if (!fb) throw new Error('Framebuffer not ready')

			const screenshot = await captureScreenshot(fb)
			lastScreenSize.set(id, { width: screenshot.width, height: screenshot.height })
			const jpegBuffer = Buffer.from(screenshot.data, 'base64')

			let saveText: string | null = null
			if (save_path) {
				const targetPath = resolvePath(save_path)
				await mkdir(dirname(targetPath), { recursive: true })
				await writeFile(targetPath, jpegBuffer)
				saveText = `Saved: ${targetPath}`
			}

			return {
				content: [
					{
						type: 'image' as const,
						data: screenshot.data,
						mimeType: 'image/jpeg' as const,
					},
					{
						type: 'text' as const,
						text: saveText
							? `Screenshot: ${screenshot.width}x${screenshot.height}\n${saveText}`
							: `Screenshot: ${screenshot.width}x${screenshot.height}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'mouse_click',
		{
			title: 'Mouse Click',
			description: 'Click at a position on the VM screen. Coordinates are in screen pixels.',
			inputSchema: {
				x: z.number().int().nonnegative().describe('X coordinate on screen'),
				y: z.number().int().nonnegative().describe('Y coordinate on screen'),
				button: z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'),
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active session if omitted.'),
			},
		},
		async ({ x, y, button, vmid }) => {
			const id = resolveVmid(vmid)
			const session = sessions.getConnectedSession(id)
			const fb = session.screen
			if (!fb) throw new Error('Framebuffer not ready')

			const warnings = validateCoordinates(id, [{ x, y }], fb)
			session.click(x, y, button)

			const text = `Clicked ${button} at (${x}, ${y})`
			return {
				content: [
					{
						type: 'text' as const,
						text: warnings.length ? `${warnings.join('\n')}\n${text}` : text,
					},
				],
			}
		},
	)

	server.registerTool(
		'mouse_move',
		{
			title: 'Mouse Move',
			description: 'Move the mouse cursor to a position on the VM screen without clicking.',
			inputSchema: {
				x: z.number().int().nonnegative().describe('X coordinate on screen'),
				y: z.number().int().nonnegative().describe('Y coordinate on screen'),
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active session if omitted.'),
			},
		},
		async ({ x, y, vmid }) => {
			const id = resolveVmid(vmid)
			const session = sessions.getConnectedSession(id)
			const fb = session.screen
			if (!fb) throw new Error('Framebuffer not ready')

			const warnings = validateCoordinates(id, [{ x, y }], fb)
			session.sendPointerEvent(0, x, y)

			const text = `Moved mouse to (${x}, ${y})`
			return {
				content: [
					{
						type: 'text' as const,
						text: warnings.length ? `${warnings.join('\n')}\n${text}` : text,
					},
				],
			}
		},
	)

	server.registerTool(
		'type_text',
		{
			title: 'Type Text',
			description:
				'Type text into the VM using an intent-based strategy (auto/clipboard/vnc_keys).',
			inputSchema: {
				text: z.string().min(1).describe('Text to type'),
				keyboard_layout: z
					.enum(['en-US', 'es-ES'])
					.default('en-US')
					.describe('Keyboard layout for deterministic text typing'),
				delay_ms: z
					.number()
					.int()
					.nonnegative()
					.default(8)
					.describe('Delay between characters in milliseconds for app-side reliability'),
				text_strategy: z
					.enum(['auto', 'clipboard', 'vnc_keys'])
					.default('auto')
					.describe('Text input strategy'),
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active session if omitted.'),
			},
		},
		async ({ text, keyboard_layout, delay_ms, text_strategy, vmid }) => {
			const id = resolveVmid(vmid)
			const session = sessions.getConnectedSession(id)
			const backend = await typeTextByStrategy(
				id,
				session,
				text,
				keyboard_layout,
				delay_ms,
				text_strategy,
			)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Typed ${text.length} character(s) via ${backend}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'press_key',
		{
			title: 'Press Key',
			description:
				'Press a key or key combination. Examples: "Return", "ctrl+c", "alt+tab", "shift+a", "F5", "Escape"',
			inputSchema: {
				key: z.string().min(1).describe('Key or combo (e.g. "Return", "ctrl+c", "alt+tab")'),
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active session if omitted.'),
			},
		},
		async ({ key, vmid }) => {
			const id = resolveVmid(vmid)
			const session = sessions.getConnectedSession(id)
			session.pressKey(key)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Pressed key: ${key}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'drag',
		{
			title: 'Drag',
			description: 'Drag from one position to another on the VM screen with animated easing.',
			inputSchema: {
				from_x: z.number().int().nonnegative().describe('Start X on screen'),
				from_y: z.number().int().nonnegative().describe('Start Y on screen'),
				to_x: z.number().int().nonnegative().describe('End X on screen'),
				to_y: z.number().int().nonnegative().describe('End Y on screen'),
				steps: z
					.number()
					.int()
					.positive()
					.default(20)
					.describe('Intermediate pointer steps (default 20)'),
				duration_ms: z
					.number()
					.int()
					.positive()
					.default(500)
					.describe('Total drag duration in ms (default 500)'),
				easing: z
					.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out'])
					.default('ease-in-out')
					.describe('Easing curve (default ease-in-out)'),
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
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active session if omitted.'),
			},
		},
		async ({
			from_x,
			from_y,
			to_x,
			to_y,
			steps,
			duration_ms,
			easing,
			hold_start_ms,
			hold_end_ms,
			vmid,
		}) => {
			const id = resolveVmid(vmid)
			const session = sessions.getConnectedSession(id)
			const fb = session.screen
			if (!fb) throw new Error('Framebuffer not ready')

			const warnings = validateCoordinates(
				id,
				[
					{ x: from_x, y: from_y },
					{ x: to_x, y: to_y },
				],
				fb,
			)
			await session.drag(
				from_x,
				from_y,
				to_x,
				to_y,
				steps,
				duration_ms,
				easing,
				hold_start_ms,
				hold_end_ms,
			)

			const text = `Dragged from (${from_x}, ${from_y}) to (${to_x}, ${to_y}) [${steps} steps, ${duration_ms}ms, ${easing}, hold_start=${hold_start_ms}ms, hold_end=${hold_end_ms}ms]`
			return {
				content: [
					{
						type: 'text' as const,
						text: warnings.length ? `${warnings.join('\n')}\n${text}` : text,
					},
				],
			}
		},
	)

	server.registerTool(
		'scroll',
		{
			title: 'Scroll',
			description: 'Scroll the mouse wheel at a position on the VM screen.',
			inputSchema: {
				x: z.number().int().nonnegative().describe('X coordinate on screen'),
				y: z.number().int().nonnegative().describe('Y coordinate on screen'),
				direction: z.enum(['up', 'down']).describe('Scroll direction'),
				amount: z.number().int().positive().default(3).describe('Number of scroll clicks'),
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active session if omitted.'),
			},
		},
		async ({ x, y, direction, amount, vmid }) => {
			const id = resolveVmid(vmid)
			const session = sessions.getConnectedSession(id)
			const fb = session.screen
			if (!fb) throw new Error('Framebuffer not ready')

			const warnings = validateCoordinates(id, [{ x, y }], fb)
			session.scroll(x, y, direction, amount)

			const text = `Scrolled ${direction} ${amount} clicks at (${x}, ${y})`
			return {
				content: [
					{
						type: 'text' as const,
						text: warnings.length ? `${warnings.join('\n')}\n${text}` : text,
					},
				],
			}
		},
	)

	server.registerTool(
		'get_screen_size',
		{
			title: 'Get Screen Size',
			description: 'Get the current screen dimensions of the VM.',
			inputSchema: {
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active session if omitted.'),
			},
		},
		async ({ vmid }) => {
			const id = resolveVmid(vmid)
			const session = sessions.getConnectedSession(id)
			const fb = session.screen
			if (!fb) throw new Error('Framebuffer not ready')

			return {
				content: [
					{
						type: 'text' as const,
						text: `Screen size: ${fb.width}x${fb.height}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'disconnect',
		{
			title: 'Disconnect from VM',
			description: 'Disconnect the VNC session for a VM.',
			inputSchema: {
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active session if omitted.'),
			},
		},
		async ({ vmid }) => {
			const id = resolveVmid(vmid)
			sessions.disconnect(id)
			if (activeVmid === id) setActiveVmid(null)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Disconnected from VM ${id}`,
					},
				],
			}
		},
	)
}
