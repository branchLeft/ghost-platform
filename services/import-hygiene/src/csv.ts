// A small RFC 4180 reader and writer, enough for a member list. Errors name no
// cell value, so a parse failure cannot echo an address.

export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: ReadonlyArray<readonly string[]>;
}

export function parseCsv(text: string): CsvTable {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field.length > 0) {
        throw new Error('CSV has a quote inside an unquoted field');
      }
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      record.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += ch === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) {
    throw new Error('CSV ends inside a quoted field');
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const nonBlank = records.filter((cells) => !(cells.length === 1 && cells[0] === ''));
  const header = nonBlank[0];
  if (header === undefined) {
    throw new Error('CSV has no header row');
  }
  return { header, rows: nonBlank.slice(1) };
}

function escapeCell(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function writeCsv(
  header: readonly string[],
  rows: ReadonlyArray<readonly string[]>
): string {
  return [header, ...rows].map((cells) => cells.map(escapeCell).join(',')).join('\n') + '\n';
}
