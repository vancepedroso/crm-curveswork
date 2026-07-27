const { Router } = require("express");
const pool   = require("../db");
const bcrypt = require("bcrypt");
const router = Router();

// requireAuth is applied once, in server.js, for every route mounted here —
// no per-router copy needed. Role enforcement (below) is separate: managing
// OTHER users (inviting, disabling, changing someone else's role) requires
// owner/admin; editing your OWN name/email/password is always allowed
// regardless of role — the frontend's Team page only exposes management
// controls to owner/admin, but that's just UI; this is what actually
// enforces it, since a member could otherwise call these endpoints directly.
//
// Looks the role up fresh from the DB rather than trusting req.user.role
// (the JWT's cached claim from sign-in time) — a role change (promotion or
// demotion) must take effect immediately, not only after the affected
// user's token happens to expire or they re-login.
async function isManager(req) {
  const { rows } = await pool.query("SELECT role FROM users WHERE id = $1", [req.user.id]);
  return rows[0]?.role === "owner" || rows[0]?.role === "admin";
}

// ── GET /api/users ───────────────────────────────────────────────────────────
// Returns every user in the CALLER'S OWN organization only (id, name, email,
// role, is_active, created_at). No password hash. Visible to every role —
// everyone can see their own team, only owner/admin can change it.
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, is_active, created_at
       FROM users
       WHERE organization_id = $1
       ORDER BY created_at ASC`,
      [req.user.organizationId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/users ──────────────────────────────────────────────────────────
// Invites a new user into the CALLER'S OWN organization. owner/admin only.
// Requires: name, email, password. Blocked once the org's active user count
// reaches its plan's seat_limit.
router.post("/", async (req, res) => {
  try {
    if (!(await isManager(req))) return res.status(403).json({ error: "Only an owner or admin can add users" });

    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "Name, email and password are required" });
    if (password.length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });

    const { rows: orgRows } = await pool.query(
      "SELECT seat_limit FROM organizations WHERE id = $1", [req.user.organizationId]
    );
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) FROM users WHERE organization_id = $1 AND is_active = true",
      [req.user.organizationId]
    );
    const seatLimit = orgRows[0]?.seat_limit ?? 0;
    const currentCount = parseInt(countRows[0].count, 10);
    if (currentCount >= seatLimit) {
      return res.status(403).json({ error: "seat_limit_exceeded", seatLimit, currentCount });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, is_active, organization_id, role)
       VALUES ($1, $2, $3, true, $4, $5)
       RETURNING id, name, email, role, is_active, created_at`,
      [name, email, hash, req.user.organizationId, role === "admin" ? "admin" : "member"]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505")
      return res.status(400).json({ error: "A user with that email already exists" });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/users/:id ───────────────────────────────────────────────────────
// Updates name, email, and optionally password (only if provided). Anyone
// can edit their OWN record; editing someone else requires owner/admin.
// `role` is only accepted when a manager edits someone else — you can't
// change your own role here, and a non-manager can't touch anyone's role.
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const isSelf = String(req.user.id) === String(id);
    const managerAllowed = isSelf ? false : await isManager(req); // skip the query entirely for the common self-edit case
    if (!isSelf && !managerAllowed) {
      return res.status(403).json({ error: "Only an owner or admin can edit other users" });
    }

    const { name, email, password, role } = req.body;
    if (!name || !email)
      return res.status(400).json({ error: "Name and email are required" });

    const newRole = (managerAllowed && (role === "owner" || role === "admin" || role === "member"))
      ? role : null; // null → SQL COALESCE keeps the existing role untouched

    let row;
    if (password && password.trim()) {
      if (password.length < 6)
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      const hash = await bcrypt.hash(password, 10);
      const result = await pool.query(
        `UPDATE users
         SET name = $1, email = $2, password_hash = $3, role = COALESCE($4, role), updated_at = NOW()
         WHERE id = $5 AND organization_id = $6
         RETURNING id, name, email, role, is_active, created_at`,
        [name, email, hash, newRole, id, req.user.organizationId]
      );
      row = result.rows[0];
    } else {
      const result = await pool.query(
        `UPDATE users
         SET name = $1, email = $2, role = COALESCE($3, role), updated_at = NOW()
         WHERE id = $4 AND organization_id = $5
         RETURNING id, name, email, role, is_active, created_at`,
        [name, email, newRole, id, req.user.organizationId]
      );
      row = result.rows[0];
    }

    if (!row) return res.status(404).json({ error: "User not found" });
    res.json(row);
  } catch (err) {
    if (err.code === "23505")
      return res.status(400).json({ error: "A user with that email already exists" });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/users/:id/status ──────────────────────────────────────────────
// Enables or disables a user account. owner/admin only. Reactivating a
// disabled user grows the active headcount exactly like an invite does, so
// it gets the same seat-limit check.
router.patch("/:id/status", async (req, res) => {
  try {
    if (!(await isManager(req))) return res.status(403).json({ error: "Only an owner or admin can enable/disable users" });

    const { id } = req.params;
    const { is_active } = req.body;
    if (typeof is_active !== "boolean")
      return res.status(400).json({ error: "is_active must be a boolean" });

    // Prevent self-disable
    if (String(req.user.id) === String(id) && !is_active)
      return res.status(400).json({ error: "You cannot disable your own account" });

    if (is_active) {
      const { rows: orgRows } = await pool.query(
        "SELECT seat_limit FROM organizations WHERE id = $1", [req.user.organizationId]
      );
      const { rows: countRows } = await pool.query(
        "SELECT COUNT(*) FROM users WHERE organization_id = $1 AND is_active = true",
        [req.user.organizationId]
      );
      const seatLimit = orgRows[0]?.seat_limit ?? 0;
      const currentCount = parseInt(countRows[0].count, 10);
      if (currentCount >= seatLimit) {
        return res.status(403).json({ error: "seat_limit_exceeded", seatLimit, currentCount });
      }
    }

    const { rows } = await pool.query(
      `UPDATE users
       SET is_active = $1, updated_at = NOW()
       WHERE id = $2 AND organization_id = $3
       RETURNING id, name, email, role, is_active, created_at`,
      [is_active, id, req.user.organizationId]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
