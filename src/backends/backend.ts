/**
 * DDC/CI をどう叩くかのプラットフォーム差を吸収する層。
 *
 * ここより上 (src/ddc.ts) は「直列化・リトライ・ゴミ値の除去」だけを見る。
 * ここより下 (m1ddc.ts / win32.ts) は「1 回の read/write」だけを見る。
 *
 * 実装:
 *   macOS   m1ddc を spawn する      -> m1ddc.ts
 *   Windows dxva2.dll を bun:ffi で叩く -> win32.ts
 */

export interface DisplayInfo {
  /** 表示用の通し番号 (1 始まり) */
  index: number;
  name: string;
  /**
   * バックエンド内で 1 台を特定する不透明な文字列。
   * macOS は m1ddc の UUID、Windows は物理モニタの列挙順。
   * 中身に依存してよいのはバックエンド自身だけ。
   */
  id: string;
}

/** ddc が扱う VCP プロパティ。値はバックエンドがコードに落とす */
export type VcpProperty =
  | "input"
  | "luminance"
  | "contrast"
  | "volume"
  | "mute"
  | "pbp"
  | "pbp-input";

export interface VcpReading {
  value: number;
  /** 連続値プロパティの最大値。取れないバックエンドは null */
  max: number | null;
}

export class DdcError extends Error {
  constructor(
    message: string,
    /** 何をしようとして失敗したか (m1ddc のコマンド行、Win32 API 名など) */
    readonly detail: string,
  ) {
    super(message);
    this.name = "DdcError";
  }
}

export interface DdcBackend {
  /** エラーメッセージに出す名前 */
  readonly name: string;

  /** DDC コマンド同士の最小間隔 (ms)。短すぎると応答が混ざる */
  readonly minIntervalMs: number;

  /** 安定した読み値を得るための最大読み取り回数 */
  readonly readAttempts: number;

  /**
   * 入力を切り替えてから読み戻しを諦めるまでの猶予 (ms)。
   * 切替直後はリンクの再確立中でモニタが応答しない時間帯があり、その長さが環境で違う。
   */
  readonly verifyWindowMs: number;

  /** 読み取りが安定しなかったときにエラーへ添える、バックエンド固有の助言 */
  readonly readFailureHint: string;

  listDisplays(): Promise<DisplayInfo[]>;

  get(id: string, property: VcpProperty): Promise<VcpReading>;

  /** 設定した値を返す。エコーバックを読めないバックエンドは要求値をそのまま返す */
  set(id: string, property: VcpProperty, value: number): Promise<number>;

  /** MCCS の capabilities 文字列。取れないバックエンドは null */
  capabilities(id: string): Promise<string | null>;

  /**
   * 読み値が明らかにおかしくないか判定する。
   * どう壊れるかはバックエンド固有 (m1ddc の 110、Win32 の max 超過) なのでここに置く。
   */
  isPlausible(reading: VcpReading, property: VcpProperty): boolean;

  /** 掴んだリソースを解放する。プロセス終了時に呼ばれる */
  close(): void;
}

/** 連続値プロパティ (0..max の目盛りを持つもの) かどうか */
export function isContinuous(property: VcpProperty): boolean {
  return property === "luminance" || property === "contrast" || property === "volume";
}
