const { Router } = require("express");
const pool   = require("../db");
const { FOLDERS, uploadDataUrl } = require("../lib/cloudinaryStorage");
const router = Router();

// The measurement tool posts these as base64 data URLs inside the JSON body
// rather than as multipart, so they don't go through multer — they're
// decoded and pushed to Cloudinary directly. Two distinct images:
//   · snapshot      — the flattened photo+drawing composite, embedded in quotes
//   · originalPhoto — the clean, undrawn-on photo, kept so re-editing a
//                     project has something real to trace over instead of
//                     the previous session's drawing baked into the pixels
// Both were previously written to backend/uploads/, which a managed host
// wipes on every restart — see lib/cloudinaryStorage.js.
const saveSnapshot      = (projectId, dataUrl) =>
  uploadDataUrl(dataUrl, FOLDERS.geometrySnapshots, `${projectId}-${Date.now()}`);
const saveOriginalPhoto = (projectId, dataUrl) =>
  uploadDataUrl(dataUrl, FOLDERS.originalPhotos, `${projectId}-${Date.now()}`);

// Every route below hangs off :projectId — confirm it's actually a project
// in the caller's own organization before touching its estimate/geometry,
// rather than trusting the id in the URL alone.
async function assertOwnProject(projectId, organizationId) {
  const { rows } = await pool.query(
    "SELECT id FROM projects WHERE id = $1 AND organization_id = $2", [projectId, organizationId]
  );
  return rows.length > 0;
}

