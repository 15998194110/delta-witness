import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = root.version;
const directory = await mkdtemp(join(tmpdir(), "delta-public-npm-"));

try {
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund",
    `delta-witness-ruphussten@${version}`, `delta-witness-mcp@${version}`], directory);

  const clientUrl = pathToFileURL(join(directory, "node_modules", "delta-witness-ruphussten", "src", "index.js")).href;
  const { DeltaWitness } = await import(clientUrl);
  const client = new DeltaWitness();
  const quote = await client.quote("preflight");
  if (quote.version !== version || quote.network !== "eip155:8453") {
    throw new Error(`Unexpected public quote: ${JSON.stringify(quote)}`);
  }
  const challenge = await client.preflightChallenge({
    url: "https://example.com",
    expected: { contains: ["Example Domain"] },
  });
  if (challenge.status !== 402 || !challenge.headers["payment-required"]) {
    throw new Error(`Unexpected public Guard challenge: ${JSON.stringify(challenge)}`);
  }

  const mcpUrl = pathToFileURL(join(directory, "node_modules", "delta-witness-mcp", "dist", "index.js")).href;
  const mcp = await inspectMcp(mcpUrl);
  const tools = mcp.tools;
  const required = ["delta_quote", "delta_capture", "delta_preflight", "delta_verify_proof"];
  for (const name of required) {
    if (!tools.includes(name)) throw new Error(`Public MCP package is missing ${name}`);
  }
  if (mcp.quote.version !== version || mcp.quote.network !== "eip155:8453") {
    throw new Error(`Unexpected public MCP quote: ${JSON.stringify(mcp.quote)}`);
  }
  console.log(JSON.stringify({ ok: true, version, quote: quote.price, challenge: challenge.status, tools, mcp_quote: mcp.quote.price }));
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function inspectMcp(moduleUrl) {
  const code = `import(${JSON.stringify(moduleUrl)}).then(m => m.main()).catch(e => { console.error(e); process.exit(1); })`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  let initialized = false;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`MCP smoke timed out: ${stderr}`)), 15_000);
    let tools;
    const finish = (error, value) => {
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value);
    };
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { return finish(new Error(`Invalid MCP output: ${line}`)); }
        if (message.id === 1 && message.result && !initialized) {
          initialized = true;
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        } else if (message.id === 2 && message.result?.tools) {
          tools = message.result.tools.map((tool) => tool.name);
          child.stdin.write(JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "delta_quote", arguments: { product: "preflight" } },
          }) + "\n");
        } else if (message.id === 3 && message.result?.structuredContent) {
          return finish(undefined, { tools, quote: message.result.structuredContent });
        } else if (message.error) {
          return finish(new Error(`MCP error: ${JSON.stringify(message.error)}`));
        }
      }
    });
    child.once("error", finish);
    child.once("exit", (code) => {
      if (code !== 0 && code !== null) finish(new Error(`MCP process exited ${code}: ${stderr}`));
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "delta-release-smoke", version: "1" } },
    }) + "\n");
  });
}
