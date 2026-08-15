import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export const CONFIG_DIR = join(homedir(), ".config", "ddc-switch");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const STATE_DIR = join(homedir(), ".local", "state", "ddc-switch");
export const STATE_PATH = join(STATE_DIR, "state.json");

export interface Config {
  display: string;
  inputs: Record<string, number>;
  toggle: [string, string];
  m1ddcPath: string | null;
}

export const DEFAULT_CONFIG: Config = {
  display: "YOUR_DISPLAY_NAME",
  inputs: {
    "type-c": 27,
    hdmi: 17,
    dp: 15,
  },
  toggle: ["type-c", "hdmi"],
  m1ddcPath: null,
};

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) return { ...DEFAULT_CONFIG };

  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (err) {
    throw new Error(`Could not parse ${CONFIG_PATH} as JSON: ${String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${CONFIG_PATH} does not contain a JSON object`);
  }

  const user = parsed as Partial<Config>;
  const toggle = user.toggle;
  return {
    ...DEFAULT_CONFIG,
    ...user,
    inputs: user.inputs ?? DEFAULT_CONFIG.inputs,
    toggle:
      Array.isArray(toggle) && toggle.length === 2 && toggle.every((t) => typeof t === "string")
        ? [toggle[0], toggle[1]]
        : DEFAULT_CONFIG.toggle,
  };
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export interface State {
  lastInput: string | null;
  lastInputAt: string | null;
}

export async function loadState(): Promise<State> {
  const file = Bun.file(STATE_PATH);
  if (!(await file.exists())) return { lastInput: null, lastInputAt: null };
  try {
    return (await file.json()) as State;
  } catch {
    return { lastInput: null, lastInputAt: null };
  }
}

export async function saveState(state: State): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await Bun.write(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}
