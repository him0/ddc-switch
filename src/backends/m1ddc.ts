/**
 * macOS バックエンド。[m1ddc](https://github.com/waydabber/m1ddc) を spawn する。
 *
 * m1ddc は Apple Silicon の IOAVService 経由で DDC/CI を叩く。USB-C (DisplayPort
 * Alt Mode) で接続されたディスプレイが対象で、M1/M2 の内蔵 HDMI ポート経由の
 * ディスプレイは制御できない。
 *
 * 実測メモ (DELL U3223QE / M3 Pro):
 *   - 入力を HDMI に切り替えた後も USB-C 側の DDC は生きたままで、Mac 側から
 *     USB-C へ復帰させられる。外部ハードなしで往復できる。
 *   - `get input` は m1ddc の help に載っていないが動作し、VCP 0x60 の現在値を返す。
 */

import {
  DdcError,
  type DdcBackend,
  type DisplayInfo,
  type VcpProperty,
  type VcpReading,
} from "./backend.ts";

const DISPLAY_LINE = /^\[(\d+)\]\s+(.*?)\s+\(([0-9A-Fa-f-]{36})\)\s*$/;

/**
 * m1ddc の読み取りが失敗したときに返ってくるゴミ値。
 *
 * U3223QE で計測したところ、どのプロパティを読んでも約 45% の確率でこの値が返る。
 * 0x6E は DDC/CI の応答フレームの宛先アドレスそのもので、応答の解釈に失敗して
 * 先頭バイトを値として拾っていると考えられる。実際 `max luminance` が 100 を返す
 * モニタで `get luminance` が 110 を返すので、正当な値ではありえない。
 * 読み取り間隔を 600ms まで延ばしても発生率は変わらなかったため、待つのではなく
 * 「この値が来たら読み直す」で対処する。
 *
 * Windows の dxva2 経由では同じモニタでもこの現象は起きないので、m1ddc か
 * IOAVService 側の問題と見ている (docs/ddc-findings.md)。
 */
const GARBAGE_VALUE = 0x6e; // = 110

/** ddc のプロパティ名は m1ddc のサブコマンド名と一致しているのでそのまま渡せる */
const COMMAND: Record<VcpProperty, string> = {
  input: "input",
  luminance: "luminance",
  contrast: "contrast",
  volume: "volume",
  mute: "mute",
  pbp: "pbp",
  "pbp-input": "pbp-input",
};

export class M1ddcBackend implements DdcBackend {
  readonly name = "m1ddc";
  readonly minIntervalMs = 120;
  // 1 回の読み取りが約 55% でしか成功しないので、2 回一致を得るには余裕が要る
  readonly readAttempts = 10;
  // USB-C 側のリンクは切替後も生きたままなので、応答が戻るのは速い
  readonly verifyWindowMs = 5_000;
  readonly readFailureHint =
    "DDC reads through m1ddc fail about 45% of the time on this monitor; " +
    "retry, or check that no other app is talking to the display over DDC.";

  #bin: string | null;
  #resolved: string | null = null;

  constructor(m1ddcPath: string | null = null) {
    this.#bin = m1ddcPath;
  }

  /** m1ddc の実行パスを解決する。Homebrew の既定パスも探す。 */
  async binary(): Promise<string> {
    if (this.#resolved) return this.#resolved;
    const candidates = [
      this.#bin,
      Bun.which("m1ddc"),
      "/opt/homebrew/bin/m1ddc",
      "/usr/local/bin/m1ddc",
    ].filter((p): p is string => typeof p === "string" && p.length > 0);

    for (const candidate of candidates) {
      if (await Bun.file(candidate).exists()) {
        this.#resolved = candidate;
        return candidate;
      }
    }
    throw new Error(
      "m1ddc not found. Install it with `brew install m1ddc`, " +
        "or set an absolute path in m1ddcPath in config.json.",
    );
  }

  async #run(args: string[]): Promise<string> {
    const bin = await this.binary();
    const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      // m1ddc はエラーメッセージを stdout に出すことがあるので両方拾う
      const detail = (stderr.trim() || stdout.trim() || "(no output)").replace(/\s+/g, " ");
      throw new DdcError(detail, `${[bin, ...args].join(" ")} (exit ${exitCode})`);
    }
    return stdout.trim();
  }

  async listDisplays(): Promise<DisplayInfo[]> {
    const out = await this.#run(["display", "list"]);
    const displays: DisplayInfo[] = [];
    for (const line of out.split("\n")) {
      const m = DISPLAY_LINE.exec(line.trim());
      if (!m) continue;
      const [, index, name, uuid] = m as unknown as [string, string, string, string];
      displays.push({
        index: Number(index),
        // 内蔵ディスプレイなどは名前が "(null)" で返ってくる
        name: name === "(null)" ? "" : name,
        id: uuid,
      });
    }
    return displays;
  }

  async get(id: string, property: VcpProperty): Promise<VcpReading> {
    const raw = await this.#run(["display", id, "get", COMMAND[property]]);
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new DdcError(`m1ddc returned "${raw}"`, `get ${property}`);
    }
    // m1ddc の `max` は別コマンドで、読むたびに DDC 往復が増える。
    // 妥当性の判定はゴミ値の除去で足りているので取りに行かない
    return { value, max: null };
  }

  async set(id: string, property: VcpProperty, value: number): Promise<number> {
    const out = await this.#run(["display", id, "set", COMMAND[property], String(value)]);
    const echoed = Number(out);
    return Number.isFinite(echoed) ? echoed : value;
  }

  /** m1ddc は capabilities 文字列を読めない */
  async capabilities(): Promise<string | null> {
    return null;
  }

  isPlausible(reading: VcpReading): boolean {
    const { value } = reading;
    if (!Number.isInteger(value)) return false;
    if (value < 0 || value > 255) return false;
    return value !== GARBAGE_VALUE;
  }

  close(): void {}
}
