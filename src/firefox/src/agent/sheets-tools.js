/**
 * Sheets-mode — read_sheet / fill_sheet tools for Google Sheets and Excel Online.
 *
 * Why this exists: Google Sheets and Excel Online render the cell grid to
 * <canvas>. There is no DOM for cells. So `get_accessibility_tree` returns
 * essentially nothing for the grid, and `read_page` only surfaces the
 * formula bar (which holds the ACTIVE cell's value). Bulk read/write needs
 * either keyboard navigation or going around the canvas via clipboard.
 *
 * Approach: A — keyboard + clipboard.
 *   - Read: focus sheet → keyboard-select range → Ctrl/Cmd+C → read clipboard.
 *           Parse TSV. Restore prior clipboard contents.
 *   - Write: build TSV from input values → write to clipboard → click target
 *           cell → Ctrl/Cmd+V to paste. Restore prior clipboard.
 *   - Single-cell read: name-box jump + formula-bar read. Avoids clobbering
 *           the clipboard for the common one-cell case.
 *
 * Public surface:
 *   - readSheet(tabId, args)   — { range, sheet?, mode? } → values + metadata
 *   - fillSheet(tabId, args)   — { range, values, sheet? } → { success, ... }
 *   - detectSheetSite(url)     — null | "google-sheets" | "excel-online"
 *   - parseA1(range, opts?)    — pure: A1-notation → { row, col, rowCount, colCount, sheet? }
 *   - indexToColLetters(n)     — pure: 0 → "A", 26 → "AA", etc.
 *   - valuesToTsv(values)      — pure: 2D array → tab-separated text
 *   - tsvToValues(text)        — pure: tab-separated text → 2D array
 *
 * The A1 parser and TSV (de)serializer are pure functions exported for
 * tests (see test/run.js). The backend-specific I/O (navigator.clipboard,
 * cdpClient dispatch) is kept out of the pure helpers so they can run
 * under node without DOM mocks.
 *
 * Phase status (v8.1.0 development):
 *   - 2.1 (this commit): foundation only. readSheet/fillSheet return a
 *     "phase 2.2 not yet shipped" error from each backend stub. NOT exposed
 *     in tools.js. NOT mentioned in adapters. The plumbing is here so 2.2
 *     can drop in the real reads.
 *   - 2.2: Google Sheets read.
 *   - 2.3: Google Sheets write.
 *   - 2.4: Excel Online (both read and write).
 *   - 2.5: cap + trace integration + ship as v8.1.0.
 */

// ─────────────────────────────────────────────────────────────────────────
// Site detection
// ─────────────────────────────────────────────────────────────────────────

/**
 * Identify which sheet host the URL belongs to, or null.
 *
 * Returned strings are the keys used to pick a backend below — keep them
 * in sync with BACKENDS at the bottom of this file.
 */
