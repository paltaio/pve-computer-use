import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { termSessions, resolveTermVmid, activeTermVmid, setActiveTermVmid } from '../state.js'

export function registerSerialTools(server: McpServer): void {
	server.registerTool(
		'serial_connect',
		{
			title: 'Connect to Serial Console',
			description:
				"Connect to a VM's serial console (text terminal). For headless VMs, servers, or text-based environments. Requires VM.Console privilege.",
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID (e.g. 100)'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
				cols: z.number().int().positive().default(80).describe('Terminal columns (default 80)'),
				rows: z.number().int().positive().default(24).describe('Terminal rows (default 24)'),
			},
		},
		async ({ vmid, node, cols, rows }) => {
			const session = await termSessions.connect(vmid, node, cols, rows)
			setActiveTermVmid(vmid)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Connected to serial console on VM ${vmid} (node ${session.node}, ${cols}x${rows})`,
					},
				],
			}
		},
	)

	server.registerTool(
		'serial_read',
		{
			title: 'Read Serial Console',
			description:
				'Read the current terminal screen as plain text. Returns what a human would see on the console.',
			inputSchema: {
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active terminal session if omitted.'),
			},
		},
		async ({ vmid }) => {
			const id = resolveTermVmid(vmid)
			const session = termSessions.getConnectedSession(id)

			await session.waitForData(500)
			const screen = session.getScreen()

			return {
				content: [
					{
						type: 'text' as const,
						text: screen || '(empty screen)',
					},
				],
			}
		},
	)

	server.registerTool(
		'serial_send',
		{
			title: 'Send Text to Serial Console',
			description:
				'Send text input to the serial console. Use \\n for newline to execute commands.',
			inputSchema: {
				text: z.string().min(1).describe('Text to send (e.g. "ls -la\\n")'),
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active terminal session if omitted.'),
			},
		},
		async ({ text, vmid }) => {
			const id = resolveTermVmid(vmid)
			const session = termSessions.getConnectedSession(id)
			session.sendInput(text)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Sent ${text.length} character(s) to VM ${id} serial console`,
					},
				],
			}
		},
	)

	server.registerTool(
		'serial_key',
		{
			title: 'Send Key to Serial Console',
			description:
				'Send a key or key combination to the serial console. Examples: "enter", "ctrl+c", "ctrl+d", "up", "tab", "f1", "escape"',
			inputSchema: {
				key: z.string().min(1).describe('Key or combo (e.g. "enter", "ctrl+c", "up", "f5")'),
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active terminal session if omitted.'),
			},
		},
		async ({ key, vmid }) => {
			const id = resolveTermVmid(vmid)
			const session = termSessions.getConnectedSession(id)
			session.sendKey(key)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Sent key: ${key}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'serial_resize',
		{
			title: 'Resize Serial Console',
			description: 'Resize the terminal dimensions. Affects how screen content is laid out.',
			inputSchema: {
				cols: z.number().int().positive().describe('New column count'),
				rows: z.number().int().positive().describe('New row count'),
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active terminal session if omitted.'),
			},
		},
		async ({ cols, rows, vmid }) => {
			const id = resolveTermVmid(vmid)
			const session = termSessions.getConnectedSession(id)
			session.resize(cols, rows)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Resized terminal to ${cols}x${rows}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'serial_disconnect',
		{
			title: 'Disconnect Serial Console',
			description: 'Disconnect the serial console session for a VM.',
			inputSchema: {
				vmid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('VM ID. Uses active terminal session if omitted.'),
			},
		},
		async ({ vmid }) => {
			const id = resolveTermVmid(vmid)
			termSessions.disconnect(id)
			if (activeTermVmid === id) setActiveTermVmid(null)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Disconnected serial console for VM ${id}`,
					},
				],
			}
		},
	)
}
