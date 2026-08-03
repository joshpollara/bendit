// Delimited-text parsing for the bulk food exports.
//
// USDA ships comma-separated files with quoted fields; Open Food Facts ships a
// tab-separated file that is named .csv and contains unescaped quotes and
// apostrophes in product names. One parser handles both: the delimiter is
// detected from the header, and quote handling is only applied when the file
// actually uses quoting.

/** Splits one record, honouring quoted fields and doubled quotes inside them. */
export function parseLine(line, delimiter = ',') {
  // A tab-separated OFF row has no quoting rules at all — splitting is correct
  // and much faster than walking the string.
  if (delimiter === '\t') return line.split('\t');

  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      fields.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

export const detectDelimiter = (header) => (header.includes('\t') ? '\t' : ',');

/**
 * Walks a delimited text blob, calling `onRow` with an object keyed by header
 * name. Rows are handed over one at a time; nothing accumulates.
 */
export function forEachRow(text, onRow) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return 0;
  const delimiter = detectDelimiter(lines[0]);
  const header = parseLine(lines[0], delimiter);

  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const values = parseLine(lines[i], delimiter);
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = values[c];
    onRow(row);
    count++;
  }
  return count;
}

/**
 * The streaming form, for inputs too large to hold in memory (the Open Food
 * Facts export is ~9GB uncompressed). Feed it chunks; it emits complete rows
 * and keeps only the current partial line.
 */
export class RowStream {
  constructor(onRow) {
    this.onRow = onRow;
    this.buffer = '';
    this.header = null;
    this.delimiter = ',';
    this.rows = 0;
  }

  push(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.#line(line);
    }
  }

  end() {
    if (this.buffer) this.#line(this.buffer.replace(/\r$/, ''));
    this.buffer = '';
  }

  #line(line) {
    if (!line) return;
    if (this.header === null) {
      this.delimiter = detectDelimiter(line);
      this.header = parseLine(line, this.delimiter);
      return;
    }
    const values = parseLine(line, this.delimiter);
    const row = {};
    for (let c = 0; c < this.header.length; c++) row[this.header[c]] = values[c];
    this.onRow(row);
    this.rows++;
  }
}

/** A numeric field, or null — empty strings and junk must not become zero. */
export function number(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
