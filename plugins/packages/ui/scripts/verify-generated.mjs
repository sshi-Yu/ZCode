import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const inventory = JSON.parse(await readFile(new URL("pull-inventory.json", root), "utf8"));
for (const [file, expected] of Object.entries(inventory.sha256)) {
  const actual = createHash("sha256").update(await readFile(new URL(file, root))).digest("hex");
  if (actual !== expected) throw new Error(`CLI-generated source changed: ${file}. Regenerate with ${inventory.cli}; do not hand-edit.`);
}
process.stdout.write(`Verified ${Object.keys(inventory.sha256).length} unmodified CLI-generated sources (${inventory.cli}).\n`);
