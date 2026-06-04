import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { api } from '../state.js'
import type { PveConfig } from '../pve-api.js'
import { formatVmTags, matchesVmFilters } from '../helpers.js'
import { GUIDANCE_TOPICS, guidanceTopicIds, guidanceTopicUri, readGuidance } from '../guidance.js'

const pveConfigValueSchema = z.union([z.string(), z.number(), z.boolean()])
const pveConfigSchema = z.record(z.string().min(1), pveConfigValueSchema)

export function registerVmTools(server: McpServer): void {
	server.registerTool(
		'list_vms',
		{
			title: 'List VMs',
			description:
				'List QEMU virtual machines visible to the authenticated user, optionally filtered by VM ID, tag, status, or name. Shows vmid, name, status, node, and tags.',
			inputSchema: {
				vmids: z
					.array(z.number().int().positive())
					.optional()
					.describe('Optional list of exact VM IDs to include.'),
				tags: z
					.array(z.string().min(1))
					.optional()
					.describe('Optional list of VM tags. A VM matches if it has any requested tag.'),
				statuses: z
					.array(z.string().min(1))
					.optional()
					.describe(
						'Optional list of VM status values to include (for example: running, stopped).',
					),
				name: z
					.string()
					.min(1)
					.optional()
					.describe('Optional case-insensitive substring filter for the VM name.'),
			},
		},
		async ({ vmids, tags, statuses, name }) => {
			const normalizedName = name?.trim().toLowerCase()
			const normalizedTags = tags?.map((tag) => tag.trim()).filter((tag) => tag.length > 0)
			const normalizedStatuses = statuses
				?.map((status) => status.trim())
				.filter((status) => status.length > 0)
			const vms = (await api.listVms()).filter((vm) =>
				matchesVmFilters(vm, {
					vmids,
					tags: normalizedTags && normalizedTags.length > 0 ? normalizedTags : undefined,
					statuses:
						normalizedStatuses && normalizedStatuses.length > 0 ? normalizedStatuses : undefined,
					name: normalizedName && normalizedName.length > 0 ? normalizedName : undefined,
				}),
			)

			if (vms.length === 0) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'No VMs found for the requested filters (or no permissions to view any).',
						},
					],
				}
			}

			const lines = vms.map((vm) => {
				return `VM ${vm.vmid}: name=${vm.name ?? 'unknown'}, status=${vm.status}, node=${vm.node}, tags=${formatVmTags(vm.tags)}`
			})

			return {
				content: [
					{
						type: 'text' as const,
						text: lines.join('\n'),
					},
				],
			}
		},
	)

	server.registerTool(
		'vm_start',
		{
			title: 'Start VM',
			description: 'Start a stopped VM. Requires VM.PowerMgmt privilege.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.startVm(resolvedNode, vmid)

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid} started successfully`,
					},
				],
			}
		},
	)

	server.registerTool(
		'vm_shutdown',
		{
			title: 'Shutdown VM',
			description: 'Gracefully shutdown a VM via ACPI power-off. Requires VM.PowerMgmt privilege.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.shutdownVm(resolvedNode, vmid)

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid} shutdown completed`,
					},
				],
			}
		},
	)

	server.registerTool(
		'vm_stop',
		{
			title: 'Stop VM',
			description:
				'Force stop a VM (like pulling the power cord). Requires VM.PowerMgmt privilege. Prefer vm_shutdown for graceful shutdown.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.stopVm(resolvedNode, vmid)

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid} force stopped`,
					},
				],
			}
		},
	)

	server.registerTool(
		'vm_status',
		{
			title: 'VM Status',
			description: 'Get the current status of a VM, including tags. Requires VM.Audit privilege.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			const [status, config] = await Promise.all([
				api.getVmStatus(resolvedNode, vmid),
				api.getVmConfig(resolvedNode, vmid),
			])

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid}: status=${status.status}, qmpstatus=${status.qmpstatus ?? 'n/a'}, name=${status.name ?? config.name ?? 'unknown'}, tags=${formatVmTags(config.tags)}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'vm_create',
		{
			title: 'Create VM',
			description:
				'Create a QEMU VM on a PVE node. Requires VM.Allocate on /vms/{vmid} and matching VM.Config privileges for the provided options.',
			inputSchema: {
				node: z.string().min(1).describe('PVE node name where the VM will be created.'),
				vmid: z.number().int().positive().describe('VM ID'),
				config: pveConfigSchema
					.default({})
					.describe(
						'Raw Proxmox QEMU create options, excluding node and vmid. Examples: name, memory, cores, net0, scsi0, ide2, ostype, agent, tags.',
					),
				start: z.boolean().default(false).describe('Start the VM after creation.'),
			},
		},
		async ({ node, vmid, config, start }) => {
			await api.createVm(node, vmid, config as PveConfig)
			if (start) {
				await api.startVm(node, vmid)
			}

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid} created on node ${node}${start ? ' and started' : ''}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'vm_config_set',
		{
			title: 'Set VM Config',
			description:
				'Set one or more raw Proxmox QEMU config entries. Requires the matching VM.Config privileges for the provided options.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				config: pveConfigSchema
					.default({})
					.describe(
						'Raw Proxmox QEMU config options to set. Examples: memory, cores, net0, scsi0, boot, agent, tags.',
					),
				delete: z
					.array(z.string().min(1))
					.optional()
					.describe('Optional config keys to delete in the same update.'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, config, delete: deleteKeys, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.updateVmConfigValues(resolvedNode, vmid, config as PveConfig, deleteKeys)

			const setKeys = Object.keys(config)
			const removedKeys = deleteKeys?.map((key) => key.trim()).filter((key) => key.length > 0) ?? []
			const parts: string[] = []
			if (setKeys.length > 0) parts.push(`set ${setKeys.join(', ')}`)
			if (removedKeys.length > 0) parts.push(`deleted ${removedKeys.join(', ')}`)

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid} config updated on node ${resolvedNode}: ${parts.join('; ')}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'vm_delete',
		{
			title: 'Delete VM',
			description:
				'Delete a QEMU VM and its owned volumes through the Proxmox API. Requires VM.Allocate privilege.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				purge: z
					.boolean()
					.default(false)
					.describe(
						'Remove VMID from related configurations such as backup jobs, replication, and HA.',
					),
				destroy_unreferenced_disks: z
					.boolean()
					.default(false)
					.describe('Destroy unreferenced disks with the same VMID from enabled storages.'),
				skiplock: z
					.boolean()
					.default(false)
					.describe('Ignore VM locks. Proxmox only allows root to use this option.'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, purge, destroy_unreferenced_disks, skiplock, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.deleteVm(resolvedNode, vmid, {
				purge,
				destroyUnreferencedDisks: destroy_unreferenced_disks,
				skiplock,
			})

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid} deleted on node ${resolvedNode}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'vm_notes',
		{
			title: 'VM Notes',
			description:
				'Read the VM notes/description from Proxmox config. Requires VM.Audit privilege.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			const config = await api.getVmConfig(resolvedNode, vmid)
			const notes = config.description?.trim()

			return {
				content: [
					{
						type: 'text' as const,
						text: notes ? `VM ${vmid} notes:\n${notes}` : `VM ${vmid} has no notes set.`,
					},
				],
			}
		},
	)

	server.registerTool(
		'vm_notes_set',
		{
			title: 'Set VM Notes',
			description:
				'Set the VM notes/description through the Proxmox config API. Pass an empty string to clear existing notes.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				notes: z
					.string()
					.describe('Notes text to store as the VM description. Use an empty string to clear it.'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, notes, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.setVmNotes(resolvedNode, vmid, notes)
			const normalized = notes.trim()

			return {
				content: [
					{
						type: 'text' as const,
						text:
							normalized.length > 0
								? `VM ${vmid} notes updated on node ${resolvedNode}`
								: `VM ${vmid} notes cleared on node ${resolvedNode}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'proxmox_guidance',
		{
			title: 'Proxmox Guidance',
			description:
				'Read canonical operational guidance for common Proxmox VM flows exposed by this MCP, including EFI/Secure Boot handling.',
			inputSchema: {
				topic: z.enum(guidanceTopicIds).describe('Guidance topic to read.'),
			},
		},
		async ({ topic }) => {
			const text = await readGuidance(topic)

			return {
				content: [
					{
						type: 'text' as const,
						text,
					},
				],
			}
		},
	)

	for (const topic of GUIDANCE_TOPICS) {
		server.registerResource(
			`guidance-${topic.id}`,
			guidanceTopicUri(topic.id),
			{
				title: topic.title,
				description: topic.description,
				mimeType: 'text/markdown',
			},
			async (uri) => ({
				contents: [
					{
						uri: uri.href,
						mimeType: 'text/markdown',
						text: await readGuidance(topic.id),
					},
				],
			}),
		)
	}

	server.registerTool(
		'vm_disk_list',
		{
			title: 'List VM Disk Config',
			description:
				'List disk-like VM config entries such as scsi0, virtio0, efidisk0, tpmstate0, and unusedN. Includes the raw config string for each entry.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			const disks = await api.getVmDiskConfig(resolvedNode, vmid)

			if (disks.length === 0) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `VM ${vmid} has no disk-like config entries.`,
						},
					],
				}
			}

			const lines = disks.map((disk) => {
				const parsed = disk.parsed
					? ` storage=${disk.parsed.storage} volume=${disk.parsed.volume}`
					: ''
				return `${disk.key}: ${disk.spec}${parsed}`
			})

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid} disk config on node ${resolvedNode}:\n${lines.join('\n')}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'vm_disk_set',
		{
			title: 'Set VM Disk Config',
			description:
				'Set a disk-like VM config entry such as scsi0, virtio0, efidisk0, tpmstate0, or unusedN to a raw Proxmox config string.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				disk: z
					.string()
					.min(1)
					.describe('Disk config key, for example scsi0, efidisk0, or unused0.'),
				value: z
					.string()
					.min(1)
					.describe('Raw Proxmox disk config value, for example local-lvm:0,efitype=4m.'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, disk, value, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.setVmConfigValue(resolvedNode, vmid, disk, value)

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid} updated ${disk} on node ${resolvedNode} to: ${value}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'vm_config_delete',
		{
			title: 'Delete VM Config Entry',
			description:
				'Delete a VM config entry through the Proxmox config API. This is commonly used for disk-like keys such as efidisk0 or unusedN.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				key: z
					.string()
					.min(1)
					.describe('VM config key to delete, for example efidisk0 or unused0.'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, key, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			await api.deleteVmConfigValue(resolvedNode, vmid, key)

			return {
				content: [
					{
						type: 'text' as const,
						text: `VM ${vmid} deleted config key ${key} on node ${resolvedNode}`,
					},
				],
			}
		},
	)

	server.registerTool(
		'exec_command',
		{
			title: 'Execute Command in VM',
			description:
				'Execute a command inside the VM via QEMU guest agent. Requires qemu-guest-agent running in the VM and VM.GuestAgent.Unrestricted privilege.',
			inputSchema: {
				vmid: z.number().int().positive().describe('VM ID'),
				command: z
					.string()
					.min(1)
					.describe(
						'Command to execute (full path recommended, e.g. /usr/bin/ls). For env vars or shell features use /bin/bash -c.',
					),
				args: z
					.array(z.string())
					.optional()
					.describe('Command arguments (e.g. ["--output", "Virtual-1", "--mode", "1280x720"])'),
				timeout_ms: z
					.number()
					.int()
					.positive()
					.default(30_000)
					.describe('Command timeout in milliseconds'),
				node: z.string().optional().describe('PVE node name. Auto-detected if omitted.'),
			},
		},
		async ({ vmid, command, args, timeout_ms, node }) => {
			const resolvedNode = node ?? (await api.findVmNode(vmid))
			const result = await api.guestExec(resolvedNode, vmid, command, args, timeout_ms)

			return {
				content: [
					{
						type: 'text' as const,
						text: `Exit code: ${result.exitcode}\nStdout: ${result.stdout}\nStderr: ${result.stderr}`,
					},
				],
			}
		},
	)
}
