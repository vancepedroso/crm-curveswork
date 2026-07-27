// Clones the master roof_materials_templates catalog into a brand-new
// organization's own roof_materials rows, so a newly signed-up company
// isn't starting with an empty supplier catalog. Called once, right after
// an organization is created (Stripe checkout webhook — see
// backend/routes/stripeWebhook.js), inside the same transaction/client so
// a failure here rolls the whole signup back rather than leaving a
// half-created org with no materials.
async function cloneMaterialsTemplateForOrg(client, organizationId) {
  await client.query(
    `INSERT INTO roof_materials
       (organization_id, category, supplier, type, sku, description, gauge, coating, unit, rate_lm, rate_m2, cover_width, product_group)
     SELECT $1, category, supplier, type, sku, description, gauge, coating, unit, rate_lm, rate_m2, cover_width, product_group
     FROM roof_materials_templates`,
    [organizationId]
  );
}

module.exports = { cloneMaterialsTemplateForOrg };