// GET estimate for a project
router.get("/:projectId", async (req, res) => {
  try {
    if (!(await assertOwnProject(req.params.projectId, req.user.organizationId)))
      return res.status(404).json({ error: "No estimate" });
    const { rows } = await pool.query(
      "SELECT * FROM estimates WHERE project_id = $1 AND organization_id = $2",
      [req.params.projectId, req.user.organizationId]
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
    if (!(await assertOwnProject(req.params.projectId, req.user.organizationId)))
      return res.status(404).json({ error: "Project not found" });
    const e = req.body;
    const { rows } = await pool.query(
      `INSERT INTO estimates (project_id, area, pitch, waste, material_rate,
         material_label, flashings, guttering, downpipes, drains, penetrations,
         day_rate, days, margin, complexity, flashing_runs,
         sections, gutter_runs, downpipe_items, drain_items, penetration_items,
         adj_area, mat_cost, flash_cost, gut_cost, downpipe_cost, drain_cost, penetration_cost, lab_cost,
         margin_amt, sell_price, gst, total, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
       ON CONFLICT (project_id) DO UPDATE SET
         area=EXCLUDED.area, pitch=EXCLUDED.pitch, waste=EXCLUDED.waste,
         material_rate=EXCLUDED.material_rate, material_label=EXCLUDED.material_label,
         flashings=EXCLUDED.flashings, guttering=EXCLUDED.guttering,
         downpipes=EXCLUDED.downpipes, drains=EXCLUDED.drains, penetrations=EXCLUDED.penetrations,
         day_rate=EXCLUDED.day_rate, days=EXCLUDED.days, margin=EXCLUDED.margin,
         complexity=EXCLUDED.complexity, flashing_runs=EXCLUDED.flashing_runs,
         sections=EXCLUDED.sections, gutter_runs=EXCLUDED.gutter_runs,
         downpipe_items=EXCLUDED.downpipe_items, drain_items=EXCLUDED.drain_items,
         penetration_items=EXCLUDED.penetration_items,
         adj_area=EXCLUDED.adj_area, mat_cost=EXCLUDED.mat_cost,
         flash_cost=EXCLUDED.flash_cost, gut_cost=EXCLUDED.gut_cost,
         downpipe_cost=EXCLUDED.downpipe_cost, drain_cost=EXCLUDED.drain_cost,
         penetration_cost=EXCLUDED.penetration_cost,
         lab_cost=EXCLUDED.lab_cost, margin_amt=EXCLUDED.margin_amt,
         sell_price=EXCLUDED.sell_price, gst=EXCLUDED.gst, total=EXCLUDED.total
       RETURNING *`,
      [req.params.projectId, e.area, e.pitch, e.waste, e.materialRate,
       e.materialLabel, e.flashings, e.guttering, e.downpipes || 0, e.drains || 0, e.penetrations || 0,
       e.dayRate, e.days, e.margin, e.complexity || "medium",
       JSON.stringify(e.flashingRuns || []),
       JSON.stringify(e.sections || []), JSON.stringify(e.gutterRuns || []),
       JSON.stringify(e.downpipeItems || []), JSON.stringify(e.drainItems || []), JSON.stringify(e.penetrationItems || []),
       e.adjArea, e.matCost, e.flashCost, e.gutCost, e.downpipeCost || 0, e.drainCost || 0, e.penetrationCost || 0, e.labCost,
       e.marginAmt, e.sellPrice, e.gst, e.total, req.user.organizationId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET geometry for a project
router.get("/:projectId/geometry", async (req, res) => {
  try {
    if (!(await assertOwnProject(req.params.projectId, req.user.organizationId)))
      return res.json(null);
    const { rows } = await pool.query(
      "SELECT * FROM project_geometries WHERE project_id = $1 AND organization_id = $2",
      [req.params.projectId, req.user.organizationId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / PUT geometry
router.post("/:projectId/geometry", async (req, res) => {
  try {
    if (!(await assertOwnProject(req.params.projectId, req.user.organizationId)))
      return res.status(404).json({ error: "Project not found" });
    const g = req.body;
    const newSnapshotUrl = await saveSnapshot(req.params.projectId, g.snapshotDataUrl);
    // A locally-picked file arrives as a data URL and needs uploading; a
    // photo chosen from the job library is already a hosted asset, so its
    // URL is taken as-is (originalPhotoUrl) with nothing to re-upload.
    // That pass-through now accepts absolute Cloudinary URLs as well as the
    // legacy relative "/uploads/..." form, since job photos live remotely.
    const newOriginalPhotoUrl =
      (await saveOriginalPhoto(req.params.projectId, g.originalPhotoDataUrl)) ||
      (typeof g.originalPhotoUrl === "string" &&
        (g.originalPhotoUrl.startsWith("/") || g.originalPhotoUrl.startsWith("https://"))
        ? g.originalPhotoUrl : null);

    // Preserve the existing snapshot/original photo if this save didn't
    // include a new one (e.g. geometry re-saved without re-capturing the
    // canvas, or without picking a new photo this session).
    let snapshotUrl = newSnapshotUrl;
    let originalPhotoUrl = newOriginalPhotoUrl;
    if (!snapshotUrl || !originalPhotoUrl) {
      const { rows: existing } = await pool.query(
        "SELECT snapshot_url, original_photo_url FROM project_geometries WHERE project_id = $1 AND organization_id = $2",
        [req.params.projectId, req.user.organizationId]
      );
      snapshotUrl = snapshotUrl || existing[0]?.snapshot_url || null;
      originalPhotoUrl = originalPhotoUrl || existing[0]?.original_photo_url || null;
    }

    const { rows } = await pool.query(
      `INSERT INTO project_geometries (project_id, sections, accessories, asbestos,
         scale_m_per_px, total_footprint_m2, total_surface_m2, total_flashing_m, total_gutter_m, snapshot_url, original_photo_url, dimension_lines, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (project_id) DO UPDATE SET
         sections=EXCLUDED.sections, accessories=EXCLUDED.accessories,
         asbestos=EXCLUDED.asbestos, scale_m_per_px=EXCLUDED.scale_m_per_px,
         total_footprint_m2=EXCLUDED.total_footprint_m2,
         total_surface_m2=EXCLUDED.total_surface_m2,
         total_flashing_m=EXCLUDED.total_flashing_m,
         total_gutter_m=EXCLUDED.total_gutter_m,
         snapshot_url=EXCLUDED.snapshot_url,
         original_photo_url=EXCLUDED.original_photo_url,
         dimension_lines=EXCLUDED.dimension_lines
       RETURNING *`,
      [req.params.projectId, JSON.stringify(g.sections || []),
       JSON.stringify(g.accessories || {}), g.asbestos || false,
       g.scale_m_per_px || 0.05, g.total_footprint_m2 || 0,
       g.total_surface_m2 || 0, g.total_flashing_m || 0, g.total_gutter_m || 0,
       snapshotUrl, originalPhotoUrl, JSON.stringify(g.dimensionLines || []), req.user.organizationId]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
