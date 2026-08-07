#!/usr/bin/env node
// One-off migration: push the files still sitting in backend/uploads/ up to
// Cloudinary and repoint the matching database rows at the new URLs.
//
// Needed because uploads used to be written to local disk. That survives on
// a dev machine but not on a managed host with an ephemeral filesystem, so
// after deploying, every historical image 404'd. Uploading the backlog is
// what actually brings those images back — the code change alone only fixes
// images created from now on.
//
// Safe to re-run: rows whose URL is already an absolute Cloudinary URL are
// skipped, and a file that no longer exists locally is reported and skipped
// rather than failing the run.
//
//   node scripts/migrateUploadsToCloudinary.js            # migrate
//   node scripts/migrateUploadsToCloudinary.js --dry-run  # report only
require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const pool = require("../db");
const { CLOUDINARY_CONFIGURED, FOLDERS, uploadBuffer } = require("../lib/cloudinaryStorage");

const DRY = process.argv.includes("--dry-run");
const UPLOADS = path.join(__dirname, "..", "uploads");

// Each DB column that holds an image URL, paired with the local folder the
// file lives in and the Cloudinary folder it should land in.
const TARGETS = [
  { table: "project_photos",     column: "url",                localDir: "photos",             folder: FOLDERS.photos },
  { table: "job_photos",         column: "url",                localDir: "job-photos",         folder: FOLDERS.jobPhotos },
  { table: "company_profiles",   column: "logo_url",           localDir: "branding",           folder: FOLDERS.branding },
  { table: "company_profiles",   column: "badges_url",         localDir: "branding",           folder: FOLDERS.branding },
  { table: "project_geometries", column: "snapshot_url",       localDir: "geometry-snapshots", folder: FOLDERS.geometrySnapshots },
  { table: "project_geometries", column: "original_photo_url", localDir: "original-photos",    folder: FOLDERS.originalPhotos },
];

async function main() {
  if (!CLOUDINARY_CONFIGURED) {
    console.error("✗ Cloudinary env vars missing — set CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET");
    process.exit(1);
  }
  console.log(DRY ? "DRY RUN — nothing will be written\n" : "Migrating uploads to Cloudinary\n");

  const totals = { uploaded: 0, missing: 0, skipped: 0, failed: 0 };

  for (const t of TARGETS) {
    const { rows } = await pool.query(
      `SELECT id, ${t.column} AS url FROM ${t.table} WHERE ${t.column} IS NOT NULL AND ${t.column} <> ''`
    );
    // Already-absolute URLs are previous runs' work, or job-library photos
    // that were never local to begin with.
    const pending = rows.filter(r => r.url.startsWith("/uploads/"));
    totals.skipped += rows.length - pending.length;
    if (!pending.length) { console.log(`  ${t.table}.${t.column}: nothing to do`); continue; }

    console.log(`  ${t.table}.${t.column}: ${pending.length} to migrate`);
    for (const row of pending) {
      const filename = path.basename(row.url);
      const localPath = path.join(UPLOADS, t.localDir, filename);
      if (!fs.existsSync(localPath)) {
        console.log(`    ✗ missing locally: ${filename}`);
        totals.missing++;
        continue;
      }
      if (DRY) { console.log(`    · would upload ${filename}`); totals.uploaded++; continue; }
      try {
        // Strip the extension — Cloudinary derives it and appends it itself,
        // so leaving it on would produce "name.png.png".
        const publicId = filename.replace(/\.[^.]+$/, "");
        const url = await uploadBuffer(fs.readFileSync(localPath), t.folder, publicId);
        await pool.query(`UPDATE ${t.table} SET ${t.column} = $1 WHERE id = $2`, [url, row.id]);
        console.log(`    ✓ ${filename}`);
        totals.uploaded++;
      } catch (e) {
        console.log(`    ✗ failed ${filename}: ${e.message}`);
        totals.failed++;
      }
    }
  }

  console.log(`\n  uploaded=${totals.uploaded}  missing=${totals.missing}  already-remote=${totals.skipped}  failed=${totals.failed}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
