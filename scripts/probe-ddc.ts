#!/usr/bin/env bun
/**
 * DDC の「生の」挙動を測るデバッグ用ツール。
 *
 * Ddc クラスの補正 (直列化・リトライ・ゴミ値除去) を意図的に通さず、バックエンドを
 * 直接叩く。別のモニタに乗り換えたときや、読み取りが怪しいときにここから調べる。
 * 読み取りしか行わないので、画面の表示は切り替わらない。
 *
 *   bun run scripts/probe-ddc.ts             分布を測る
 *   bun run scripts/probe-ddc.ts --interval  読み取り間隔を変えて安定性を比較する
 */
import { createBackend } from "../src/ddc.ts";
import { loadConfig } from "../src/config.ts";
import type { VcpProperty } from "../src/backends/backend.ts";

const PROPERTIES: VcpProperty[] = ["input", "luminance", "contrast", "volume"];

const config = await loadConfig();
const backend = createBackend(config.m1ddcPath);
const displays = await backend.listDisplays();
const display =
  displays.find((d) => d.name.toLowerCase().includes(config.display.toLowerCase())) ?? displays[0];

if (!display) {
  console.error("DDC で見えるディスプレイがありません。");
  process.exit(1);
}

console.log(`バックエンド: ${backend.name}`);
console.log(`対象: ${display.name || "(unnamed)"} (${display.id})\n`);

/** 補正なしの素の読み取り。失敗も 1 つの結果として文字列で残す */
async function rawRead(property: VcpProperty): Promise<string> {
  try {
    const reading = await backend.get(display!.id, property);
    return reading.max === null ? String(reading.value) : `${reading.value}/${reading.max}`;
  } catch (err) {
    return `ERR(${err instanceof Error ? err.message : String(err)})`;
  }
}

function distribution(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, n]) => `${value}×${n}`)
    .join("  ");
}

if (Bun.argv.includes("--interval")) {
  // プロパティを交互に読むのが一番厳しい条件なので、それで比較する
  const sequence: VcpProperty[] = ["input", "luminance", "contrast", "input", "volume", "input"];
  for (const interval of [30, 60, 120, 200, 300, 600]) {
    const inputs: string[] = [];
    for (let round = 0; round < 5; round++) {
      for (const prop of sequence) {
        await Bun.sleep(interval);
        const value = await rawRead(prop);
        if (prop === "input") inputs.push(value);
      }
    }
    console.log(`interval=${String(interval).padStart(3)}ms  input -> ${distribution(inputs)}`);
  }
} else {
  const samples = Number(Bun.argv.find((a) => /^\d+$/.test(a)) ?? 20);
  console.log(`各プロパティを ${samples} 回ずつ読みます (250ms 間隔)\n`);

  for (const prop of PROPERTIES) {
    const values: string[] = [];
    for (let i = 0; i < samples; i++) {
      await Bun.sleep(250);
      values.push(await rawRead(prop));
    }
    console.log(`get ${prop.padEnd(10)} -> ${distribution(values)}`);
  }

  const caps = await backend.capabilities(display.id);
  if (caps) console.log(`\ncapabilities: ${caps}`);
}

console.log(
  "\n真値は繰り返しの中で多数を占める値。macOS (m1ddc) では 110 (0x6E) のゴミ値が" +
    "\n約 45% 混ざる。それ以外の値が混ざるなら src/backends/ の isPlausible を見直す。",
);

backend.close();
