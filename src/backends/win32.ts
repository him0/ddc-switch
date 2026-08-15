/**
 * Windows バックエンド。dxva2.dll (Monitor Configuration API) を bun:ffi で直接叩く。
 *
 * m1ddc に相当する外部バイナリは要らない。dxva2.dll は Windows 標準で、
 * ControlMyMonitor などのツールも同じ API を使っている。
 *
 * 呼ぶ順序:
 *   EnumDisplayMonitors                     -> HMONITOR (論理的な表示面) の一覧
 *   GetNumberOfPhysicalMonitorsFromHMONITOR
 *   GetPhysicalMonitorsFromHMONITOR         -> 物理モニタのハンドルと説明文字列
 *   GetVCPFeatureAndVCPFeatureReply / SetVCPFeature
 *   DestroyPhysicalMonitors                 -> 解放
 *
 * 複製表示にしていると 1 つの HMONITOR の下に複数の物理モニタがぶら下がるので、
 * HMONITOR ではなく物理モニタを 1 台として数える。
 *
 * 実測メモ (DELL U3223QE / Windows 11):
 *   - 1 回の VCP 読み取りが約 55ms。m1ddc と違いゴミ値 110 は返らない。
 *   - VCP 0x60 の応答は 0x1111 のように上位バイトにも同じ値が乗る。値は下位バイト。
 *   - capabilities 文字列を読めるので、対応入力を実機から確認できる (`ddc caps`)。
 */

import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";

import {
  DdcError,
  isContinuous,
  type DdcBackend,
  type DisplayInfo,
  type VcpProperty,
  type VcpReading,
} from "./backend.ts";

/** PHYSICAL_MONITOR { HANDLE hPhysicalMonitor; WCHAR szPhysicalMonitorDescription[128]; } */
const PHYSICAL_MONITOR_SIZE = 8 + 128 * 2;
const DESCRIPTION_OFFSET = 8;
const DESCRIPTION_CHARS = 128;

const VCP_CODE: Record<VcpProperty, number> = {
  // m1ddc の headers/i2c.h と同じ割り当て
  input: 0x60,
  luminance: 0x10,
  contrast: 0x12,
  volume: 0x62,
  mute: 0x8d,
  pbp: 0xe9,
  "pbp-input": 0xe8,
};

/**
 * DDC の応答は 16 bit (MH/ML) で返るが、ddc が読むプロパティの値はどれも下位 1 バイトに
 * 収まる。U3223QE は VCP 0x60 の応答の上位バイトにも同じ値を載せてくる (0x1111 = HDMI)
 * ので、下位バイトだけを採用して m1ddc 側の値と揃える。
 */
function lowByte(value: number): number {
  return value & 0xff;
}

interface PhysicalMonitor {
  info: DisplayInfo;
  handle: bigint;
}

