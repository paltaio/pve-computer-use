---
name: pve-vm
description: Script Proxmox VE virtual machines from TypeScript — VM lifecycle, KVM (keyboard/mouse) via VNC, qemu-guest-agent, snapshots, screenshots. Use when automating tasks inside guest VMs that don't have an OS-level agent yet (BIOS, bootloader, installers, login screens) or when chaining KVM input with PVE-level operations.
---

# pve-vm

TypeScript skill for driving Proxmox VE VMs. Wraps the same primitives as the
`pve-computer-use` MCP server but exposes them as a plain library so an agent
can compose flows in code.

## Quickstart

Set credentials once in the shell:

```sh
export PVE_HOST=pve.example.com
export PVE_USER=root@pam
export PVE_PASSWORD=...
export PVE_VERIFY_SSL=false   # optional
```

Write a script and run it with bun:

```ts
// scripts/install-foo.ts
import pve, { act } from '<absolute-path-to-repo>/skill/index.ts'

const vm = pve.use(204)
if ((await vm.status()).status !== 'running') await vm.start()
await vm.waitFor('running')
await pve.wait(2_000)                       // give it a moment to settle
await vm.kvm.press('enter')                 // dismiss boot menu
await vm.kvm.type('root\n', { cps: 20 })
await vm.kvm.type('password\n')
const out = await vm.guest.exec('uname', ['-a'])
console.log(out.stdout)
await pve.disconnect()
```

```sh
bun scripts/install-foo.ts
```

The library is lazy: the first call authenticates and opens whatever sessions
it needs. Held keys and mouse buttons are auto-released on error and on process
exit, so an interrupted script never leaves stuck modifiers.

## One-shot vs file

Prefer inline `bun -e` for one-shots; don't litter `/tmp` for three lines:

```sh
bun -e 'import pve from "<absolute-path-to-repo>/skill/index.ts"; const v = pve.use(100); console.log(await v.status()); await pve.disconnect()'
```

Multi-line one-shots: heredoc into `bun -`:

```sh
bun - <<'EOF'
import pve from '<absolute-path-to-repo>/skill/index.ts'
const vm = pve.use(100)
await vm.kvm.press('ctrl+alt+t')
await pve.disconnect()
EOF
```

Only write a real file when the script is large or you'll reuse it many times.
When you do, allocate a session-stable path once (`mktemp /tmp/pve-vm-XXXXXX`,
or a fixed `/tmp/pve-vm-<tag>.ts`) and keep editing the same path across calls
so it survives for the rest of the Claude/Codex/OpenCode session.

## Two ways to write flows

**Imperative** — most scripts. Each call fires:

```ts
const vm = pve.use(100)
await vm.kvm.move(800, 400, { from: 'current', durationMs: 300 })
await vm.kvm.click(800, 400)
await vm.kvm.press('ctrl+s')
```

**Declarative steps** — when you want a list of actions you can pass around,
schedule with absolute timing, or repeat. `act.*` returns plain data:

```ts
import pve, { act } from '<absolute-path-to-repo>/skill/index.ts'
const vm = pve.use(100)

await vm.run([
  act.press('ctrl+alt+t'),
  act.wait(300),
  act.type('htop\n'),
])
```

Both call into the same primitives, so anything that works imperatively also
works as a step.

## Parallel flows (BIOS spam, racing operations)

The classic case: reset the VM and spam F2 until POST.

```ts
const vm = pve.use(100)

await pve.race([
  vm.do(act.exec(() => vm.reset())),
  vm.repeat(act.press('f2'), { ratePerSec: 20, durationMs: 6_000 }),
])
```

`pve.race` resolves on the first task and aborts the rest. `pve.all` waits for
everything. Pass an `AbortSignal` to `repeat`, `run`, `timeline`, or any
`opts`-taking method to cancel cooperatively.

## Absolute timing

`timeline()` schedules steps by `at` (ms from start) instead of after the
previous step. Useful when relative `wait()`s would drift:

```ts
await vm.timeline([
  { at: 0,    do: act.exec(() => vm.reset()) },
  { at: 1500, do: act.press('f2') },
  { at: 1550, do: act.press('f2') },
  { at: 1600, do: act.press('f2') },
])
```

## API surface

```ts
// Singleton
pve.list()                              // VmStatus[] across cluster
pve.use(vmid)                           // -> Vm handle (does not connect)
pve.wait(ms)
pve.connect()                           // explicit init (auto otherwise)
pve.disconnect()                        // tear down sessions
pve.all(tasks)
pve.race(tasks, controller?)            // resolves first, aborts rest

// vm = pve.use(vmid)
vm.status()                             // { status, name, qmpstatus }
vm.start() / vm.shutdown() / vm.stop() / vm.reset()
vm.waitFor('running' | 'stopped' | ..., { timeoutMs, intervalMs, signal })
vm.screenshot()                         // -> Buffer (JPEG)
vm.screenshot('out.jpg', quality?)      // saves, returns void
vm.waitForScreenChange(timeoutMs?)
vm.waitForScreen({ text?, color?, match?, timeoutMs?, intervalMs?, signal? })
vm.disconnectVnc()

vm.guest.exec(cmd, args?, { timeoutMs? })   // -> { exitcode, stdout, stderr }

vm.snapshot.list() / create(name, desc?) / delete(name) / rollback(name)

// KVM — immediate
vm.kvm.press('ctrl+alt+del')            // chord: down all, then up reverse
vm.kvm.down('shift') / up('shift')      // tracked, auto-released
vm.kvm.releaseAll()                     // panic button
vm.kvm.type('hello', { cps, delayMs, layout, strategy })
vm.kvm.move(x, y, { from: 'current', durationMs, easing, steps })
vm.kvm.click(x, y, button?, holdMs?)
vm.kvm.doubleClick(x, y, button?)
vm.kvm.mouseDown(button, x?, y?) / mouseUp(button|'all', x?, y?)
vm.kvm.drag({ from: [x,y], to: [x,y], durationMs, easing, holdStartMs, holdEndMs })
vm.kvm.scroll(x, y, { direction, amount })
vm.kvm.path([[x,y], ...], { durationMs, easing, steps })

// Composition
vm.do(step, signal?)
vm.run([...steps], { releaseOnExit, signal })
vm.timeline([{ at, do }, ...], { releaseOnExit, signal })
vm.repeat(step, { times | durationMs, ratePerSec | intervalMs, jitterMs, signal })

// Step builders (plain data)
act.wait, press, down, up, releaseAll, type, move,
    click, doubleClick, mouseDown, mouseUp, drag, scroll, path,
    exec(fn)        // arbitrary async work inside a timeline
```

