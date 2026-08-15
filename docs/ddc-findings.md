# DDC/CI measurement notes

This document is the basis for implementation decisions in this repository.

Measurement environment:

| | machine | connection | backend |
| --- | --- | --- | --- |
| Mac | macOS, Apple Silicon, USB-C | USB-C | m1ddc |
| Windows | Windows 11, HDMI | HDMI | dxva2.dll (bun:ffi) |

Reproduce with `bun run scripts/probe-ddc.ts` (read-only, no screen change).

## 1. VCP values for input source

VCP code `0x60` (Input Source):

| logical name | value | note |
| --- | --- | --- |
| USB-C (DP Alt Mode) | 27 (0x1B) | non-standard, Dell-specific |
| HDMI | 17 (0x11) | |
| DisplayPort | 15 (0x0F) | |

MCCS standard: 0x0F/0x10 = DisplayPort 1/2, 0x11/0x12 = HDMI 1/2. USB-C has no standard assignment; Dell uses 0x1B.

## 2. DDC survives input switching

After switching from USB-C to HDMI:

| time | `m1ddc display list` | DDC read |
| --- | --- | --- |
| before | visible | responds |
| +3s | visible | responds |
| +8s | visible | responds |
| +15s | visible | responds |
| switch back to USB-C | visible | success |

The reference monitor does not drop the DDC link on the inactive side. No external relay hardware needed.

Note: reads are unstable for ~1 second after switching. The 1500ms sleep in `service.ts` is for this.

## 3. ~45% of reads return garbage value 110 (0x6E)

250ms interval, 20 reads each:

```
get input      -> 27×11   110×9
get luminance  -> 75×11   110×9
get contrast   -> 75×9    110×11
get volume     -> 100×9   110×11
```

`max luminance` = 100, so 110 is invalid. True values: input=27, luminance=75, contrast=75, volume=100.

`110 = 0x6E` is the DDC/CI response frame's destination address — likely a parsing error in m1ddc.

### Waiting doesn't help

```
interval=120ms  7/15 correct
interval=200ms  6/15 correct
interval=300ms  7/15 correct
interval=400ms  5/15 correct
interval=600ms  8/15 correct
```

Not a timing issue — use retry, not wait.

### `max` reads are also unstable

```
max luminance  -> 100   (one run)
max luminance  -> -128  (another run)
```

Can't use "exceeds max" as a filter since max itself is unreliable. `isPlausible()` uses hardcoded 0x6E filter on macOS.

### Negative values appear as signed 8-bit

| display | unsigned |
| --- | --- |
| -66 | 0xBE (190) |
| -128 | 0x80 (128) |

m1ddc outputs values as signed char. Current true values are all < 128 so no impact, but adding VCP codes with values ≥ 128 requires revisiting `isPlausible()` range check.

### Zero-interval consecutive runs produce different corruption

```
$ m1ddc display 1 get input; m1ddc display 1 get luminance; ...
27
110
110
110
-66
```

Out-of-range values appear. Minimum 120ms interval required.

### Countermeasures and pitfalls

`src/ddc.ts` `#get`:

1. Serialize all commands, minimum 120ms interval
2. Discard 0x6E and out-of-range values
3. Require two consecutive identical reads (max 10 attempts)

**Pitfall:** if you discard the previous valid value when garbage arrives, alternating patterns (27, 110, 27, 110, ...) never stabilize. Garbage is treated as "no data" — previous valid value is kept.

Results:

| implementation | outcome |
| --- | --- |
| no correction | all properties become 110 |
| 2-match only | input mostly correct, luminance/volume often missing |
| 2-match + garbage skip + sequential read | 8/8 all fields correct |

### Don't read multiple properties in parallel

Alternating properties reduces success rate. `status()` reads sequentially, not with `Promise.all`.

## 4. Windows can also switch back

After switching from HDMI to Type-C:

