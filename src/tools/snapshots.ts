import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { api } from '../state.js'

export function registerSnapshotTools(server: McpServer): void {
	server.registerTool(
		'snapshot_list',
		{
			title: 'List Snapshots',
			description: 'List all snapshots for a VM. Requires VM.Audit privilege.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			const snapshots = await api.listSnapshots(resolvedNode, vmid)

			// Filter out the "current" pseudo-snapshot
			const real = snapshots.filter((s) => s.name !== 'current')

			if (real.length === 0) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `VM ${vmid} has no snapshots.`,
						},
					],
				}
			}

			const lines = real.map((s) => {
				const time = s.snaptime ? new Date(s.snaptime * 1000).toISOString() : 'n/a'
				const desc = s.description ?? ''
				const mem = s.vmstate ? ' [+memory]' : ''
				return `  ${s.name} — ${time}${mem}${desc ? ` — ${desc}` : ''}`
			})

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid} snapshots:\n${lines.join('\n')}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'snapshot_create',
		{
			title: 'Create Snapshot',
			description: 'Create a snapshot of a VM. Requires VM.Snapshot privilege.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				name: z.string().min(1).describe('Snapshot name'),
				description: z.string().optional().describe('Snapshot description'),
				vmstate: z.boolean().default(false).describe('Include VM memory state (default false)'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, name, description, vmstate, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.createSnapshot(resolvedNode, vmid, name, description, vmstate)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Snapshot "${name}" created for VM ${vmid}${vmstate ? ' (with memory state)' : ''}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'snapshot_delete',
		{
			title: 'Delete Snapshot',
			description: 'Delete a snapshot from a VM. Requires VM.Snapshot privilege.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				name: z.string().min(1).describe('Snapshot name to delete'),
				force: z
					.boolean()
					.default(false)
					.describe('Force removal of stuck snapshots (default false)'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, name, force, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.deleteSnapshot(resolvedNode, vmid, name, force)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Snapshot "${name}" deletion requested for VM ${vmid}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'snapshot_rollback',
		{
			title: 'Rollback Snapshot',
			description:
				'Rollback a VM to a previous snapshot. The VM will be stopped and restored. Requires VM.Snapshot privilege.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				name: z.string().min(1).describe('Snapshot name to rollback to'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, name, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.rollbackSnapshot(resolvedNode, vmid, name)

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid} rollback to snapshot "${name}" requested`,
					},
				],
			}
		},
	)

	server.registerTool(
		'backup_create',
		{
			title: 'Create Backup',
			description: 'Create a backup (vzdump) of a VM. Requires VM.Backup privilege.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				storage: z.string().optional().describe('Target storage (must support backups)'),
				compress: z
					.enum(['0', 'gzip', 'lzo', 'zstd'])
					.default('zstd')
					.describe('Compression algorithm (default zstd)'),
				mode: z
					.enum(['snapshot', 'stop', 'suspend'])
					.default('snapshot')
					.describe('Backup mode: snapshot (live), stop (consistent), suspend (compat)'),
				notes: z.string().optional().describe('Backup notes template'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, storage, compress, mode, notes, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.createBackup(resolvedNode, vmid, storage, compress, mode, notes)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Backup of VM ${vmid} started (mode=${mode}, compress=${compress}${storage ? `, storage=${storage}` : ''})`,
					},
				],
			}
		},
	)

	server.registerTool(
		'backup_list',
		{
			title: 'List Backups',
			description: 'List backup files from a storage. Requires access to the storage.',
			inputSchema: {
				storage: z.string().describe('Storage name to list backups from'),
				vmid: z.number().int().positive().optional().describe('Filter by VM ID'),
				node: z.string().describe('PVE node name'),
			},
		},
		async ({ storage, vmid, node }) => {
			const backups = await api.listBackups(node, storage, vmid)

			if (backups.length === 0) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `No backups found in storage "${storage}"${vmid ? ` for VM ${vmid}` : ''}.`,
						},
					],
				}
			}

			const lines = backups.map((b) => {
				const time = new Date(b.ctime * 1000).toISOString()
				const sizeMb = (b.size / 1024 / 1024).toFixed(1)
				const prot = b.protected ? ' [protected]' : ''
				return `  ${b.volid} — ${time} — ${sizeMb} MB${prot}${b.notes ? ` — ${b.notes}` : ''}`
			})

			return {
				content: [
					{
						type: 'text' as const,
						text: `Backups in "${storage}"${vmid ? ` for VM ${vmid}` : ''}:\n${lines.join('\n')}`,
					},
				],
			}
		},
	)
}