## Key names

Combos use `+` as separator. Modifiers: `ctrl shift alt meta`. Examples:
`enter`, `tab`, `esc`, `f2`, `space`, `home`, `pageup`, `arrow_up`, `delete`,
`ctrl+c`, `ctrl+alt+del`, `shift+tab`. See `src/rfb.ts` for the full keysym
table.

## When to use which strategy

- **`vm.kvm.type` with `strategy: 'auto'`** (default) — fastest; uses Windows
  clipboard paste when the guest is Windows, VNC key events otherwise.
- **`strategy: 'vnc'`** — needed for password fields, BIOS, and anything where
  clipboard isn't available.
- **`vm.guest.exec`** — when guest-agent is up and you don't need to script the
  UI; this is the fastest, most reliable path.

## Screen matching (OCR + color)

`vm.waitForScreen` polls the framebuffer until a text pattern, a color
condition, or both, are satisfied — useful for waiting on dialogs, banners,
login screens, installer steps, anything without a programmatic signal.

```ts
// regex over any text block found on the whole screen
await vm.waitForScreen({ text: /Welcome \w+/, timeoutMs: 30_000 })

// substring is also fine
await vm.waitForScreen({ text: 'Press any key' })

// color: ≥50% of a region within 80% similarity of pure red
await vm.waitForScreen({
  color: { near: '#ff0000', threshold: 0.8, area: 0.5,
           region: { x: 0, y: 0, w: 200, h: 100 } },
})

// combine: text OR color
await vm.waitForScreen({
  text: /Login/i,
  color: { near: '#22aa55', area: 0.05 },
  match: 'any',
})
```

The result includes `matched`, the concatenated OCR `text`, the structured
`items` (each `{ box, text, conf }`), and `matchedItem` — the specific block
that satisfied the pattern. Use `matchedItem.box` to click whatever you just
found:

```ts
const r = await vm.waitForScreen({ text: 'OK' })
const [[x1, y1], , [x2, y2]] = r.matchedItem!.box
await vm.kvm.click(Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2))
```

OCR backends, picked automatically:

- **rapidocr** (PP-OCRv4 mobile via OpenVINO/ONNX) — preferred. Reads small UI
  text reliably without region hints; ~1–2 s per 1280×800 frame warm,
  ~8 s first-call worker boot (model load), ~700 MB RSS. Needs `uv` on PATH;
  the worker auto-installs `rapidocr` + `openvino` into a uv-managed env on
  first use.
- **tesseract** — fallback. Fast (~200 ms) and tiny but struggles with small
  text and busy backgrounds. For tesseract, prefer giving `text: { pattern,
  region, scale: 3, ocr: { psm: 6 } }` so OCR runs on a cropped, upscaled
  patch.

Force a backend with `PVE_OCR=rapidocr` or `PVE_OCR=tesseract`. Set
`PVE_OCR_DEBUG=1` to surface worker stderr.

### Example: detect a Windows 10/11 login screen after reboot

`match: 'any'` is the right pattern when several signals could appear: text or
color, lock screen or login prompt, English or localized — any single hit
returns. Color check runs first and short-circuits OCR.

```ts
await vm.guest.exec('shutdown', ['/r', '/t', '0', '/f'])  // reboot
await vm.waitFor('running')

const r = await vm.waitForScreen({
  // Lock screen (clock/date) OR login prompt (username, Password placeholder).
  text: /iot|Password|Sign in|Other user|\d{1,2}:\d{2}/i,
  // Lock/login background is dark Windows blue.
  color: { near: '#0a4e8c', threshold: 0.5, area: 0.4 },
  match: 'any',
  timeoutMs: 120_000,
  intervalMs: 2_500,
})

if (r.matchedItem) {
  // text fired — center the cursor on the matched block and click through.
  const [[x1, y1], , [x2, y2]] = r.matchedItem.box
  await vm.kvm.click((x1 + x2) >> 1, (y1 + y2) >> 1)
} else {
  // color fired (lock screen showing) — press a key to advance to login.
  await vm.kvm.press('space')
}
```

## Pitfalls

- KVM commands need the VM running and the VNC connection to come up. First
  `kvm.*` call connects; subsequent calls are cheap.
- Coordinates are validated against the current framebuffer; if the resolution
  changes, take a screenshot first or you may click outside the screen.
- `vm.reset()` is stop + start; for a soft reboot prefer
  `vm.guest.exec('reboot')` when the guest agent is available.
- `pve.race` aborts the controller it manages. If you pass your own, the same
  controller is aborted on resolution — share it across cooperating tasks.
