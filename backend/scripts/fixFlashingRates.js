// One-off (re-runnable) data fix: the Dimond "Flashing" catalog (girth-banded
// custom flashings, e.g. "0.55mm BMT Dimond Flashing (301-350) Zinc") was
// imported with its price sitting in rate_m2 and no cover_width — since
// flashing girth bands don't have a "cover width" (that's a cladding-profile
// concept), the app's m²→lm conversion always fell back to $0 for every one
// of these 4,032 rows. Confirmed with the user that this rate is already the
// final $/lm price for that girth band, not a true area rate — so it belongs
// in rate_lm directly, matching how the (correctly-priced) Metalcraft
// flashing catalog already stores it.
//
// Scoped to type='Flashing' specifically (not just any type containing
// "flash", e.g. "Flashing Tape") so it only touches the exact rows diagnosed.
//
// Usage (from backend/):  node scripts/fixFlashingRates.js
const pool = require("../db");

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE roof_materials
         SET rate_lm = rate_m2, rate_m2 = NULL
       WHERE type = 'Flashing' AND rate_lm IS NULL AND rate_m2 IS NOT NULL
       RETURNING id`
    );
    await client.query("COMMIT");
    console.log(`Moved rate_m2 -> rate_lm for ${rows.length} Flashing rows.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error("Fix failed:", err); process.exit(1); });
