// One-off (re-runnable) import of the supplier roofing price catalog from
// Roof_SupplierPrice.xlsx into the roof_materials table. Re-running clears
// and reloads the table, so it's safe to run again after the spreadsheet
// is updated.
//
// Usage (from backend/):  node scripts/importMaterials.js
const path = require("path");
const XLSX = require("xlsx");
const pool = require("../db");

const XLSX_PATH = path.join(__dirname, "..", "..", "Roof_SupplierPrice.xlsx");

// Sheets that aren't a generic material price list — skip them.
const SKIP_SHEETS = new Set([
  "DKR-5143_Thorndon Fire Station ", // a specific past quote, not a catalog
  "SlopePitch",                       // pitch-factor lookup table
  "Merge",                            // aggregate duplicate of other sheets
]);

// Header names to look for, in priority order, for each logical field.
const COLUMN_CANDIDATES = {
  sku:         ["SKU"],
  supplier:    ["Supplier"],
  type:        ["Type"],
  description: ["Description", "Roof Sheet", "Product", "Skylight"],
  gauge:       ["Gauge"],
  coating:     ["Coating", "Material"],
  unit:        ["Unit"],
  rateLm:      ["Rate ($/LM)"],
  rateM2:      ["Rate ($/M2)"],
  coverWidth:  ["Cover Width"],
};

function findColumnIndex(headerRow, candidates) {
  for (const name of candidates) {
    const idx = headerRow.indexOf(name);
    if (idx !== -1) return idx;
  }
  return -1;
}

function toNumberOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function parseSheet(sheetName, rows) {
  // Header row = first row with more than 3 non-empty cells.
  const headerRow = rows.find(r => r.filter(c => c !== "").length > 3);
  if (!headerRow) return [];

  const idx = {};
  for (const [field, candidates] of Object.entries(COLUMN_CANDIDATES)) {
    idx[field] = findColumnIndex(headerRow, candidates);
  }
  if (idx.sku === -1 && idx.description === -1) return []; // no usable columns

  const headerRowIdx = rows.indexOf(headerRow);
  const out = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const description = idx.description !== -1 ? String(row[idx.description] || "").trim() : "";
    const sku         = idx.sku !== -1 ? String(row[idx.sku] || "").trim() : "";
    const rateLm       = idx.rateLm !== -1 ? toNumberOrNull(row[idx.rateLm]) : null;
    const rateM2        = idx.rateM2 !== -1 ? toNumberOrNull(row[idx.rateM2]) : null;

    // Skip padding rows: need a description AND at least one real rate.
    if (!description) continue;
    if ((rateLm === null || rateLm <= 0) && (rateM2 === null || rateM2 <= 0)) continue;

    out.push({
      category:    sheetName.trim(),
      supplier:    idx.supplier !== -1 ? String(row[idx.supplier] || "").trim() || null : null,
      type:        idx.type !== -1 ? String(row[idx.type] || "").trim() || null : null,
      sku:         sku || null,
      description,
      gauge:       idx.gauge !== -1 ? String(row[idx.gauge] || "").trim() || null : null,
      coating:     idx.coating !== -1 ? String(row[idx.coating] || "").trim() || null : null,
      unit:        idx.unit !== -1 ? String(row[idx.unit] || "").trim() || null : null,
      rateLm,
      rateM2,
      coverWidth:  idx.coverWidth !== -1 ? toNumberOrNull(row[idx.coverWidth]) : null,
    });
  }
  return out;
}

async function main() {
  const wb = XLSX.readFile(XLSX_PATH);
  const allRows = [];

  for (const sheetName of wb.SheetNames) {
    if (SKIP_SHEETS.has(sheetName)) continue;
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    const parsed = parseSheet(sheetName, rows);
    console.log(`${sheetName}: ${parsed.length} priced rows`);
    allRows.push(...parsed);
  }

  console.log(`Total rows to import: ${allRows.length}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE roof_materials");
    for (const r of allRows) {
      await client.query(
        `INSERT INTO roof_materials
           (category, supplier, type, sku, description, gauge, coating, unit, rate_lm, rate_m2, cover_width)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [r.category, r.supplier, r.type, r.sku, r.description, r.gauge, r.coating, r.unit, r.rateLm, r.rateM2, r.coverWidth]
      );
    }
    await client.query("COMMIT");
    console.log("Import complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error("Import failed:", err); process.exit(1); });