function symbols() {
  const user32 = dlopen("user32.dll", {
    EnumDisplayMonitors: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.function, FFIType.ptr],
      returns: FFIType.i32,
    },
  });

  const dxva2 = dlopen("dxva2.dll", {
    GetNumberOfPhysicalMonitorsFromHMONITOR: {
      args: [FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    GetPhysicalMonitorsFromHMONITOR: {
      args: [FFIType.u64, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    DestroyPhysicalMonitors: {
      args: [FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    GetVCPFeatureAndVCPFeatureReply: {
      args: [FFIType.u64, FFIType.u8, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    SetVCPFeature: {
      args: [FFIType.u64, FFIType.u8, FFIType.u32],
      returns: FFIType.i32,
    },
    GetCapabilitiesStringLength: {
      args: [FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    CapabilitiesRequestAndCapabilitiesReply: {
      args: [FFIType.u64, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  });

  return { user32, dxva2 };
}

type Symbols = ReturnType<typeof symbols>;

export class Win32Backend implements DdcBackend {
  readonly name = "dxva2";
  // API 呼び出し自体が 1 回 50ms 前後かかり、その中で待ちが入る。
  // m1ddc ほど間隔を空けなくても応答は混ざらない
  readonly minIntervalMs = 30;
  // 読み取りは概ね安定していて、2 回一致は普通 2 回で取れる
  readonly readAttempts = 6;
  // 自分自身の入力へ戻すと Windows がディスプレイを認識し直す。実測で応答が戻るまで
  // 10 秒前後かかることがあり、macOS 側より大幅に長い (docs/ddc-findings.md 7 節)
  readonly verifyWindowMs = 20_000;
  readonly readFailureHint =
    "Check that DDC/CI is enabled in the monitor's on-screen menu, " +
    "and that no other app (Dell Display Manager, Monitorian, ...) is talking to it.";

  #lib: Symbols | null = null;
  /** GetPhysicalMonitorsFromHMONITOR に渡したバッファ。解放に同じものが要る */
  #blocks: { count: number; buffer: Uint8Array }[] = [];
  #monitors: PhysicalMonitor[] | null = null;

  #symbols(): Symbols {
    if (this.#lib) return this.#lib;
    try {
      this.#lib = symbols();
    } catch (err) {
      throw new Error(
        `Could not load the Windows monitor configuration API (dxva2.dll): ${String(err)}`,
      );
    }
    return this.#lib;
  }

  /** EnumDisplayMonitors で HMONITOR を集める */
  #hmonitors(): bigint[] {
    const { user32 } = this.#symbols();
    const found: bigint[] = [];
    const callback = new JSCallback(
      (hmonitor: bigint) => {
        found.push(hmonitor);
        return 1;
      },
      {
        args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    );
    try {
      const ok = user32.symbols.EnumDisplayMonitors(null, null, callback.ptr, null);
      if (!ok) throw new DdcError("EnumDisplayMonitors failed", "user32!EnumDisplayMonitors");
    } finally {
      callback.close();
    }
    return found;
  }

  #release(): void {
    if (this.#blocks.length === 0) return;
    const { dxva2 } = this.#symbols();
    for (const block of this.#blocks) {
      dxva2.symbols.DestroyPhysicalMonitors(block.count, ptr(block.buffer));
    }
    this.#blocks = [];
    this.#monitors = null;
  }

  /**
   * 物理モニタを開き直す。
   *
   * 自分自身の入力へ戻した直後は Windows がディスプレイを認識し直し、掴んだままの
   * ハンドルが無効になりうる。listDisplays() が呼ばれるたびに開き直すことで、
   * 1 プロセスが長く生きても古いハンドルを持ち越さないようにしている。
   */
  #enumerate(): PhysicalMonitor[] {
    const { dxva2 } = this.#symbols();
    this.#release();

    const monitors: PhysicalMonitor[] = [];
    const countBuf = new Uint32Array(1);

    for (const hmonitor of this.#hmonitors()) {
      if (!dxva2.symbols.GetNumberOfPhysicalMonitorsFromHMONITOR(hmonitor, ptr(countBuf))) {
        // DDC/CI を持たない表示面 (リモートデスクトップなど) はここで落ちる。飛ばす
        continue;
      }
      const count = countBuf[0] ?? 0;
      if (count === 0) continue;

      const buffer = new Uint8Array(PHYSICAL_MONITOR_SIZE * count);
      if (!dxva2.symbols.GetPhysicalMonitorsFromHMONITOR(hmonitor, count, ptr(buffer))) continue;
      this.#blocks.push({ count, buffer });

      const view = new DataView(buffer.buffer);
      for (let i = 0; i < count; i++) {
        const base = i * PHYSICAL_MONITOR_SIZE;
        const chars: number[] = [];
        for (let c = 0; c < DESCRIPTION_CHARS; c++) {
          const ch = view.getUint16(base + DESCRIPTION_OFFSET + c * 2, true);
          if (ch === 0) break;
          chars.push(ch);
        }
        monitors.push({
          handle: view.getBigUint64(base, true),
          info: {
            index: monitors.length + 1,
            name: String.fromCharCode(...chars),
            id: String(monitors.length + 1),
          },
        });
      }
    }

    this.#monitors = monitors;
    return monitors;
  }

  /**
   * id は列挙順の番号なので、**ここで勝手に列挙し直してはいけない。**
   * モニタが 1 台抜けると番号が繰り上がり、同じ id が別のモニタを指してしまう。
   * 列挙のやり直しは listDisplays() 経由でのみ行い、呼び出し側 (resolveDisplay) に
   * 名前から引き直させる。
   */
  #monitor(id: string): PhysicalMonitor {
    const monitors = this.#monitors ?? this.#enumerate();
    const found = monitors.find((m) => m.info.id === id);
    if (found) return found;
    throw new Error(`Display "${id}" is no longer connected.`);
  }

  async listDisplays(): Promise<DisplayInfo[]> {
    return this.#enumerate().map((m) => m.info);
  }

  async get(id: string, property: VcpProperty): Promise<VcpReading> {
    const { dxva2 } = this.#symbols();
    const monitor = this.#monitor(id);
    const type = new Uint32Array(1);
    const current = new Uint32Array(1);
    const max = new Uint32Array(1);

    const ok = dxva2.symbols.GetVCPFeatureAndVCPFeatureReply(
      monitor.handle,
      VCP_CODE[property],
      ptr(type),
      ptr(current),
      ptr(max),
    );
    if (!ok) {
      throw new DdcError(
        `The display did not answer a read of ${property}`,
        `dxva2!GetVCPFeatureAndVCPFeatureReply(0x${VCP_CODE[property].toString(16)})`,
      );
    }
    return {
      value: lowByte(current[0] ?? 0),
      max: isContinuous(property) ? lowByte(max[0] ?? 0) : null,
    };
  }

  async set(id: string, property: VcpProperty, value: number): Promise<number> {
    const { dxva2 } = this.#symbols();
    const monitor = this.#monitor(id);
    const ok = dxva2.symbols.SetVCPFeature(monitor.handle, VCP_CODE[property], value);
    if (!ok) {
      throw new DdcError(
        `The display rejected setting ${property} to ${value}`,
        `dxva2!SetVCPFeature(0x${VCP_CODE[property].toString(16)}, ${value})`,
      );
    }
    // SetVCPFeature は成否しか返さないので、要求値をそのまま返す
    return value;
  }

  async capabilities(id: string): Promise<string | null> {
    const { dxva2 } = this.#symbols();
    const monitor = this.#monitor(id);
    const lengthBuf = new Uint32Array(1);
    if (!dxva2.symbols.GetCapabilitiesStringLength(monitor.handle, ptr(lengthBuf))) return null;

    const length = lengthBuf[0] ?? 0;
    if (length === 0) return null;

    // 長さには終端の NUL が含まれる。返るのは ASCII
    const buffer = new Uint8Array(length);
    if (!dxva2.symbols.CapabilitiesRequestAndCapabilitiesReply(monitor.handle, ptr(buffer), length))
      return null;

    const end = buffer.indexOf(0);
    return new TextDecoder().decode(end === -1 ? buffer : buffer.subarray(0, end));
  }

  isPlausible(reading: VcpReading, property: VcpProperty): boolean {
    const { value, max } = reading;
    if (!Number.isInteger(value)) return false;
    if (value < 0 || value > 255) return false;
    // 連続値なら最大値を超えたものは捨てられる。
    // 入力ソースのような非連続値の max は意味を持たないので見ない
    if (isContinuous(property) && max !== null && max > 0 && value > max) return false;
    return true;
  }

  close(): void {
    this.#release();
  }
}
