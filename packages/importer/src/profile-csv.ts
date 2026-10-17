import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { parse } from "csv-parse";

const sampleSize = 5;
const distinctBitmapBits = 1 << 20;
const sensitiveName = /email|phone|customer_name|first_name|last_name|address|street|zip|postal|ssn|social_security|tax.?id|taxpayer|vat.?id|\btin\b|\bein\b|bank.?account|routing/i;
const candidateKeyName = /(^id$|_id$|^id_|_key$|_code$|^product_category_name$|(?:^|_)(invoice|bill|receipt|transaction|payment|document|reference)_?(id|no|number|key)$)/i;

type ColumnStats = {
  nulls: number;
  distinctBitmap: Uint8Array;
  exactKeyValues: Set<string> | null;
  numbers: number;
  dates: number;
  booleans: number;
  minNumber: number | null;
  maxNumber: number | null;
  minDate: string | null;
  maxDate: string | null;
};

function emptyStats(): ColumnStats {
  return { nulls: 0, distinctBitmap: new Uint8Array(distinctBitmapBits >>> 3), exactKeyValues: null, numbers: 0, dates: 0, booleans: 0, minNumber: null, maxNumber: null, minDate: null, maxDate: null };
}

function hashValue(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function estimatedDistinct(bitmap: Uint8Array): number {
  let occupied = 0;
  for (const byte of bitmap) {
    let value = byte;
    while (value !== 0) {
      occupied += value & 1;
      value >>>= 1;
    }
  }
  const empty = distinctBitmapBits - occupied;
  return empty === 0 ? distinctBitmapBits : Math.round(-distinctBitmapBits * Math.log(empty / distinctBitmapBits));
}

function classifyType(stats: ColumnStats, rows: number): string {
  const nonNull = rows - stats.nulls;
  if (nonNull === 0) return "unknown";
  if (stats.booleans === nonNull) return "boolean";
  if (stats.numbers === nonNull) return "number";
  if (stats.dates === nonNull) return "date/time";
  return "text";
}

export async function profileCsvStream(source: Readable, fileName: string) {
  const columns: string[] = [];
  const stats = new Map<string, ColumnStats>();
  const rawSample: Record<string, string>[] = [];
  let rows = 0;

  const parser = source.pipe(parse({
    bom: true,
    columns: (headers: string[]) => {
      const cleaned = headers.map((header) => header.trim());
      const duplicates = cleaned.filter((header, index) => cleaned.indexOf(header) !== index);
      if (duplicates.length > 0) throw new Error(`Duplicate column names: ${[...new Set(duplicates)].join(", ")}`);
      columns.push(...cleaned);
      for (const column of columns) {
        const columnStats = emptyStats();
        if (candidateKeyName.test(column)) columnStats.exactKeyValues = new Set();
        stats.set(column, columnStats);
      }
      return cleaned;
    },
    skip_empty_lines: true,
    trim: true,
  }));

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    rows++;
    if (rawSample.length < sampleSize) rawSample.push(record);
    for (const column of columns) {
      const value = record[column] ?? "";
      const columnStats = stats.get(column)!;
      if (value === "") {
        columnStats.nulls++;
        continue;
      }
      const bitIndex = hashValue(value) & (distinctBitmapBits - 1);
      columnStats.distinctBitmap[bitIndex >>> 3] |= 1 << (bitIndex & 7);
      columnStats.exactKeyValues?.add(value);
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
    const unique = rows > 0 && columnStats.exactKeyValues?.size === rows && columnStats.nulls === 0;
    const likelyKey = candidateKeyName.test(name);
    return {
      name,
      inferredType: type,
      nullCount: columnStats.nulls,
      nullPercent: rows === 0 ? 0 : Number(((columnStats.nulls / rows) * 100).toFixed(2)),
      approximateDistinctCount: estimatedDistinct(columnStats.distinctBitmap),
      ...(type === "number" ? { min: columnStats.minNumber, max: columnStats.maxNumber } : {}),
      ...(type === "date/time" ? { min: columnStats.minDate, max: columnStats.maxDate } : {}),
      likelyPrimaryKey: likelyKey && unique,
      likelyJoinKey: likelyKey,
      sensitive: sensitiveName.test(name),
    };
  });
  const sample = rawSample.map((record) => Object.fromEntries(
    Object.entries(record).map(([name, value]) => [name, sensitiveName.test(name) ? "[REDACTED]" : value]),
  ));

  return {
    file: fileName,
    rowCount: rows,
    columns: columnProfiles,
    likelyPrimaryKeys: columnProfiles.filter((column) => column.likelyPrimaryKey).map((column) => column.name),
    likelyJoinKeys: columnProfiles.filter((column) => column.likelyJoinKey).map((column) => column.name),
    sample,
  };
}

