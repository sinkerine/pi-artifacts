import { readdir, readFile } from "node:fs/promises";

const inventory = {};
for (const group of ["unit", "integration", "e2e"]) {
  const files = (await readdir(`tests/${group}`)).filter((f) => /\.(test|spec)\.(ts|mjs)$/.test(f));
  if (!files.length) throw Error(`Empty ${group} project`);
  inventory[group] = files;
}
const source = (
  await Promise.all(
    ["unit", "integration", "e2e"].flatMap((group) =>
      inventory[group].map((file) => readFile(`tests/${group}/${file}`, "utf8")),
    ),
  )
).join("\n");
for (const prefix of ["U", "I", "E"])
  for (let i = 1; i <= (prefix === "I" ? 9 : 10); i++)
    if (!new RegExp(`\\b${prefix}${i}\\b`).test(source)) throw Error(`Missing ${prefix}${i} discovery group`);
if (!source.includes("V1")) throw Error("Missing V1");
console.log(JSON.stringify(inventory, null, 2));