export function detectSheetSite(url) {
  if (typeof url !== 'string' || !url) return null;
  if (/^https?:\/\/docs\.google\.com\/spreadsheets\//.test(url)) return 'google-sheets';
  // Excel Online — both office.com and onedrive.live.com variants.
  if (/^https?:\/\/(www\.)?office\.com\/launch\/excel\//.test(url)) return 'excel-online';
  if (/^https?:\/\/.*\.officeapps\.live\.com\/x\//.test(url)) return 'excel-online';
  if (/^https?:\/\/onedrive\.live\.com\/edit\.aspx/.test(url)) return 'excel-online';
  if (/^https?:\/\/.*\.sharepoint\.com\/.+\.xlsx/.test(url)) return 'excel-online';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// A1 range parsing
//
// "A1"           → { row: 0, col: 0, rowCount: 1, colCount: 1 }
// "A1:C10"       → { row: 0, col: 0, rowCount: 10, colCount: 3 }
// "B5:B5"        → { row: 4, col: 1, rowCount: 1, colCount: 1 }
// "A:A"          → { row: 0, col: 0, rowCount: -1, colCount: 1, wholeColumn: true }
// "1:1"          → { row: 0, col: 0, rowCount: 1, colCount: -1, wholeRow: true }
// "Sheet2!A1:C3" → { sheet: "Sheet2", row: 0, col: 0, rowCount: 3, colCount: 3 }
//
// rowCount/colCount = -1 means "whole column/row" — the backend translates
// this to the appropriate Ctrl+Shift+End / Ctrl+Shift+arrow gesture.
//
// Throws on malformed input. The error message includes the offending
// input so the caller can surface it to the model verbatim.
// ─────────────────────────────────────────────────────────────────────────

// Accept both relative and absolute A1 references. The `$` markers only lock
// rows/columns in spreadsheet formulas; for read/write selection coordinates
// they do not change the zero-based row/col we return, so the regex captures
// only the column letters and row digits while ignoring optional `$` prefixes.
const A1_PATTERN = /^\$?([A-Z]+)?\$?(\d+)?(?::\$?([A-Z]+)?\$?(\d+)?)?$/;

/**
 * Split "Sheet!A1:B2" into { sheet, body }, with proper handling of
 * quoted sheet names that themselves may contain '!' characters.
 *
 * Grammar (matches Google Sheets / Excel):
 *   - Quoted sheet:   'Any!chars'!body    (use '' to escape a literal ')
 *   - Unquoted sheet: SimpleName!body
 *   - No sheet:       body
 *
 * `originalRange` is included in error messages so the caller can
 * surface a clear context line ("in 'Sales!Q1A1'") to the user.
 */
function _splitSheetRange(trimmed, originalRange) {
  // No '!' at all → no sheet prefix.
  if (!trimmed.includes('!')) {
    return { sheet: null, body: trimmed };
  }

  // Quoted sheet name. Walk char-by-char to find the matching close
  // quote, treating '' as an escaped quote (no split). The '!' MUST
  // immediately follow the close quote — anything else means the
  // input is malformed.
  if (trimmed.startsWith("'")) {
    let i = 1;
    while (i < trimmed.length) {
      if (trimmed[i] === "'") {
        // Escaped quote ('') inside the sheet name — skip both.
        if (trimmed[i + 1] === "'") { i += 2; continue; }
        // Close quote. Expect '!' next.
        if (trimmed[i + 1] !== '!') {
          throw new Error(`parseA1: closing quote of sheet name must be immediately followed by '!' in ${JSON.stringify(originalRange)}`);
        }
        const rawSheet = trimmed.slice(1, i);
        if (!rawSheet) {
          throw new Error(`parseA1: empty sheet name before "!" in ${JSON.stringify(originalRange)}`);
        }
        const sheet = rawSheet.replace(/''/g, "'");
        const body = trimmed.slice(i + 2).trim(); // skip "'!"
        return { sheet, body };
      }
      i++;
    }
    // Walked off the end without finding the close quote.
    throw new Error(`parseA1: unterminated quoted sheet name in ${JSON.stringify(originalRange)}`);
  }

  // Unquoted sheet name. First '!' is the separator.
  const idx = trimmed.indexOf('!');
  const sheet = trimmed.slice(0, idx).trim();
  if (!sheet) {
    throw new Error(`parseA1: empty sheet name before "!" in ${JSON.stringify(originalRange)}`);
  }
  const body = trimmed.slice(idx + 1).trim();
  return { sheet, body };
}

export function parseA1(range) {
  if (typeof range !== 'string' || !range.trim()) {
    throw new Error(`parseA1: range must be a non-empty string, got ${JSON.stringify(range)}`);
  }
  const trimmed = range.trim();

  // Split the optional sheet prefix from the A1 body. Spreadsheet
  // grammar allows quoted sheet names that contain '!' — e.g.
  // 'Sales!Q1'!A1 — and inside the quotes, '' is an escaped quote
  // (Google Sheets / Excel convention). Using a naive `indexOf('!')`
  // would split inside the sheet name and corrupt valid input. So we
  // hand-walk the prefix:
  //   - If trimmed starts with "'", find the matching close quote
  //     (handling '' as escaped), then expect '!' immediately after.
  //   - Otherwise split at the first '!'.
  const { sheet, body } = _splitSheetRange(trimmed, range);

  const m = A1_PATTERN.exec(body.toUpperCase());
  if (!m) throw new Error(`parseA1: not A1 notation: ${JSON.stringify(range)}`);
  const [, sCol, sRow, eCol, eRow] = m;

  // Single-cell ("A1") vs range ("A1:C10") — the second half of the regex
  // group is undefined for single-cell input.
  const hasEnd = body.includes(':');

  // Reject single-cell input that's missing either the column or the row
  // ("A" alone, "5" alone). The model occasionally means "whole column A"
  // when it writes "A", and silently parsing that as A1 is the WORST
  // failure mode — it reads/writes the wrong cell with no error. The
  // explicit syntax for whole column is "A:A".
  if (!hasEnd && (!sCol || !sRow)) {
    throw new Error(`parseA1: incomplete start address in ${JSON.stringify(range)} — for a single cell pass both column and row (e.g. "A1"); for a whole column use "A:A"; for a whole row use "1:1".`);
  }

  // Spreadsheet rows are 1-indexed in A1 notation; anything below 1 is a
  // typo. parseInt('0', 10) - 1 silently produces -1, which would then
  // mis-target cells once read_sheet / fill_sheet wire up the backends.
  // Reject explicitly so the caller sees the error at parse time.
  const _validateRowStr = (rowStr, which) => {
    const n = parseInt(rowStr, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`parseA1: row numbers are 1-indexed; got ${JSON.stringify(which + '=' + rowStr)} in ${JSON.stringify(range)}. Use A1 (not A0), 1:5 (not 0:5).`);
    }
    return n - 1;
  };
  const startCol = sCol ? colLettersToIndex(sCol) : 0;
  const startRow = sRow ? _validateRowStr(sRow, 'startRow') : 0;
  const endCol = hasEnd && eCol ? colLettersToIndex(eCol) : (hasEnd ? null : startCol);
  const endRow = hasEnd && eRow ? _validateRowStr(eRow, 'endRow') : (hasEnd ? null : startRow);

  if (sCol == null && sRow == null) {
    throw new Error(`parseA1: range must specify at least one column or row: ${JSON.stringify(range)}`);
  }

  // Whole column ("A:C" or "A:A", and reversed "C:A") — start/end
  // specify columns but no rows. Normalize endpoints so reversed input
  // produces a positive colCount, matching how the rectangular-range
  // branch below normalizes "C10:A1".
  if (hasEnd && !sRow && !eRow && sCol && eCol) {
    const lo = Math.min(startCol, endCol);
    const hi = Math.max(startCol, endCol);
    return {
      sheet, row: 0, col: lo,
      rowCount: -1, colCount: hi - lo + 1,
      wholeColumn: true,
    };
  }
  // Whole row ("1:5" or "1:1", and reversed "5:1") — same normalization.
  if (hasEnd && !sCol && !eCol && sRow && eRow) {
    const lo = Math.min(startRow, endRow);
    const hi = Math.max(startRow, endRow);
    return {
      sheet, row: lo, col: 0,
      rowCount: hi - lo + 1, colCount: -1,
      wholeRow: true,
    };
  }

  if (startCol == null || startRow == null) {
    throw new Error(`parseA1: incomplete start address in ${JSON.stringify(range)} — must specify both column and row (or use whole-column/row syntax like "A:A")`);
  }
  if (hasEnd && (endCol == null || endRow == null)) {
    throw new Error(`parseA1: incomplete end address in ${JSON.stringify(range)} — must specify both column and row for the end too`);
  }

  const lo = (a, b) => Math.min(a, b);
  const hi = (a, b) => Math.max(a, b);
  const r0 = lo(startRow, endRow);
  const r1 = hi(startRow, endRow);
  const c0 = lo(startCol, endCol);
  const c1 = hi(startCol, endCol);
  return {
    sheet,
    row: r0, col: c0,
    rowCount: r1 - r0 + 1,
    colCount: c1 - c0 + 1,
  };
}

/**
 * "A" → 0, "B" → 1, ..., "Z" → 25, "AA" → 26, "AB" → 27, "BA" → 52, etc.
 *
 * Uses base-26 with A=1 (no zero digit), the standard spreadsheet column
 * encoding. Throws on non-letter input.
 */
export function colLettersToIndex(letters) {
  if (typeof letters !== 'string' || !/^[A-Z]+$/.test(letters)) {
    throw new Error(`colLettersToIndex: not column letters: ${JSON.stringify(letters)}`);
  }
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

/**
 * 0 → "A", 25 → "Z", 26 → "AA", 51 → "AZ", 52 → "BA", etc.
 *
 * Inverse of colLettersToIndex. Throws on negative input.
 */
export function indexToColLetters(n) {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`indexToColLetters: not a non-negative integer: ${JSON.stringify(n)}`);
  }
  let s = '';
  let x = n;
  while (true) {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
    if (x < 0) break;
  }
  return s;
}

/**
 * Build an A1 string from {row, col, rowCount, colCount}. Inverse of
 * parseA1 for the common rectangular case. Used to populate the `range`
 * field of the tool result so the model sees the canonicalized range.
 */
export function rangeToA1({ row, col, rowCount, colCount, sheet }) {
  const a = indexToColLetters(col) + (row + 1);
  const b = indexToColLetters(col + colCount - 1) + (row + rowCount);
  const body = rowCount === 1 && colCount === 1 ? a : `${a}:${b}`;
  return sheet ? `${needsQuoting(sheet) ? `'${sheet.replace(/'/g, "''")}'` : sheet}!${body}` : body;
}

