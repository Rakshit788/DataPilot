import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { importCsvDataset } from "../../../../../../../packages/importer/src/import-dataset.js";

export const runtime = "nodejs";

const sourceFiles = [
  "olist_orders_dataset.csv",
  "olist_order_items_dataset.csv",
  "olist_order_payments_dataset.csv",
  "olist_order_reviews_dataset.csv",
  "olist_customers_dataset.csv",
  "olist_products_dataset.csv",
  "olist_sellers_dataset.csv",
  "product_category_name_translation.csv",
];

export async function POST() {
  try {
    const candidates = process.env.OLIST_DATA_DIR
      ? [resolve(process.env.OLIST_DATA_DIR), resolve("data/raw"), resolve("../../data/raw")]
      : [resolve("data/raw"), resolve("../../data/raw")];
    let sourceDir = candidates[0]!;
    let available = new Set<string>();
    for (const candidate of candidates) {
      try {
        const entries = await readdir(candidate);
        const names = new Set(entries.map((entry) => entry.toLowerCase()));
        if (names.has(sourceFiles[0]!.toLowerCase())) {
          sourceDir = candidate;
          available = names;
          break;
        }
      } catch { /* Try the next local workspace path. */ }
    }
    const missing = sourceFiles.filter((file) => !available.has(file));
    if (missing.length) return NextResponse.json({ error: "Add the full Olist CSV bundle to data/raw/. Missing: " + missing.join(", ") }, { status: 404 });
    const files: File[] = [];
    let totalBytes = 0;
    for (const name of sourceFiles) {
      const path = resolve(sourceDir, name);
      const buffer = await readFile(path);
      totalBytes += buffer.byteLength;
      if (totalBytes > 250 * 1024 * 1024) return NextResponse.json({ error: "The selected Olist files exceed the 250 MB local import limit." }, { status: 413 });
      files.push(new File([new Uint8Array(buffer)], name, { type: "text/csv" }));
    }
    const dataset = await importCsvDataset(files);
    return NextResponse.json({ dataset }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not import the local Olist files.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
