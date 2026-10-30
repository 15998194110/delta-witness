#!/usr/bin/env node
// Local-only audit planner. No provider client, credentials, mutations, cleanup
// executor or network operation is imported. Output creation is exclusive.
import { open, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INPUT_BYTES = 2_000_000;
export async function loadRetentionModule() {
  // Reuse exactly the Worker source and shared canonical hashing, not a second
  // policy engine. esbuild is already installed with the local locked toolchain.
  // Build stays in memory: no package scripts/install or output files run here.
  const result = await build({ entryPoints: [resolve(root, "src/retention.ts")], bundle: true, platform: "node", format: "esm", target: "node24", write: false, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
export async function readLocalInventory(inputPath) {
  const file = await open(inputPath, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) throw new Error("invalid_inventory_file_size");
    // Read through one opened handle with a fixed ceiling. Path replacement or
    // growth after stat cannot cause unbounded allocation/readFile consumption.
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await file.read(bytes, used, bytes.length - used, used);
      if (result.bytesRead === 0) break;
      used += result.bytesRead;
    }
    if (used === 0 || used > MAX_INPUT_BYTES) throw new Error("invalid_inventory_file_size");
    return bytes.subarray(0, used);
  } finally { await file.close(); }
}
export async function main(args = process.argv.slice(2)) {
  if (args.length !== 5 || args[0] !== "--dry-run" || args[1] !== "--input" || args[3] !== "--output" || !args[2] || !args[4]) throw new Error("usage: --dry-run --input <local-inventory.json> --output <new-plan.json>");
  const inputPath = resolve(args[2]), outputPath = resolve(args[4]);
  if (inputPath === outputPath) throw new Error("output_must_be_new_and_distinct");
  const bytes = await readLocalInventory(inputPath);
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const { planRetentionDryRun } = await loadRetentionModule();
  const report = await planRetentionDryRun(input);
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { ok: true, dry_run: true, actual_deletions: 0, candidates: report.candidates.length, excluded: report.excluded.length, plan_hash: report.plan_hash };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) {
    // Never print input JSON, environment values, or raw filesystem/provider data.
    console.error(JSON.stringify({ ok: false, dry_run: true, actual_deletions: 0, error: error?.code === "EEXIST" ? "output_already_exists" : "retention_dry_run_failed" }));
    process.exitCode = 1;
  }
}