function needsQuoting(sheetName) {
  // Quote if the name has spaces, punctuation, or starts with a digit.
  // Conservative: only A-Z/a-z/0-9/_ unquoted, and not starting with digit.
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sheetName);
}

// ─────────────────────────────────────────────────────────────────────────
// TSV (tab-separated values) ↔ 2D array
//
// Sheets and Excel both copy/paste in TSV format. Cells with tabs,
// newlines, or quotes get wrapped in double quotes with embedded quotes
// doubled. We follow RFC 4180 conventions adapted for TAB as the separator.
// ─────────────────────────────────────────────────────────────────────────

export function valuesToTsv(values) {
  if (!Array.isArray(values)) {
    throw new Error('valuesToTsv: values must be a 2D array');
  }
  return values.map(row => {
    if (!Array.isArray(row)) throw new Error('valuesToTsv: each row must be an array');
    return row.map(cellToTsv).join('\t');
  }).join('\n');
}

function cellToTsv(cell) {
  // Coerce non-string non-null/undefined to string; null/undefined → empty.
  if (cell == null) return '';
  const s = typeof cell === 'string' ? cell : String(cell);
  // Quote if the cell contains tab, newline, or double-quote.
  if (/[\t\n\r"]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function tsvToValues(text) {
  if (typeof text !== 'string') {
    throw new Error('tsvToValues: input must be a string');
  }
  if (text === '') return [[]];

  // Streaming parser — handles quoted cells with embedded tabs/newlines/quotes.
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  // Strip a trailing newline so we don't emit a phantom empty row.
  let end = text.length;
  while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
  const src = text.slice(0, end);

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') {
      // Quote inside an already-non-empty cell: treat as literal (matches
      // how Sheets/Excel emit malformed paste contents).
      if (cell === '') { inQuotes = true; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '\t') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      // Swallow CRLF pairs as a single newline.
      if (ch === '\r' && src[i + 1] === '\n') i += 2; else i++;
      continue;
    }
    cell += ch; i++;
  }
  // Flush the trailing cell + row.
  row.push(cell);
  rows.push(row);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// Clipboard snapshot / restore
//
// All sheet reads/writes go through the OS clipboard (the only way around
// the canvas grid). Before mutating, snapshot the prior contents and try
// to restore on completion so the user's clipboard isn't permanently
// clobbered. Restore is best-effort — if the snapshot read fails because
// of a permission prompt, we skip restore and note it in the tool result.
//
// Lives in the service worker, which DOES have clipboardWrite by manifest
// and DOES have clipboardRead via the manifest permission added for v8.1.0.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read current clipboard text. Returns null on permission denial / lack of
 * support so callers can degrade gracefully (skip restore + warn).
 *
 * Note: navigator.clipboard.readText in the service-worker scope requires
 * the `clipboardRead` permission (added to manifest in v8.1.0). The
 * permission has no install-time UX in MV3 — it's listed in the permission
 * string but does not surface a separate prompt.
 */
export async function snapshotClipboard() {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return null;
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/**
 * Best-effort restore of clipboard text. Silent failure.
 */
export async function restoreClipboard(text) {
  if (text == null) return false;
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write text to clipboard. Used by fill_sheet to stage the TSV that the
 * subsequent paste keystroke pulls in.
 */
export async function writeClipboard(text) {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('Clipboard API not available — this Chrome/Firefox build lacks navigator.clipboard, or the extension lacks clipboardWrite.');
  }
  await navigator.clipboard.writeText(text);
}

// ─────────────────────────────────────────────────────────────────────────
// Backend dispatch
// ─────────────────────────────────────────────────────────────────────────

// Phase 2.1: both backends are stubs that report what's coming. They're
// wired in so phase 2.2's actual Google Sheets implementation drops in
// without changing the public surface.

const BACKENDS = {
  'google-sheets': {
    read: async (_tabId, _args) => ({
      success: false,
      error: 'read_sheet on Google Sheets is in development. This tool will land in v8.1.0 phase 2.2. For now, click the cell manually and use the formula bar value.',
      backend: 'google-sheets',
      phase: '2.2',
    }),
    write: async (_tabId, _args) => ({
      success: false,
      error: 'fill_sheet on Google Sheets is in development. This tool will land in v8.1.0 phase 2.3.',
      backend: 'google-sheets',
      phase: '2.3',
    }),
  },
  'excel-online': {
    read: async (_tabId, _args) => ({
      success: false,
      error: 'read_sheet on Excel Online is in development. This tool will land in v8.1.0 phase 2.4.',
      backend: 'excel-online',
      phase: '2.4',
    }),
    write: async (_tabId, _args) => ({
      success: false,
      error: 'fill_sheet on Excel Online is in development. This tool will land in v8.1.0 phase 2.4.',
      backend: 'excel-online',
      phase: '2.4',
    }),
  },
};

/**
 * Public entry point — read a range from the active sheet.
 *
 * `args`: { range: string, sheet?: string, mode?: 'values'|'formulas'|'both' }
 * Returns: { success, values?, rows?, cols?, range?, sheet?, error?, ... }
 *
 * Implementation per backend lives in BACKENDS[siteId].read. For phase
 * 2.1 this returns a "not yet shipped" error per site.
 */
export async function readSheet(tabId, args) {
  const url = await _getTabUrl(tabId);
  const siteId = detectSheetSite(url);
  if (!siteId) {
    return {
      success: false,
      error: `read_sheet only works on Google Sheets or Excel Online. Current tab URL is not a known sheet host. If the user is asking about a spreadsheet on a different platform (Airtable, Smartsheet, Numbers iCloud), surface that limitation rather than retrying.`,
      url,
    };
  }
  let parsed;
  try {
    parsed = parseA1(args?.range);
  } catch (e) {
    return { success: false, error: `read_sheet: ${e.message}` };
  }
  // Merge parsed.sheet (from "Sheet2!A1") with args.sheet (explicit param).
  // Explicit arg wins.
  const sheet = args?.sheet ?? parsed.sheet ?? null;
  const mode = args?.mode || 'values';
  if (!['values', 'formulas', 'both'].includes(mode)) {
    return { success: false, error: `read_sheet: mode must be one of "values", "formulas", "both" (got ${JSON.stringify(mode)})` };
  }
  return await BACKENDS[siteId].read(tabId, { ...args, parsed, sheet, mode, siteId });
}

/**
 * Public entry point — write a 2D array of values into a sheet starting
 * at the top-left cell of `range`.
 *
 * `args`: { range: string, values: string[][], sheet?: string }
 * Returns: { success, rowsWritten?, colsWritten?, range?, error?, ... }
 */
export async function fillSheet(tabId, args) {
  const url = await _getTabUrl(tabId);
  const siteId = detectSheetSite(url);
  if (!siteId) {
    return {
      success: false,
      error: `fill_sheet only works on Google Sheets or Excel Online. Current tab URL is not a known sheet host.`,
      url,
    };
  }
  let parsed;
  try {
    parsed = parseA1(args?.range);
  } catch (e) {
    return { success: false, error: `fill_sheet: ${e.message}` };
  }
  if (!Array.isArray(args?.values)) {
    return { success: false, error: 'fill_sheet: values must be a 2D array of strings (e.g. [["foo","bar"],["baz","qux"]])' };
  }
  const sheet = args?.sheet ?? parsed.sheet ?? null;
  return await BACKENDS[siteId].write(tabId, { ...args, parsed, sheet, siteId });
}

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

async function _getTabUrl(tabId) {
  // browser.tabs.get in the MV2 background page. Wrapped in try/catch
  // because the tab may have been closed between the agent's last tool
  // call and now.
  try {
    const tab = await browser.tabs.get(tabId);
    return tab?.url || '';
  } catch {
    return '';
  }
}
