const { Router } = require("express");
const fs     = require("fs");
const path   = require("path");
const pool   = require("../db");
const router = Router();

const SNAPSHOT_DIR = path.join(__dirname, "..", "uploads", "geometry-snapshots");
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

// Decodes a "data:image/png;base64,...." string and writes it to disk,
// returning the public URL. Returns null if no data URL was provided.
function saveSnapshot(projectId, dataUrl) {
  if (!dataUrl || !dataUrl.startsWith("data:image/")) return null;
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return null;
  const [, ext, base64] = match;
  const filename = `${projectId}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(SNAPSHOT_DIR, filename), Buffer.from(base64, "base64"));
  return `/uploads/geometry-snapshots/${filename}`;
}

// GET estimate for a project
router.get("/:projectId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM estimates WHERE project_id = $1",
      [req.params.projectId]
    );
    if (!rows.length) return res.status(404).json({ error: "No estimate" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create estimate
router.post("/:projectId", async (req, res) => {
  try {
    const e = req.body;
    const { rows } = await pool.query(
      `INSERT INTO estimates (project_id, area, pitch, waste, material_rate,
         material_label, flashings, guttering, day_rate, days, margin, complexity,
         adj_area, mat_cost, flash_cost, gut_cost, lab_cost,
         margin_amt, sell_price, gst, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (project_id) DO UPDATE SET
         area=EXCLUDED.area, pitch=EXCLUDED.pitch, waste=EXCLUDED.waste,
         material_rate=EXCLUDED.material_rate, material_label=EXCLUDED.material_label,
         flashings=EXCLUDED.flashings, guttering=EXCLUDED.guttering,
         day_rate=EXCLUDED.day_rate, days=EXCLUDED.days, margin=EXCLUDED.margin,
         complexity=EXCLUDED.complexity,
         adj_area=EXCLUDED.adj_area, mat_cost=EXCLUDED.mat_cost,
         flash_cost=EXCLUDED.flash_cost, gut_cost=EXCLUDED.gut_cost,
         lab_cost=EXCLUDED.lab_cost, margin_amt=EXCLUDED.margin_amt,
         sell_price=EXCLUDED.sell_price, gst=EXCLUDED.gst, total=EXCLUDED.total
       RETURNING *`,
      [req.params.projectId, e.area, e.pitch, e.waste, e.materialRate,
       e.materialLabel, e.flashings, e.guttering, e.dayRate, e.days, e.margin, e.complexity || "medium",
       e.adjArea, e.matCost, e.flashCost, e.gutCost, e.labCost,
       e.marginAmt, e.sellPrice, e.gst, e.total]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET geometry for a project
router.get("/:projectId/geometry", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM project_geometries WHERE project_id = $1",
      [req.params.projectId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / PUT geometry
router.post("/:projectId/geometry", async (req, res) => {
  try {
    const g = req.body;
    const newSnapshotUrl = saveSnapshot(req.params.projectId, g.snapshotDataUrl);

    // Preserve the existing snapshot if this save didn't include a new one
    // (e.g. geometry re-saved without re-capturing the canvas).
    let snapshotUrl = newSnapshotUrl;
    if (!snapshotUrl) {
      const { rows: existing } = await pool.query(
        "SELECT snapshot_url FROM project_geometries WHERE project_id = $1",
        [req.params.projectId]
      );
      snapshotUrl = existing[0]?.snapshot_url || null;
    }

    const { rows } = await pool.query(
      `INSERT INTO project_geometries (project_id, sections, accessories, asbestos,
         scale_m_per_px, total_footprint_m2, total_surface_m2, total_flashing_m, total_gutter_m, snapshot_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (project_id) DO UPDATE SET
         sections=EXCLUDED.sections, accessories=EXCLUDED.accessories,
         asbestos=EXCLUDED.asbestos, scale_m_per_px=EXCLUDED.scale_m_per_px,
         total_footprint_m2=EXCLUDED.total_footprint_m2,
         total_surface_m2=EXCLUDED.total_surface_m2,
         total_flashing_m=EXCLUDED.total_flashing_m,
         total_gutter_m=EXCLUDED.total_gutter_m,
         snapshot_url=EXCLUDED.snapshot_url
       RETURNING *`,
      [req.params.projectId, JSON.stringify(g.sections || []),
       JSON.stringify(g.accessories || {}), g.asbestos || false,
       g.scale_m_per_px || 0.05, g.total_footprint_m2 || 0,
       g.total_surface_m2 || 0, g.total_flashing_m || 0, g.total_gutter_m || 0,
       snapshotUrl]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;