import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must be owner/repository");
}
if (!token) throw new Error("GITHUB_TOKEN is required");

let input = "";
for await (const chunk of process.stdin) input += chunk;
const secrets = JSON.parse(input);
if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
  throw new Error("stdin must be a JSON object of secret names and values");
}

const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};
const keyResponse = await fetch(`https://api.github.com/repos/${repository}/actions/secrets/public-key`, { headers });
if (!keyResponse.ok) throw new Error(`GitHub public key request failed: HTTP ${keyResponse.status}`);
const publicKey = await keyResponse.json();
const recipientKey = Buffer.from(publicKey.key, "base64");

for (const [name, value] of Object.entries(secrets)) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || typeof value !== "string" || !value) {
    throw new Error(`Invalid secret entry: ${name}`);
  }
  const encryptedValue = seal(Buffer.from(value, "utf8"), recipientKey).toString("base64");
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/secrets/${name}`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id: publicKey.key_id }),
  });
  if (response.status !== 201 && response.status !== 204) {
    throw new Error(`${name}: GitHub secret update failed: HTTP ${response.status}`);
  }
  console.log(`${name}=stored`);
}

function seal(message, recipientPublicKey) {
  if (recipientPublicKey.length !== nacl.box.publicKeyLength) throw new Error("Unexpected GitHub public key length");
  const ephemeral = nacl.box.keyPair();
  const nonceInput = Buffer.concat([Buffer.from(ephemeral.publicKey), recipientPublicKey]);
  const nonce = blake2b(nonceInput, { dkLen: nacl.box.nonceLength });
  const ciphertext = nacl.box(message, nonce, recipientPublicKey, ephemeral.secretKey);
  return Buffer.concat([Buffer.from(ephemeral.publicKey), Buffer.from(ciphertext)]);
}
