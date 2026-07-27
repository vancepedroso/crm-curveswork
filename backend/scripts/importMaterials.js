// One-off (re-runnable) import of the supplier roofing price catalog from
// Roof_SupplierPrice.xlsx. roof_materials is per-organization now (each org
// has its own catalog, cloned from roof_materials_templates at signup — see
// backend/lib/materialsTemplate.js) — this script NO LONGER truncates the
// whole shared table (that would wipe every organization's catalog at
// once). Pick exactly one target per run:
//
//   node scripts/importMaterials.js --org <organizationId>
//     Reloads just that org's own roof_materials rows (deletes only rows
//     tagged with that organization_id first, not the whole table).
//
//   node scripts/importMaterials.js --target=template
//     Reloads the master roof_materials_templates catalog that new
//     organizations get cloned from at signup. Does NOT touch any
//     already-existing organization's roof_materials rows.
//
// Re-running either mode also resets rate_lm/rate_m2 to the raw spreadsheet
// values, so re-run scripts/fixFlashingRates.js afterwards too.
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

// Same roof_sheet/flashing/accessory split as migrations/13_add_material_product_group.sql —
// kept in sync here so a fresh import doesn't reset every row back to unclassified.
const FLASHING_TYPES = new Set([
  "flashing","flashings","soft edge flashing","ridging","barge roll","edging",
  "dektite","penetration","top hat","se","flashing tape",
]);
const ROOF_SHEET_TYPES = new Set([
  "trapezoidal","v-rib","six rib","flat sheet","corrugate","dimondek 300","dimondek 400",
  "dimondclad rib 20/50","veedek","solar rib","durolite","topspan","steelspan","hi five",
  "styline","lt7","topglass","polycarbonate sheet","translucent sheet","tpo","bb900","general",
  "skylight","opening skylights","fixed skylights","fixed flat roof skylights",
]);
function classifyProductGroup(type) {
  const t = (type || "").trim().toLowerCase();
  if (FLASHING_TYPES.has(t)) return "flashing";
  if (ROOF_SHEET_TYPES.has(t)) return "roof_sheet";
  return "accessory";
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
      productGroup: classifyProductGroup(idx.type !== -1 ? row[idx.type] : null),
    });
  }
  return out;
}

function parseArgs(argv) {
  const orgFlagIdx = argv.indexOf("--org");
  const orgId = orgFlagIdx !== -1 ? argv[orgFlagIdx + 1] : null;
  const targetFlag = argv.find(a => a.startsWith("--target="));
  const target = targetFlag ? targetFlag.split("=")[1] : null;
  return { orgId, target };
}

async function main() {
  const { orgId, target } = parseArgs(process.argv.slice(2));
  if (!orgId && target !== "template") {
    console.error("Specify a target: --org <organizationId>  or  --target=template");
    process.exitCode = 1;
    return;
  }

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

    if (target === "template") {
      await client.query("TRUNCATE roof_materials_templates");
      for (const r of allRows) {
        await client.query(
          `INSERT INTO roof_materials_templates
             (category, supplier, type, sku, description, gauge, coating, unit, rate_lm, rate_m2, cover_width, product_group)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [r.category, r.supplier, r.type, r.sku, r.description, r.gauge, r.coating, r.unit, r.rateLm, r.rateM2, r.coverWidth, r.productGroup]
        );
      }
    } else {
      await client.query("DELETE FROM roof_materials WHERE organization_id = $1", [orgId]);
      for (const r of allRows) {
        await client.query(
          `INSERT INTO roof_materials
             (organization_id, category, supplier, type, sku, description, gauge, coating, unit, rate_lm, rate_m2, cover_width, product_group)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [orgId, r.category, r.supplier, r.type, r.sku, r.description, r.gauge, r.coating, r.unit, r.rateLm, r.rateM2, r.coverWidth, r.productGroup]
        );
      }
    }

    await client.query("COMMIT");
    console.log(`Import complete (target: ${target === "template" ? "template catalog" : `organization ${orgId}`}).`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error("Import failed:", err); process.exit(1); });
