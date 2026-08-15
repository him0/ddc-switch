import { Ddc, createBackend, type DisplayInfo } from "./ddc.ts";
import { saveState, type Config } from "./config.ts";

export interface InputState {
  value: number;
  /** config の inputs で この値に割り当てられている論理名 (複数可) */
  names: string[];
}

export interface Status {
  display: DisplayInfo;
  input: InputState;
  luminance: number | null;
  contrast: number | null;
  volume: number | null;
}

export interface SwitchResult {
  requested: string;
  target: InputState;
  previous: InputState;
  /** 既にその入力だったため DDC を叩かなかった */
  noop: boolean;
  /** 切替後に読み直した値。検証できなかった場合は null */
  verified: number | null;
  display: DisplayInfo;
}

/**
 * 入力切替まわりのドメインロジック。
 * 1 インスタンスが 1 つの Ddc (= 1 本のコマンドキュー) を持つので、
 * 同じインスタンスを使い回す限り DDC コマンドは直列化される。
 */
export class MonitorService {
  #ddc: Ddc;

  constructor(private config: Config) {
    this.#ddc = new Ddc(createBackend(config.m1ddcPath));
  }

  /** 論理名または数値文字列を VCP 0x60 の値に解決する。 */
  resolveInput(target: string): number {
    const key = target.trim().toLowerCase();
    const mapped = this.config.inputs[key];
    if (typeof mapped === "number") return mapped;

    if (/^\d+$/.test(key)) return Number(key);
    if (/^0x[0-9a-f]+$/.test(key)) return Number.parseInt(key, 16);

    const known = Object.keys(this.config.inputs).join(", ");
    throw new Error(
      `Unknown input "${target}". Available names: ${known} (a raw VCP value also works)`,
    );
  }

  /** VCP 値から論理名を逆引きする。 */
  namesFor(value: number): string[] {
    return Object.entries(this.config.inputs)
      .filter(([, v]) => v === value)
      .map(([name]) => name);
  }

  #inputState(value: number): InputState {
    return { value, names: this.namesFor(value) };
  }

  display(): Promise<DisplayInfo> {
    return this.#ddc.resolveDisplay(this.config.display);
  }

  listDisplays() {
    return this.#ddc.listDisplays();
  }

  async status(): Promise<Status> {
    const display = await this.display();
    const input = await this.#ddc.getInput(display.id);
    // 同じプロパティを連続で読む方が安定するので、並行にせず 1 つずつ読む。
    // 輝度などは機種やタイミングによって読めないことがあるが、失敗しても status 全体は返す。
    const luminance = await this.#ddc.getLuminance(display.id).catch(() => null);
    const contrast = await this.#ddc.getContrast(display.id).catch(() => null);
    const volume = await this.#ddc.getVolume(display.id).catch(() => null);
    return { display, input: this.#inputState(input), luminance, contrast, volume };
  }

  async switchInput(target: string): Promise<SwitchResult> {
    const value = this.resolveInput(target);
    const display = await this.display();
    const current = await this.#ddc.getInput(display.id);

    if (current === value) {
      return {
        requested: target,
        target: this.#inputState(value),
        previous: this.#inputState(current),
        noop: true,
        verified: current,
        display,
      };
    }

    await this.#ddc.setInput(display.id, value);
    await saveState({ lastInput: target, lastInputAt: new Date().toISOString() });

    // 切替直後はモニタ側の応答が落ち着かない。特にこのマシン自身が繋がっている入力へ
    // 戻したときは、リンクの再確立中で読み取りに失敗する時間帯がある。
    // まず一息置いてから、バックエンドごとの猶予いっぱいまで読み直す。
    await Bun.sleep(1500);
    const verified = await this.#verifySwitch();

    return {
      requested: target,
      target: this.#inputState(value),
      previous: this.#inputState(current),
      noop: false,
      verified,
      display,
    };
  }

  /**
   * 切替後の読み戻し。
   *
   * 切替直後はモニタが応答しない時間帯があり、その長さは環境で違う
   * (自分自身の入力へ戻した Windows では 10 秒前後)。猶予いっぱいまで読み直し、
   * それでも読めなければ null を返す。切替自体は成功していることが多いので、
   * ここで失敗しても例外にはしない。
   *
   * 毎回 display() から引き直しているのは、Windows ではこの間にディスプレイが
   * 一度 OS から消えて出てくることがあり、掴んだままのハンドルが無効になるため。
   */
  async #verifySwitch(): Promise<number | null> {
    const deadline = performance.now() + this.#ddc.verifyWindowMs;
    for (;;) {
      try {
        const display = await this.display();
        return await this.#ddc.getInput(display.id);
      } catch {
        if (performance.now() >= deadline) return null;
        await Bun.sleep(500);
      }
    }
  }

  /** 現在の入力を、指定した2つの論理名の間で往復させる。 */
  async toggleInput(a: string, b: string): Promise<SwitchResult> {
    const valueA = this.resolveInput(a);
    const display = await this.display();
    const current = await this.#ddc.getInput(display.id);
    return this.switchInput(current === valueA ? b : a);
  }

  async setLuminance(value: number): Promise<number> {
    const display = await this.display();
    return this.#ddc.setLuminance(display.id, value);
  }

  async setContrast(value: number): Promise<number> {
    const display = await this.display();
    return this.#ddc.setContrast(display.id, value);
  }

  async setVolume(value: number): Promise<number> {
    const display = await this.display();
    return this.#ddc.setVolume(display.id, value);
  }

  async setMute(muted: boolean): Promise<number> {
    const display = await this.display();
    return this.#ddc.setMute(display.id, muted);
  }

  async setPbp(mode: number, secondInput?: string): Promise<{ mode: number; secondInput?: number }> {
    const display = await this.display();
    await this.#ddc.setPbp(display.id, mode);
    if (secondInput === undefined) return { mode };
    const value = this.resolveInput(secondInput);
    await this.#ddc.setPbpInput(display.id, value);
    return { mode, secondInput: value };
  }

  inputNames(): Record<string, number> {
    return { ...this.config.inputs };
  }

  /**
   * MCCS の capabilities 文字列と、そこから読み取った VCP 0x60 の対応値。
   * 新しいモニタの config.inputs を書くときの種になる。
   * 読めないバックエンド (macOS の m1ddc) では raw が null になる。
   */
  async capabilities(): Promise<{ display: DisplayInfo; raw: string | null; inputs: number[] }> {
    const display = await this.display();
    const raw = await this.#ddc.capabilities(display.id);
    return { display, raw, inputs: raw ? parseInputCodes(raw) : [] };
  }

  /** 掴んだリソースを解放する。 */
  close(): void {
    this.#ddc.close();
  }
}

/**
 * capabilities 文字列から VCP 0x60 が取りうる値を抜き出す。
 * 例: "...vcp(02 04 ... 60(1B 0F 11 ) AA(01 02 04 )...)" -> [27, 15, 17]
 */
export function parseInputCodes(capabilities: string): number[] {
  const m = /(?:^|[\s(])60\(([0-9A-Fa-f\s]*)\)/.exec(capabilities);
  if (!m) return [];
  return (m[1] ?? "")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => Number.parseInt(token, 16))
    .filter((value) => Number.isInteger(value));
}
