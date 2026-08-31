import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../channels/base-app/", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../channels/base-app/public/.well-known/farcaster.json", import.meta.url), "utf8"));

if (!manifest.accountAssociation || !["header", "payload", "signature"].every((key) => typeof manifest.accountAssociation[key] === "string")) {
  throw new Error("manifest accountAssociation must contain string header, payload, and signature fields");
}
const app = manifest.miniapp;
for (const key of ["version", "name", "homeUrl", "iconUrl"]) if (typeof app?.[key] !== "string" || app[key].length === 0) throw new Error(`manifest miniapp.${key} is required`);
if (app.version !== "1") throw new Error("manifest miniapp.version must be 1");
for (const url of [app.homeUrl, app.iconUrl, app.splashImageUrl, app.heroImageUrl, app.ogImageUrl, ...(app.screenshotUrls ?? [])]) {
  if (url && !/^https:\/\//.test(url)) throw new Error(`manifest asset URL must use HTTPS: ${url}`);
}

function pngSize(name) {
  const bytes = readFileSync(new URL(`../channels/base-app/public/${name}`, import.meta.url));
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${name} is not PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}
const expected = { "icon.png": [1024, 1024], "splash.png": [200, 200], "hero.png": [1200, 630], "screenshot.png": [1284, 2778] };
for (const [name, [width, height]] of Object.entries(expected)) {
  const actual = pngSize(name);
  if (actual.width !== width || actual.height !== height) throw new Error(`${name} dimensions ${actual.width}x${actual.height}, expected ${width}x${height}`);
  if (name === "icon.png" && actual.colorType !== 2) throw new Error("icon.png must be RGB PNG without alpha");
}
console.log(JSON.stringify({ ok: true, root, pendingAccountAssociation: manifest.accountAssociation.header.length === 0, assets: expected }));