| time | `ddc displays` shows Dell | DDC read |
| --- | --- | --- |
| before | yes | responds (0x60 = 17) |
| +3s | yes | responds (0x60 = 27) |
| +6s | yes | responds |
| +9s | yes | responds |
| +12s | yes | responds |
| +15s | yes | responds |
| switch back to HDMI | yes | success |

### But own-input switch causes ~10s silence

```
18:01:10  ddc hdmi   -> switch succeeds, read fails (unconfirmed)
18:01:16  ddc status  -> Error: display did not answer
18:01:17  ddc hdmi   -> Error (current value read fails)
18:01:22  ddc status  -> 0x60 = 17 (success)
```

Switch succeeded at 18:01:10. DDC is silent for ~10 seconds after. Windows re-detects the display during this window.

`Ddc.verifyInput()` retries for the backend's full verify window (`verifyWindowMs`: macOS 5s / Windows 20s).

After the fix:

```
toggle (-> type-c)  3.5s   hdmi → type-c
status              1.0s   0x60 = 27
toggle (-> hdmi)    6.4s   type-c → hdmi
status              1.1s   0x60 = 17
```

## 5. m1ddc hidden feature: `get input`

Not in `m1ddc --help` but works, returns VCP 0x60 current value. Avoids caching the last-set value as "current input".

Not documented — may break in future versions.

## 6. Windows (dxva2) reads don't corrupt

Same monitor, same conditions (250ms interval, 20 reads):

```
get input      -> 17×20
get luminance  -> 75/100×20
get contrast   -> 75/100×20
get volume     -> 100/100×20
```

Zero garbage. Different intervals same result.

The 45% corruption is **not the monitor** — it's m1ddc or IOAVService.

Single read takes ~54ms. `ddc status` (4 properties) takes 1-2s on Windows vs 3-6s on macOS.

### Response is 16-bit with duplicate high byte

```
VCP 0x60: type=1 current=4369 (0x1111) max=6939 (0x1B1B)
VCP 0x10: type=1 current=75   max=100
```

Low byte of 0x1111 = 0x11 = 17 (HDMI), matches m1ddc. `max` 0x1B1B low byte = 0x1B = 27 (Type-C), meaningless for non-continuous properties. `win32.ts` takes low byte only, `max` only for continuous properties.

### Capabilities string readable

```
(prot(monitor)type(LCD)model(...)cmds(01 02 03 07 0C E3 F3)
 vcp(02 04 05 08 10 12 14(...) 16 18 1A 52 60(1B 0F 11 ) AA(01 02 04 ) ...
     E8 E9(00 01 02 21 22 24 ) ... )mswhql(1)asset_eep(40)mccs_ver(2.1))
```

`60(1B 0F 11 )` matches section 1. `E9(00 01 02 21 22 24 )` is PBP modes including 50/50 = 36 (0x24).

`ddc caps` formats this. No m1ddc equivalent.

### One HMONITOR can have multiple physical monitors

Duplicate display mode: `EnumDisplayMonitors` returns 1 HMONITOR but `GetPhysicalMonitorsFromHMONITOR` returns 2. Count physical monitors, not HMONITORs.

### Other monitors may corrupt on Windows too

A JAPANNEXT monitor returned 249 for VCP 0x60 with max=18. Windows isn't always safe — the 2-match check is shared across platforms.

## 7. Other observations

- `m1ddc display list detailed` gives EDID UUID. System UUID changes on reconnect; EDID UUID is stable. Currently not used (resolve by name each time).
- Internal display shows as `[2] (null)` in list but is not DDC-controllable
- m1ddc outputs errors to stdout, not stderr
- Windows monitor name is the physical description string, includes current input (e.g. `Dell U3223QE (HDMI HDR)`). Some monitors show as `Generic PnP Monitor`.

## Unresolved

- Root cause of 110 (0x6E) — trace m1ddc source or IOAVService response
- Does the same garbage appear on other Dell or third-party monitors?
- Monitor sleep/power-off behavior
- Behavior when switching to an input where the target machine is off
