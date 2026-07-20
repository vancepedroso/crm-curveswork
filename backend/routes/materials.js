const { Router } = require("express");
const pool   = require("../db");
const router = Router();

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
  };
}

// GET /api/materials?search=corrugated%20iron&limit=30
// Matches per-word (not the whole phrase as one substring) across
// description/sku/supplier/type/category, since the catalog uses real
// trade/brand terminology (e.g. "Colorsteel", "Corrugate 0.40 Zincalume")
// that rarely matches a generic phrase like "Long Run Steel" verbatim.
router.get("/", async (req, res) => {
  try {
    const { search = "", limit = 30 } = req.query;
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

    params.push(cappedLimit);
    const { rows } = await pool.query(
      `SELECT *, (${scoreExpr}) AS score FROM roof_materials
       WHERE ${conditions.join(" OR ")}
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
       WHERE supplier IS NOT NULL AND supplier <> ''
       ORDER BY supplier`
    );
    res.json(rows.map(r => r.supplier));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/materials/types?supplier=Dimond — distinct types for that supplier
router.get("/types", async (req, res) => {
  try {
    const { supplier = "" } = req.query;
    if (!supplier.trim()) return res.json([]);
    const { rows } = await pool.query(
      `SELECT DISTINCT type FROM roof_materials
       WHERE supplier = $1 AND type IS NOT NULL AND type <> ''
       ORDER BY type`,
      [supplier]
    );
    res.json(rows.map(r => r.type));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/materials/by-type?supplier=Dimond&type=Corrugate — materials for that pair
router.get("/by-type", async (req, res) => {
  try {
    const { supplier = "", type = "" } = req.query;
    if (!supplier.trim() || !type.trim()) return res.json([]);
    const { rows } = await pool.query(
      `SELECT * FROM roof_materials
       WHERE supplier = $1 AND type = $2
       ORDER BY rate_m2 IS NULL, description
       LIMIT 200`,
      [supplier, type]
    );
    res.json(rows.map(serializeMaterial));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
