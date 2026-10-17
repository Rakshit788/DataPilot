import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parse } from "csv-parse";

const sampleSize = 5;
const sensitiveName = /email|phone|customer_name|first_name|last_name|address|street|zip|postal|ssn|social_security/i;
const likelyKeyName = /(^id$|_id$|^id_)/i;

type ColumnStats = {
  nulls: number;
  distinct: Set<string>;
  numbers: number;
  dates: number;
  booleans: number;
  minNumber: number | null;
  maxNumber: number | null;
  minDate: string | null;
  maxDate: string | null;
};

function emptyStats(): ColumnStats {
  return { nulls: 0, distinct: new Set(), numbers: 0, dates: 0, booleans: 0, minNumber: null, maxNumber: null, minDate: null, maxDate: null };
}

function classifyType(stats: ColumnStats, rows: number): string {
  const nonNull = rows - stats.nulls;
  if (nonNull === 0) return "unknown";
  if (stats.booleans === nonNull) return "boolean";
  if (stats.numbers === nonNull) return "number";
  if (stats.dates === nonNull) return "date/time";
  return "text";
}

async function profileFile(filePath: string) {
  const columns: string[] = [];
  const stats = new Map<string, ColumnStats>();
  const sample: Record<string, string>[] = [];
  let rows = 0;

  const parser = createReadStream(filePath).pipe(parse({
    bom: true,
    columns: (headers: string[]) => {
      const cleaned = headers.map((header) => header.trim());
      const duplicates = cleaned.filter((header, index) => cleaned.indexOf(header) !== index);
      if (duplicates.length > 0) throw new Error(`Duplicate column names: ${[...new Set(duplicates)].join(", ")}`);
      columns.push(...cleaned);
      for (const column of columns) stats.set(column, emptyStats());
      return cleaned;
    },
    skip_empty_lines: true,
    trim: true,
  }));

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    rows++;
    if (sample.length < sampleSize) sample.push(record);
    for (const column of columns) {
      const value = record[column] ?? "";
      const columnStats = stats.get(column)!;
      if (value === "") {
        columnStats.nulls++;
        continue;
      }
      columnStats.distinct.add(value);
      if (/^(true|false|yes|no)$/i.test(value)) columnStats.booleans++;
      const numeric = Number(value);
      if (value.trim() !== "" && Number.isFinite(numeric)) {
        columnStats.numbers++;
        columnStats.minNumber = columnStats.minNumber === null ? numeric : Math.min(columnStats.minNumber, numeric);
        columnStats.maxNumber = columnStats.maxNumber === null ? numeric : Math.max(columnStats.maxNumber, numeric);
      }
      if (/^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(value) && !Number.isNaN(Date.parse(value))) {
        columnStats.dates++;
        columnStats.minDate = columnStats.minDate === null || value < columnStats.minDate ? value : columnStats.minDate;
        columnStats.maxDate = columnStats.maxDate === null || value > columnStats.maxDate ? value : columnStats.maxDate;
      }
    }
  }

  const columnProfiles = columns.map((name) => {
    const columnStats = stats.get(name)!;
    const type = classifyType(columnStats, rows);
    const unique = rows > 0 && columnStats.distinct.size === rows && columnStats.nulls === 0;
    const likelyKey = likelyKeyName.test(name);
    return {
      name,
      inferredType: type,
      nullCount: columnStats.nulls,
      nullPercent: rows === 0 ? 0 : Number(((columnStats.nulls / rows) * 100).toFixed(2)),
      distinctCount: columnStats.distinct.size,
      ...(type === "number" ? { min: columnStats.minNumber, max: columnStats.maxNumber } : {}),
      ...(type === "date/time" ? { min: columnStats.minDate, max: columnStats.maxDate } : {}),
      likelyPrimaryKey: likelyKey && unique,
      likelyJoinKey: likelyKey,
      sensitive: sensitiveName.test(name),
    };
  });

  return {
    file: basename(filePath),
    rowCount: rows,
    columns: columnProfiles,
    likelyPrimaryKeys: columnProfiles.filter((column) => column.likelyPrimaryKey).map((column) => column.name),
    likelyJoinKeys: columnProfiles.filter((column) => column.likelyJoinKey).map((column) => column.name),
    sample,
  };
}

const inputDir = resolve(process.argv[2] ?? "data/raw");
const entries = await readdir(inputDir, { withFileTypes: true });
const csvFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv")).sort((a, b) => a.name.localeCompare(b.name));

if (csvFiles.length === 0) {
  console.error(`No CSV files found in ${inputDir}. Place source files in data/raw/ or pass a directory path.`);
  process.exitCode = 1;
} else {
  for (const entry of csvFiles) {
    const profile = await profileFile(resolve(inputDir, entry.name));
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
  }
}
