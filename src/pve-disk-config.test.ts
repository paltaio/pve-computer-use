import test from 'node:test'
import assert from 'node:assert/strict'

import { listVmDiskEntries, parseDriveSpec } from './pve-disk-config.js'

test('parseDriveSpec parses efidisk with pre-enrolled keys', () => {
	const parsed = parseDriveSpec('local-lvm:vm-200-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M')

	assert.equal(parsed.storage, 'local-lvm')
	assert.equal(parsed.volume, 'vm-200-disk-0')
	assert.equal(parsed.options.get('efitype'), '4m')
	assert.equal(parsed.options.get('pre-enrolled-keys'), '1')
	assert.equal(parsed.options.get('size'), '4M')
})

test('listVmDiskEntries extracts disk-like keys from VM config', () => {
	const disks = listVmDiskEntries({
		scsi0: 'local-lvm:vm-100-disk-0,size=32G',
		efidisk0: 'local-lvm:vm-100-disk-1,efitype=4m,size=4M',
		unused0: 'local-lvm:vm-100-disk-2',
		name: 'test-vm',
	})

	assert.deepEqual(
		disks.map((disk) => disk.key),
		['scsi0', 'efidisk0', 'unused0'],
	)
	assert.equal(disks[1]?.parsed?.storage, 'local-lvm')
})
