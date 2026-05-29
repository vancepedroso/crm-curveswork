const { Router } = require("express");
const pool   = require("../db");
const bcrypt = require("bcrypt");
const router = Router();

// ── Auth middleware ──────────────────────────────────────────────────────────
// Re-use whatever JWT middleware you already apply globally, or inline a check:
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "changeme_use_env_in_prod";

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorised" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── GET /api/users ───────────────────────────────────────────────────────────
// Returns all users (id, name, email, is_active, created_at). No password hash.
router.get("/", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, is_active, created_at
       FROM users
       ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/users ──────────────────────────────────────────────────────────
// Creates a new user. Requires: name, email, password.
router.post("/", requireAuth, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "Name, email and password are required" });
    if (password.length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, is_active)
       VALUES ($1, $2, $3, true)
       RETURNING id, name, email, is_active, created_at`,
      [name, email, hash]
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
// Updates name, email, and optionally password (only if provided).
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password } = req.body;
    if (!name || !email)
      return res.status(400).json({ error: "Name and email are required" });

    let row;
    if (password && password.trim()) {
      // Update with new password
      if (password.length < 6)
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      const hash = await bcrypt.hash(password, 10);
      const result = await pool.query(
        `UPDATE users
         SET name = $1, email = $2, password_hash = $3, updated_at = NOW()
         WHERE id = $4
         RETURNING id, name, email, is_active, created_at`,
        [name, email, hash, id]
      );
      row = result.rows[0];
    } else {
      // Update without changing password
      const result = await pool.query(
        `UPDATE users
         SET name = $1, email = $2, updated_at = NOW()
         WHERE id = $3
         RETURNING id, name, email, is_active, created_at`,
        [name, email, id]
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
// Enables or disables a user account.
router.patch("/:id/status", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    if (typeof is_active !== "boolean")
      return res.status(400).json({ error: "is_active must be a boolean" });

    // Prevent self-disable
    if (String(req.user.id) === String(id) && !is_active)
      return res.status(400).json({ error: "You cannot disable your own account" });

    const { rows } = await pool.query(
      `UPDATE users
       SET is_active = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, is_active, created_at`,
      [is_active, id]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;