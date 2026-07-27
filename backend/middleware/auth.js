const jwt  = require("jsonwebtoken");
const pool = require("../db");

const JWT_SECRET = process.env.JWT_SECRET || "changeme_use_env_in_prod";

// Shared by every route that needs a logged-in user. Was previously
// duplicated separately in routes/users.js and routes/companyProfile.js —
// consolidated here so there's exactly one place that decides what makes a
// token valid.
//
// Tokens are versioned (`v`) because the JWT payload grew from
// {id,name,email} to also carry {organizationId,role,isPlatformAdmin} —
// every route that scopes data by organization depends on that field being
// present, so a pre-multi-tenant token (v<2 or missing `v` entirely) is
// rejected here rather than being allowed through with organizationId
// silently undefined. This forces a one-time re-login on deploy instead of
// letting an old session limp along in a state no downstream query expects.
const CURRENT_TOKEN_VERSION = 2;

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorised" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.organizationId || (payload.v || 0) < CURRENT_TOKEN_VERSION) {
      return res.status(401).json({ error: "Session out of date, please log in again" });
    }
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Cross-organization access (viewing every org, not just your own) — must
// come after requireAuth. Looks the flag up fresh from the DB rather than
// trusting the JWT's cached isPlatformAdmin claim, same reasoning as the
// role checks in routes/users.js: a permission change should take effect
// immediately, not only once the affected token happens to expire.
async function requirePlatformAdmin(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT is_platform_admin FROM users WHERE id = $1", [req.user.id]);
    if (!rows[0]?.is_platform_admin) return res.status(403).json({ error: "Platform admin access required" });
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { requireAuth, requirePlatformAdmin, JWT_SECRET, CURRENT_TOKEN_VERSION };
