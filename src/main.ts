#!/usr/bin/env bun
/**
 * エントリポイント。ビルドすると単一バイナリ dist/ddc になる。
 */
import { runCli } from "./cli.ts";

try {
  process.exit(await runCli(process.argv.slice(2)));
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
