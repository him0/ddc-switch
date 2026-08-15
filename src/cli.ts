import { loadConfig } from "./config.ts";
import { MonitorService, type Status, type SwitchResult } from "./service.ts";
import { VERSION } from "./version.ts";

const USAGE = `ddc - switch the input source of a DDC/CI display

Inputs are named after the port on the monitor (type-c / hdmi / dp), not after
the machine plugged into it. Run "ddc inputs" for the names on this setup.

Usage:
  ddc                      Show the current state
  ddc status               Same as above
  ddc <input>              Switch to that input (e.g. ddc hdmi / ddc type-c)
  ddc switch <input|value> Switch input (use when the name collides with a subcommand)
  ddc toggle [a] [b]       Toggle between two inputs (default: the pair in the config)
  ddc inputs               List the configured input names
  ddc displays             List the displays visible over DDC
  ddc caps                 Show what the display reports it supports (Windows only)
  ddc brightness <0-100>   Set brightness
  ddc contrast <0-100>     Set contrast
  ddc volume <0-100>       Set volume
  ddc mute / ddc unmute    Toggle mute
  ddc pbp <mode> [input]   Set PBP mode (off:0 / 50-50:36 etc.)
  ddc version              Print the version

Options:
  --json      Print the result as JSON
  -h, --help  Show this help
`;

const COLOR = process.env.NO_COLOR
  ? false
  : process.env.FORCE_COLOR
    ? true
    : process.stdout.isTTY === true;

const paint = (code: string, text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t: string) => paint("1", t);
const dim = (t: string) => paint("2", t);
const green = (t: string) => paint("32", t);

const label = (text: string) => text.padEnd(13);

const inputLabel = (names: string[], value: number) =>
  names.length ? names.join(" / ") : `VCP ${value}`;

function formatStatus(status: Status): string {
  const lines = [
    `${bold(status.display.name || "(unnamed)")} ${dim(`[${status.display.index}]`)}`,
    "",
    label("Input") +
      green(inputLabel(status.input.names, status.input.value)) +
      dim(`  0x60 = ${status.input.value}`),
  ];
  if (status.luminance !== null) lines.push(label("Brightness") + status.luminance);
  if (status.contrast !== null) lines.push(label("Contrast") + status.contrast);
  if (status.volume !== null) lines.push(label("Volume") + status.volume);
  return lines.join("\n");
}

function formatSwitch(result: SwitchResult): string {
  const to = inputLabel(result.target.names, result.target.value);
  if (result.noop) return `Already on ${green(to)}`;

  const from = inputLabel(result.previous.names, result.previous.value);
  const head = `${dim(from)} → ${green(to)}`;
  if (result.verified === null) {
    return `${head}\n${dim("The switch command was sent, but reading the value back right after it failed, so this is unconfirmed.")}`;
  }
  if (result.verified !== result.target.value) {
    return `${head}\nWarning: read back ${result.verified} instead of the requested ${result.target.value}. This monitor may not support that input.`;
  }
  return head;
}

function requireArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function requireNumericArg(args: string[], index: number, name: string): number {
  const raw = requireArg(args, index, name);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number (got "${raw}")`);
  return value;
}

export async function runCli(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const args = argv.filter((a) => !a.startsWith("--"));

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }

  if (args[0] === "version" || argv.includes("-v") || argv.includes("--version")) {
    console.log(json ? JSON.stringify({ version: VERSION }, null, 2) : VERSION);
    return 0;
  }

  const config = await loadConfig();
  const service = new MonitorService(config);

  const emit = (value: unknown, human: string) => {
    console.log(json ? JSON.stringify(value, null, 2) : human);
  };

  const command = args[0] ?? "status";

  switch (command) {
    case "status": {
      const status = await service.status();
      emit(status, formatStatus(status));
      return 0;
    }
    case "switch": {
      const result = await service.switchInput(requireArg(args, 1, "input name"));
      emit(result, formatSwitch(result));
      return 0;
    }
    case "toggle": {
      const [a, b] = config.toggle;
      const result = await service.toggleInput(args[1] ?? a, args[2] ?? b);
      emit(result, formatSwitch(result));
      return 0;
    }
    case "inputs": {
      const inputs = service.inputNames();
      emit(
        inputs,
        Object.entries(inputs)
          .map(([name, value]) => `${name.padEnd(10)} ${value}`)
          .join("\n"),
      );
      return 0;
    }
    case "displays": {
      const displays = await service.listDisplays();
      emit(
        displays,
        displays.map((d) => `[${d.index}] ${d.name || "(unnamed)"}  ${dim(d.id)}`).join("\n"),
      );
      return 0;
    }
    case "caps": {
      const caps = await service.capabilities();
      emit(
        caps,
        caps.raw === null
          ? "This backend cannot read the capabilities string (m1ddc does not support it)."
          : [
              `${bold(caps.display.name || "(unnamed)")} ${dim(`[${caps.display.index}]`)}`,
              "",
              label("Inputs") +
                (caps.inputs.length
                  ? caps.inputs
                      .map((v) => {
                        const names = service.namesFor(v);
                        return names.length ? `${names.join("/")} (${v})` : String(v);
                      })
                      .join(", ")
                  : "(not reported)"),
              "",
              dim(caps.raw),
            ].join("\n"),
      );
      return 0;
    }
    case "brightness": {
      const value = await service.setLuminance(requireNumericArg(args, 1, "brightness"));
      emit({ luminance: value }, `Brightness set to ${green(String(value))}`);
      return 0;
    }
    case "contrast": {
      const value = await service.setContrast(requireNumericArg(args, 1, "contrast"));
      emit({ contrast: value }, `Contrast set to ${green(String(value))}`);
      return 0;
    }
    case "volume": {
      const value = await service.setVolume(requireNumericArg(args, 1, "volume"));
      emit({ volume: value }, `Volume set to ${green(String(value))}`);
      return 0;
    }
    case "mute":
    case "unmute": {
      const muted = command === "mute";
      await service.setMute(muted);
      emit({ mute: muted }, muted ? "Muted" : "Unmuted");
      return 0;
    }
    case "pbp": {
      const result = await service.setPbp(requireNumericArg(args, 1, "PBP mode"), args[2]);
      emit(result, `PBP mode set to ${result.mode}`);
      return 0;
    }
    default: {
      const result = await service.switchInput(command);
      emit(result, formatSwitch(result));
      return 0;
    }
  }
}
