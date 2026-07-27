// Cross-organization, read-only view for platform admins (you, the SaaS
// operator) — every other route in this app is deliberately scoped to the
// caller's own organization; these two are the only exception, and are
// gated by requirePlatformAdmin (mounted in server.js) rather than the
// normal org-scoping pattern.
const { Router } = require("express");
const bcrypt = require("bcrypt");
const pool   = require("../db");
const router = Router();

// GET /api/platform-admin/organizations — every organization on the
// platform, with plan/seat/status and a live active-user count.
router.get("/organizations", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.id, o.name, o.status, o.plan_key, o.seat_limit, o.created_at,
             COUNT(u.id) FILTER (WHERE u.is_active) AS active_user_count
      FROM organizations o
      LEFT JOIN users u ON u.organization_id = o.id
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `);
    res.json(rows.map(r => ({
      id: r.id, name: r.name, status: r.status, planKey: r.plan_key,
      seatLimit: r.seat_limit, activeUserCount: parseInt(r.active_user_count, 10),
      createdAt: r.created_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/platform-admin/organizations/:id/users — drill-down into one
// organization's user list (same shape as GET /api/users, just not scoped
// to the caller's own org).
router.get("/organizations/:id/users", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, is_active, is_platform_admin, created_at
       FROM users WHERE organization_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/platform-admin/organizations — create a brand-new organization
// with no users yet (manually provisioned — comped/demo/sales-negotiated
// accounts that sit alongside the Stripe self-serve signup path, not a
// replacement for it). plan_key 'manual' distinguishes these from
// Stripe-managed orgs; seat_limit is set directly here rather than looked
// up from a plan, same as config/plans.js already anticipates for
// manually-comped orgs.
router.post("/organizations", async (req, res) => {
  try {
    const { name, seatLimit } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Organization name is required" });
    const seats = parseInt(seatLimit, 10);
    if (!Number.isInteger(seats) || seats < 1) {
      return res.status(400).json({ error: "Seat limit must be a positive integer" });
    }

    const { rows } = await pool.query(
      `INSERT INTO organizations (name, status, plan_key, seat_limit)
       VALUES ($1, 'active', 'manual', $2)
       RETURNING id, name, status, plan_key, seat_limit, created_at`,
      [name.trim(), seats]
    );
    const org = rows[0];
    res.status(201).json({
      id: org.id, name: org.name, status: org.status, planKey: org.plan_key,
      seatLimit: org.seat_limit, activeUserCount: 0, createdAt: org.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/platform-admin/organizations/:id — rename / change seat limit /
// change status. Fields are optional — only what's sent gets changed.
router.put("/organizations/:id", async (req, res) => {
  try {
    const { name, seatLimit, status } = req.body;
    let seats = null;
    if (seatLimit !== undefined) {
      seats = parseInt(seatLimit, 10);
      if (!Number.isInteger(seats) || seats < 1) {
        return res.status(400).json({ error: "Seat limit must be a positive integer" });
      }
    }
    const { rows } = await pool.query(
      `UPDATE organizations SET
         name = COALESCE($1, name),
         seat_limit = COALESCE($2, seat_limit),
         status = COALESCE($3, status),
         updated_at = NOW()
       WHERE id = $4
       RETURNING id, name, status, plan_key, seat_limit`,
      [name?.trim() || null, seats, status || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Organization not found" });
    const org = rows[0];
    res.json({ id: org.id, name: org.name, status: org.status, planKey: org.plan_key, seatLimit: org.seat_limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/platform-admin/organizations/:id/users — create a user inside
// a specific org. Role is restricted to admin/member — this console
// stands up a manually-provisioned org's team; it doesn't hand out
// Stripe-billing "owner" access outside the self-serve flow.
router.post("/organizations/:id/users", async (req, res) => {
  try {
    const orgId = req.params.id;
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email and password are required" });
    }
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const finalRole = role === "admin" ? "admin" : "member";

    const { rows: orgRows } = await pool.query("SELECT seat_limit FROM organizations WHERE id = $1", [orgId]);
    if (!orgRows.length) return res.status(404).json({ error: "Organization not found" });

    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) FROM users WHERE organization_id = $1 AND is_active = true", [orgId]
    );
    if (parseInt(countRows[0].count, 10) >= orgRows[0].seat_limit) {
      return res.status(403).json({ error: "seat_limit_exceeded", seatLimit: orgRows[0].seat_limit, currentCount: parseInt(countRows[0].count, 10) });
    }

    const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.length) return res.status(400).json({ error: "Email already in use" });

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, organization_id, role, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, name, email, role, is_active, is_platform_admin, created_at`,
      [name, email, passwordHash, orgId, finalRole]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/platform-admin/organizations/:id/users/:userId — edit a user
// inside any org: name/email/role/active + optional password reset. Same
// shape as the caller's own-org PUT /api/users/:id, just not scoped to
// your own org — this is the cross-org exception, gated by
// requirePlatformAdmin at the router mount (server.js), same as every
// other route in this file.
router.put("/organizations/:id/users/:userId", async (req, res) => {
  try {
    const { id: orgId, userId } = req.params;
    const { name, email, role, is_active, password } = req.body;
    if (role && !["owner", "admin", "member"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    let passwordHash = null;
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
      passwordHash = await bcrypt.hash(password, 10);
    }
    const { rows } = await pool.query(
      `UPDATE users SET
         name = COALESCE($1, name),
         email = COALESCE($2, email),
         role = COALESCE($3, role),
         is_active = COALESCE($4, is_active),
         password_hash = COALESCE($5, password_hash),
         updated_at = NOW()
       WHERE id = $6 AND organization_id = $7
       RETURNING id, name, email, role, is_active, is_platform_admin, created_at`,
      [name || null, email || null, role || null, is_active === undefined ? null : is_active, passwordHash, userId, orgId]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found in this organization" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
