import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { profileCsvStream } from "./profile-csv.js";

const inputDir = resolve(process.argv[2] ?? "data/raw");
const entries = await readdir(inputDir, { withFileTypes: true });
const csvFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv")).sort((a, b) => a.name.localeCompare(b.name));

if (csvFiles.length === 0) {
  console.error(`No CSV files found in ${inputDir}. Place source files in data/raw/ or pass a directory path.`);
  process.exitCode = 1;
} else {
  for (const entry of csvFiles) {
    const profile = await profileCsvStream(createReadStream(resolve(inputDir, entry.name)), entry.name);
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
  }
}
