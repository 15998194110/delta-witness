import fs from "node:fs";
import path from "node:path";

const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must be set to owner/repository before npm publish");
}

const packagePath = path.resolve("package.json");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
packageJson.repository = {
  ...(typeof packageJson.repository === "object" && packageJson.repository ? packageJson.repository : {}),
  type: "git",
  url: `https://github.com/${repository}`,
};
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`Prepared ${packageJson.name} repository metadata for ${repository}`);
