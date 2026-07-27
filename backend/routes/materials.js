const { Router } = require("express");
const pool   = require("../db");
const router = Router();

// Sentinel the frontend sends for "this row has no supplier attributed" —
// e.g. generic gutter brackets/downpipes not tied to a specific brand.
// `supplier = $1` can never match those rows (NULL != anything), so callers
// asking for this sentinel get `supplier IS NULL` instead.
const NO_SUPPLIER = "__no_supplier__";

function serializeMaterial(row) {
  return {
    id:          row.id,
    category:    row.category,
    supplier:    row.supplier,
    type:        row.type,
    sku:         row.sku,
    description: row.description,
    gauge:       row.gauge,
    coating:     row.coating,
    unit:        row.unit,
    rateLm:      row.rate_lm !== null ? parseFloat(row.rate_lm) : null,
    rateM2:      row.rate_m2 !== null ? parseFloat(row.rate_m2) : null,
    coverWidth:  row.cover_width !== null ? parseFloat(row.cover_width) : null,
    productGroup: row.product_group,
  };
}

// GET /api/materials?search=corrugated%20iron&limit=30
// Matches per-word (not the whole phrase as one substring) across
// description/sku/supplier/type/category, since the catalog uses real
// trade/brand terminology (e.g. "Colorsteel", "Corrugate 0.40 Zincalume")
// that rarely matches a generic phrase like "Long Run Steel" verbatim.
//
// `roof_materials` is per-organization (each org has its own catalog,
// cloned from a master template at signup — see billing.js) — every query
// below is scoped to req.user.organizationId so one org never sees or
// searches another's catalog/rates.
router.get("/", async (req, res) => {
  try {
    const { search = "", limit = 30, group = "", unit = "" } = req.query;
    const cappedLimit = Math.min(parseInt(limit, 10) || 30, 100);

    const tokens = search.trim().split(/\s+/).filter(t => t.length >= 2);
    if (!tokens.length) return res.json([]);

    const cols = ["description", "sku", "supplier", "type", "category"];
    const conditions = [];
    const params = [];
    tokens.forEach(token => {
      const pattern = `%${token}%`;
      const tokenConds = cols.map(col => {
        params.push(pattern);
        return `${col} ILIKE $${params.length}`;
      });
      conditions.push(`(${tokenConds.join(" OR ")})`);
    });

    // Score = how many of the search words this row matched, so the most
    // relevant rows (matching every word) surface first.
    const scoreExpr = tokens.map((_, i) => {
      const base = i * cols.length;
      const tokenConds = cols.map((col, j) => `${col} ILIKE $${base + j + 1}`);
      return `(CASE WHEN (${tokenConds.join(" OR ")}) THEN 1 ELSE 0 END)`;
    }).join(" + ");

    params.push(req.user.organizationId);
    const orgCond = ` AND organization_id = $${params.length}`;

    // Restrict to a product family (roof_sheet/flashing/accessory) when the
    // picker is scoped to one — e.g. the roof section picker only wants
    // roof_sheet, not gutters/fixings/etc. that also happen to match a word.
    let groupCond = "";
    if (group.trim()) {
      params.push(group.trim());
      groupCond = ` AND product_group = $${params.length}`;
    }
    // Restrict to the catalog's own pricing unit (ea/LM/m2) — e.g. a gutter
    // RUN (priced per metre) shouldn't be able to pick an "ea" bracket/clip
    // that happens to share the same product_group as the actual spouting.
    let unitCond = "";
    if (unit.trim()) {
      params.push(unit.trim());
      unitCond = ` AND UPPER(unit) = UPPER($${params.length})`;
    }

    params.push(cappedLimit);
    const { rows } = await pool.query(
      `SELECT *, (${scoreExpr}) AS score FROM roof_materials
       WHERE (${conditions.join(" OR ")})${orgCond}${groupCond}${unitCond}
       ORDER BY score DESC, rate_m2 IS NULL, description
       LIMIT $${params.length}`,
      params
    );
    res.json(rows.map(serializeMaterial));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/materials/suppliers — distinct supplier list for the cascading picker
router.get("/suppliers", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT supplier FROM roof_materials
       WHERE supplier IS NOT NULL AND supplier <> '' AND organization_id = $1
       ORDER BY supplier`,
      [req.user.organizationId]
    );
    res.json(rows.map(r => r.supplier));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/materials/types?supplier=Dimond&group=roof_sheet — distinct types
// for that supplier, optionally restricted to a product family
router.get("/types", async (req, res) => {
  try {
    const { supplier = "", group = "", unit = "" } = req.query;
    if (!supplier.trim()) return res.json([]);
    const isGeneric = supplier === NO_SUPPLIER;
    const params = isGeneric ? [req.user.organizationId] : [supplier, req.user.organizationId];
    const supplierCond = isGeneric ? `(supplier IS NULL OR supplier = '')` : `supplier = $1`;
    const orgParamIdx = isGeneric ? 1 : 2;
    let groupCond = "";
    if (group.trim()) { params.push(group.trim()); groupCond = ` AND product_group = $${params.length}`; }
    let unitCond = "";
    if (unit.trim()) { params.push(unit.trim()); unitCond = ` AND UPPER(unit) = UPPER($${params.length})`; }
    const { rows } = await pool.query(
      `SELECT DISTINCT type FROM roof_materials
       WHERE ${supplierCond} AND organization_id = $${orgParamIdx} AND type IS NOT NULL AND type <> ''${groupCond}${unitCond}
       ORDER BY type`,
      params
    );
    res.json(rows.map(r => r.type));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/materials/by-type?supplier=Dimond&type=Corrugate&group=roof_sheet — materials for that pair
router.get("/by-type", async (req, res) => {
  try {
    const { supplier = "", type = "", group = "", unit = "" } = req.query;
    if (!supplier.trim() || !type.trim()) return res.json([]);
    const isGeneric = supplier === NO_SUPPLIER;
    const params = isGeneric ? [type, req.user.organizationId] : [supplier, type, req.user.organizationId];
    const supplierCond = isGeneric ? `(supplier IS NULL OR supplier = '')` : `supplier = $1`;
    const typeParamIdx = isGeneric ? 1 : 2;
    const orgParamIdx  = isGeneric ? 2 : 3;
    let groupCond = "";
    if (group.trim()) { params.push(group.trim()); groupCond = ` AND product_group = $${params.length}`; }
    let unitCond = "";
    if (unit.trim()) { params.push(unit.trim()); unitCond = ` AND UPPER(unit) = UPPER($${params.length})`; }
    const { rows } = await pool.query(
      `SELECT * FROM roof_materials
       WHERE ${supplierCond} AND type = $${typeParamIdx} AND organization_id = $${orgParamIdx}${groupCond}${unitCond}
       ORDER BY rate_m2 IS NULL, description
       LIMIT 200`,
      params
    );
    res.json(rows.map(serializeMaterial));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
