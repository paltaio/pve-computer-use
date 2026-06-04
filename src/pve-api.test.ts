import test from 'node:test'
import assert from 'node:assert/strict'

import { PveApiClient } from './pve-api.js'
import { PveAuthManager } from './pve-auth.js'

type RequestCall = {
	method: string
	path: string
	body: Record<string, string> | URLSearchParams | undefined
}

function createClient(): PveApiClient {
	const auth = new PveAuthManager({
		host: 'pve.test',
		port: 8006,
		username: 'tester@pve',
		password: 'secret',
		verifySsl: true,
	})

	return new PveApiClient(auth)
}

function recordRequests(client: PveApiClient, result: unknown = null): RequestCall[] {
	const calls: RequestCall[] = []

	Reflect.set(
		client,
		'request',
		async (method: string, path: string, body?: Record<string, string> | URLSearchParams) => {
			calls.push({ method, path, body })
			return result
		},
	)

	return calls
}

function recordTaskWaits(client: PveApiClient): string[] {
	const waited: string[] = []

	Reflect.set(client, 'waitForTask', async (node: string, upid: string) => {
		waited.push(`${node}:${upid}`)
	})

	return waited
}

test('getVmConfig normalizes tags and disk entries', async () => {
	const client = createClient()

	Reflect.set(client, 'request', async () => ({
		name: 'vm-200',
		tags: 'prod; template ;',
		efidisk0: 'local-lvm:vm-200-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M',
		scsi0: 'local-lvm:vm-200-disk-1,size=64G',
		unused0: 'local-lvm:vm-200-disk-2',
	}))

	const config = await client.getVmConfig('pve', 200)

	assert.deepEqual(config.tags, ['prod', 'template'])
	assert.equal(config.disks.length, 3)
	assert.equal(
		config.disks.find((disk) => disk.key === 'efidisk0')?.spec,
		'local-lvm:vm-200-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M',
	)
	assert.equal(config.disks.find((disk) => disk.key === 'unused0')?.spec, 'local-lvm:vm-200-disk-2')
})

test('getVmDiskConfig returns only disk-like entries', async () => {
	const client = createClient()

	Reflect.set(client, 'request', async () => ({
		name: 'vm-201',
		description: 'notes',
		virtio0: 'fast:vm-201-disk-0,size=32G',
		ide2: 'local:iso/debian.iso,media=cdrom',
		agent: '1',
	}))

	const disks = await client.getVmDiskConfig('pve', 201)

	assert.deepEqual(
		disks.map((disk) => disk.key),
		['virtio0', 'ide2'],
	)
})

test('setVmConfigValue sends a keyed config update payload', async () => {
	const client = createClient()
	const calls = recordRequests(client)

	await client.setVmConfigValue('pve', 202, 'efidisk0', 'local-lvm:0,efitype=4m,format=raw')

	assert.equal(calls.length, 1)
	assert.equal(calls[0]?.method, 'PUT')
	assert.equal(calls[0]?.path, '/nodes/pve/qemu/202/config')
	assert.deepEqual(calls[0]?.body, {
		efidisk0: 'local-lvm:0,efitype=4m,format=raw',
	})
})

test('createVm sends encoded create payload and waits for task', async () => {
	const client = createClient()
	const calls = recordRequests(client, 'UPID:pve:task')
	const waited = recordTaskWaits(client)

	await client.createVm('pve', 206, {
		name: 'vm-206',
		memory: 2048,
		agent: true,
		onboot: false,
	})

	assert.equal(calls.length, 1)
	assert.equal(calls[0]?.method, 'POST')
	assert.equal(calls[0]?.path, '/nodes/pve/qemu')
	assert.deepEqual(calls[0]?.body, {
		name: 'vm-206',
		memory: '2048',
		agent: '1',
		onboot: '0',
		vmid: '206',
	})
	assert.deepEqual(waited, ['pve:UPID:pve:task'])
})

test('updateVmConfigValues sends encoded config and delete keys', async () => {
	const client = createClient()
	const calls = recordRequests(client)

	await client.updateVmConfigValues(
		'pve',
		207,
		{
			memory: 4096,
			agent: true,
		},
		['ide2', ' unused0 '],
	)

	assert.equal(calls.length, 1)
	assert.equal(calls[0]?.method, 'PUT')
	assert.equal(calls[0]?.path, '/nodes/pve/qemu/207/config')
	assert.deepEqual(calls[0]?.body, {
		memory: '4096',
		agent: '1',
		delete: 'ide2,unused0',
	})
})

test('updateVmConfigValues rejects empty updates', async () => {
	const client = createClient()

	await assert.rejects(
		() => client.updateVmConfigValues('pve', 207, {}, []),
		/No VM config changes provided/,
	)
})

test('deleteVmConfigValue sends delete payload', async () => {
	const client = createClient()
	const calls = recordRequests(client)

	await client.deleteVmConfigValue('pve', 203, 'unused0')

	assert.equal(calls.length, 1)
	assert.equal(calls[0]?.method, 'PUT')
	assert.equal(calls[0]?.path, '/nodes/pve/qemu/203/config')
	assert.deepEqual(calls[0]?.body, { delete: 'unused0' })
})

test('deleteVm sends delete path with flags and waits for task', async () => {
	const client = createClient()
	const calls = recordRequests(client, 'UPID:pve:delete')
	const waited = recordTaskWaits(client)

	await client.deleteVm('pve', 208, {
		purge: true,
		destroyUnreferencedDisks: true,
	})

	assert.equal(calls.length, 1)
	assert.equal(calls[0]?.method, 'DELETE')
	assert.equal(calls[0]?.path, '/nodes/pve/qemu/208?purge=1&destroy-unreferenced-disks=1')
	assert.equal(calls[0]?.body, undefined)
	assert.deepEqual(waited, ['pve:UPID:pve:delete'])
})

test('setVmNotes writes description when notes are provided', async () => {
	const client = createClient()
	const calls = recordRequests(client)

	await client.setVmNotes('pve', 204, 'Install template for QA')

	assert.equal(calls.length, 1)
	assert.equal(calls[0]?.method, 'PUT')
	assert.equal(calls[0]?.path, '/nodes/pve/qemu/204/config')
	assert.deepEqual(calls[0]?.body, { description: 'Install template for QA' })
})

test('setVmNotes clears description when notes are empty', async () => {
	const client = createClient()
	const calls = recordRequests(client)

	await client.setVmNotes('pve', 205, '   ')

	assert.equal(calls.length, 1)
	assert.equal(calls[0]?.method, 'PUT')
	assert.equal(calls[0]?.path, '/nodes/pve/qemu/205/config')
	assert.deepEqual(calls[0]?.body, { delete: 'description' })
})
