#!/usr/bin/env bun
/**
 * 単一の自己完結バイナリを作る。
 * mise 管理の bun に依存しない実行ファイルになるので、PATH を絞った環境
 * (Raycast, ランチャ, タスクスケジューラ) から素直に起動できる。
 */
import { $ } from "bun";
import { rm } from "node:fs/promises";

const outfile = process.platform === "win32" ? "dist/ddc.exe" : "dist/ddc";

await rm("dist", { recursive: true, force: true });
await $`bun build --compile --minify --outfile ${outfile} src/main.ts`;

const size = (await Bun.file(outfile).stat()).size;
console.log(`\nbuilt: ${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
