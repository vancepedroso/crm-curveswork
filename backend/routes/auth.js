const { Router } = require("express");
const pool   = require("../db");
const bcrypt = require("bcrypt");
const jwt    = require("jsonwebtoken");
const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || "changeme_use_env_in_prod";

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password required" });

    const { rows } = await pool.query(
      "SELECT * FROM users WHERE email = $1", [email]
    );
    if (!rows.length)
      return res.status(401).json({ error: "Invalid email or password" });

    const match = await bcrypt.compare(password, rows[0].password_hash);
    if (!match)
      return res.status(401).json({ error: "Invalid email or password" });

    // Block disabled accounts
    if (rows[0].is_active === false)
      return res.status(403).json({ error: "This account has been disabled. Contact your administrator." });

    const user  = { id: rows[0].id, name: rows[0].name, email: rows[0].email };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register  ← use this once to create your account
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "Name, email and password required" });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id, name, email`,
      [name, email, hash]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505")
      return res.status(400).json({ error: "Email already in use" });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;