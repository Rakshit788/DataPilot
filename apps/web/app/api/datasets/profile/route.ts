import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";
import { profileCsvStream } from "../../../../../../packages/importer/src/profile-csv.js";

export const runtime = "nodejs";

const maxFileBytes = 50 * 1024 * 1024;
const maxFiles = 8;

export async function POST(request: Request) {
  const form = await request.formData();
  const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);

  if (files.length === 0 || files.length > maxFiles) {
    return NextResponse.json({ error: `Choose between 1 and ${maxFiles} CSV files.` }, { status: 400 });
  }

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      return NextResponse.json({ error: `${file.name} is not a CSV file.` }, { status: 415 });
    }
    if (file.size > maxFileBytes) {
      return NextResponse.json({ error: `${file.name} exceeds the 50 MB per-file limit.` }, { status: 413 });
    }
  }

  try {
    const profiles = [];
    for (const file of files) {
      const stream = Readable.fromWeb(file.stream() as unknown as NodeReadableStream<Uint8Array>);
      profiles.push(await profileCsvStream(stream, file.name));
    }
    return NextResponse.json({ profiles });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The uploaded CSV could not be read.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
