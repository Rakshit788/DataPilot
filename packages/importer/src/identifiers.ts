export function normalizeIdentifier(input: string, fallback = "column") {
  let value = input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!value) value = fallback;
  if (/^[0-9]/.test(value)) value = `_${value}`;
  return value.slice(0, 50);
}

export function uniqueIdentifiers(inputs: string[]) {
  const used = new Set<string>();
  return inputs.map((input, index) => {
    const base = normalizeIdentifier(input, `column_${index + 1}`);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      const tail = `_${suffix++}`;
      candidate = `${base.slice(0, 63 - tail.length)}${tail}`;
    }
    used.add(candidate);
    return candidate;
  });
}

export function quoteIdentifier(identifier: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) throw new Error("Unsafe SQL identifier.");
  return `"${identifier}"`;
}
