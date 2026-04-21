# Secure Boot

To disable Secure Boot on an existing OVMF VM, recreate `efidisk0` without `pre-enrolled-keys=1`. Do not try to toggle Secure Boot in place.

Recommended flow:

1. Read `vm_status` and stop the VM if it is running.
2. Read `vm_disk_list` and capture the current `efidisk0` value.
3. Delete `efidisk0` with `vm_config_delete`.
4. If the old EFI disk becomes `unusedN`, delete that `unusedN` entry too.
5. Recreate `efidisk0` on the same storage with `vm_disk_set`, usually with `efitype=4m` and preserving explicit `format` if present.
6. Start the VM again if it was running before.
7. Re-read `vm_disk_list` to confirm the recreated `efidisk0` no longer includes `pre-enrolled-keys=1` or Microsoft cert defaults.
