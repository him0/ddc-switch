/**
 * DDC/CI の呼び出し口。プラットフォーム差は src/backends/ が吸収する。
 *
 * このクラスの仕事は 3 つだけ:
 *   1. 全 DDC コマンドを 1 本のキューに直列化する (DDC は I2C の上なので多重化できない)
 *   2. 読み取りを「同じ値が 2 回返る」まで繰り返して安定値を採る
 *   3. バックエンドが「ありえない」と判断した読み値を捨てる
 *
 * 新しい VCP 操作を足すときは必ずここを経由させること。バックエンドを直接叩くと
 * 上の補正が効かず、macOS では 45% の確率で嘘の値を掴む (docs/ddc-findings.md)。
 */

import { M1ddcBackend } from "./backends/m1ddc.ts";
import { Win32Backend } from "./backends/win32.ts";
import { DdcError, type DdcBackend, type DisplayInfo, type VcpProperty } from "./backends/backend.ts";

export { DdcError };
export type { DisplayInfo, VcpProperty };

export interface DdcOptions {
  /** DDC コマンド同士の最小間隔 (ms)。既定はバックエンドごとの実測値 */
  minIntervalMs?: number;
  /** 安定した読み値を得るための最大読み取り回数 */
  readAttempts?: number;
}

/** 実行中のプラットフォーム向けのバックエンドを組み立てる。 */
export function createBackend(m1ddcPath: string | null = null): DdcBackend {
  switch (process.platform) {
    case "darwin":
      return new M1ddcBackend(m1ddcPath);
    case "win32":
      return new Win32Backend();
    default:
      throw new Error(
        `ddc supports macOS and Windows; this is ${process.platform}. ` +
          "On Linux, ddcutil covers the same ground.",
      );
  }
}

export class Ddc {
  #backend: DdcBackend;
  #minInterval: number;
  #readAttempts: number;

  /** DDC/CI は I2C の上に乗っていて多重化できないので、全コマンドを 1 本に直列化する */
  #queue: Promise<unknown> = Promise.resolve();
  #lastRunAt = 0;

  constructor(backend: DdcBackend, options: DdcOptions = {}) {
    this.#backend = backend;
    this.#minInterval = options.minIntervalMs ?? backend.minIntervalMs;
    this.#readAttempts = options.readAttempts ?? backend.readAttempts;
  }

  get backendName(): string {
    return this.#backend.name;
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      const wait = this.#minInterval - (performance.now() - this.#lastRunAt);
      if (wait > 0) await Bun.sleep(wait);
      try {
        return await task();
      } finally {
        this.#lastRunAt = performance.now();
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  listDisplays(): Promise<DisplayInfo[]> {
    return this.#serialize(() => this.#backend.listDisplays());
  }

  capabilities(id: string): Promise<string | null> {
    return this.#serialize(() => this.#backend.capabilities(id));
  }

  /**
   * 対象ディスプレイを解決する。バックエンド固有の ID / インデックス番号 /
   * 名前の部分一致 (大文字小文字無視) を受け付ける。毎回一覧を引き直すので、
   * 抜き差しで ID が変わっても追従する。
   */
  async resolveDisplay(query: string): Promise<DisplayInfo> {
    const displays = await this.listDisplays();
    if (displays.length === 0) {
      throw new Error("No DDC-controllable display found.");
    }

    const byId = displays.find((d) => d.id.toLowerCase() === query.toLowerCase());
    if (byId) return byId;

    if (/^\d+$/.test(query)) {
      const byIndex = displays.find((d) => d.index === Number(query));
      if (byIndex) return byIndex;
    }

    const needle = query.toLowerCase();
    const byName = displays.filter((d) => d.name.toLowerCase().includes(needle));
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      throw new Error(
        `"${query}" matches multiple displays: ${byName.map((d) => d.name).join(", ")}`,
      );
    }

    const known = displays.map((d) => `[${d.index}] ${d.name || "(unnamed)"}`).join(", ");
    throw new Error(`No display matches "${query}". Detected: ${known}`);
  }

  /**
   * VCP 値を読む。
   *
   * DDC の read は取りこぼしがある。バックエンドが「ありえない」と判断した値を捨てた上で、
   * 「同じ値が 2 回続けて返る」まで読み直して安定値を採用する。
   *
   * 読み取り自体が失敗した場合も (Windows の GetVCPFeature... が false を返す、
   * m1ddc が非ゼロ終了する) 一時的なものとして扱い、同じ回数だけ読み直す。
   * モニタがスリープから起きる途中や入力切替の直後はここに落ちる。
   */
  async #get(id: string, property: VcpProperty): Promise<number> {
    let previous: number | null = null;
    let last = "none";

    for (let attempt = 0; attempt < this.#readAttempts; attempt++) {
      let reading;
      try {
        reading = await this.#serialize(() => this.#backend.get(id, property));
      } catch (err) {
        // 「情報なし」として読み飛ばす。全部失敗したときだけ最後の理由を報告する
        last = err instanceof Error ? err.message : String(err);
        continue;
      }

      last = String(reading.value);
      if (!this.#backend.isPlausible(reading, property)) {
        // ゴミも「情報なし」として読み飛ばす。ここで previous を捨ててしまうと、
        // 真値とゴミが交互に返るパターン (27, 110, 27, ...) で永遠に一致しない。
        continue;
      }
      if (previous === reading.value) return reading.value;
      previous = reading.value;
    }

    throw new Error(
      `Could not get a stable read of ${property} (last: ${last}). ` +
        this.#backend.readFailureHint,
    );
  }

  /**
   * 入力を切り替えた直後、読み戻しを諦めるまでの猶予 (ms)。
   * 実際に待つのは service 側 (ディスプレイの解決からやり直す必要があるため)。
   */
  get verifyWindowMs(): number {
    return this.#backend.verifyWindowMs;
  }

  #set(id: string, property: VcpProperty, value: number): Promise<number> {
    return this.#serialize(() => this.#backend.set(id, property, value));
  }

  /** 現在の入力ソース (VCP 0x60) を読む。 */
  getInput(id: string): Promise<number> {
    return this.#get(id, "input");
  }

  /** 入力ソース (VCP 0x60) を切り替える。 */
  setInput(id: string, value: number): Promise<number> {
    return this.#set(id, "input", value);
  }

  getLuminance(id: string): Promise<number> {
    return this.#get(id, "luminance");
  }

  setLuminance(id: string, value: number): Promise<number> {
    return this.#set(id, "luminance", value);
  }

  getContrast(id: string): Promise<number> {
    return this.#get(id, "contrast");
  }

  setContrast(id: string, value: number): Promise<number> {
    return this.#set(id, "contrast", value);
  }

  getVolume(id: string): Promise<number> {
    return this.#get(id, "volume");
  }

  setVolume(id: string, value: number): Promise<number> {
    return this.#set(id, "volume", value);
  }

  setMute(id: string, muted: boolean): Promise<number> {
    return this.#set(id, "mute", muted ? 1 : 2);
  }

  /** PBP モード。U3223QE は off:0 / 50-50:36 などに対応。 */
  setPbp(id: string, mode: number): Promise<number> {
    return this.#set(id, "pbp", mode);
  }

  setPbpInput(id: string, value: number): Promise<number> {
    return this.#set(id, "pbp-input", value);
  }

  close(): void {
    this.#backend.close();
  }
}
