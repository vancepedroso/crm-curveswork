# Express → Python / FastAPI Migration Plan

**Status:** planning · no code written yet
**Goal:** replace the Express backend with FastAPI on the **same PostgreSQL database**, so the React web app and a future React Native app share one Python API. Auth migrates too — no Express afterwards.

---

## 1. Feasibility — verified, not assumed

| Check | Finding |
|---|---|
| Backend size | **~2,650 lines**, 18 route files |
| Endpoints | **64** (see §4) |
| Frontend coupling | **One `src/api.js`** — 58 wrappers, one `request()` helper |
| Database | **20 live tables** — **zero data migration** |
| Python | **3.12.7 + pip 24.2 installed**, no packages yet |
| Password hashes | **`$2b$10$…`, 60 chars, 7 users** — read natively by Python `bcrypt` |
| JWT | HS256 + shared secret — PyJWT reproduces identical tokens |
| SQL | Raw parameterised SQL — **no ORM to unpick** |
| Background work | **No cron, no queues, no websockets** |
| Stripe surface | **Zero `stripe.subscriptions.*` calls** — webhook-in / hosted-portal-out |

**Verdict: yes, and this codebase is unusually well suited to it.** Because the DB, JWT and bcrypt formats are standard and shared, the cutover can be invisible to users — same logins, same live sessions, same data.

### Agreed approach
1. **Parallel build**, swap when complete. Express untouched; FastAPI on another port against the same DB; takes over `3001` only when every endpoint matches. Rollback = change one port back.
2. **Seamless auth** — same secret, algorithm, claims, hashes. No forced re-login.
3. **Raw SQL** via asyncpg / SQLAlchemy Core. Keep `ON CONFLICT`, `RETURNING`, JSONB as-is.
4. **Separate repository** for the Python service.

---

## 2. Risks, ranked by likelihood of silent damage

### 🔴 1. JSONB double-encoding — easiest way to corrupt data
Ten write sites currently `JSON.stringify(...)` into a `$n` placeholder (`estimates.js:92-94,162-166`, `projects.js:212-217,323-328`, `quotes.js:50`). node-postgres requires that; **SQLAlchemy/psycopg with a `JSONB` column serialises automatically.** Carrying `json.dumps()` across stores a JSON *string* instead of an array/object — and it looks fine until something reads it back.

Affected columns (9): `estimates.{flashing_runs, sections, gutter_runs, downpipe_items, drain_items, penetration_items}`, `project_geometries.{sections, accessories, dimension_lines}`, `quotes.snapshot`.

*Exception:* `app_settings.value` is **TEXT holding JSON** — that one **does** need manual `json.loads`/`dumps`.
*Good news:* no JSONB operators (`->`, `@>`, `jsonb_set`) anywhere, so reads are plain.

### 🔴 2. The repo does not contain the true schema
`database/schema.sql` is **~8 migrations stale** (missing 24–31). `atoproff.backup` is ~25 migrations stale. There is **no migration runner and no applied-migrations table** — migrations are applied by hand.

➡️ **Start with `pg_dump --schema-only` of the live DB** and treat that as truth. Then adopt Alembic with `alembic stamp head`. Building models from `schema.sql` produces a subtly wrong schema.

### 🟠 3. Response-shape fidelity
The current API is *inconsistent by accident*, and the frontend depends on the accident:

- **Two casing conventions coexist.** camelCase via hand-written serializers (`projects`, `jobs`, `quotes`, `photos`, `materials`, `company-profile`) vs **raw snake_case** from `SELECT *` (`customers`, all 4 `estimates` routes, `business-regions`, `dashboard`, `pipeline`). The raw ones also **leak `organization_id`** to the client.
- **`DECIMAL`/`NUMERIC` arrive as JSON _strings_** wherever there's no serializer. Pydantic emits numbers unless forced.
- **`|| default` is falsy-coalescing, not null-coalescing.** A stored pitch of `0` becomes `1.15`; `waste` `0` → `10`; `gstRate` `0` → `0.15`. Python's `or` matches — **port literally, resist "fixing"**.
- **`quoteDate` is a genuine divergence.** node-pg returns `DATE` as a JS `Date` → `"2025-08-07T00:00:00.000Z"`. Python `date` → `"2025-08-07"`. Must be forced to match.

### 🟠 4. `materials.js` needs a rewrite, not a transliteration
Lines 39–167 build a variable-length `ILIKE` WHERE clause **and** a parallel relevance-score expression that re-references the same `$n` placeholders by recomputed index (`base = i * cols.length`), plus conditional index-shifting for the `__no_supplier__` sentinel. SQLAlchemy uses named binds, so the arithmetic disappears — but it must be rewritten with its own tests. It is on the hot path of every quote.

### 🟠 5. Authorization is subtler than it looks
- `requireAuth` rejects tokens with `v < 2` or no `organizationId`. **Dropping this silently lets `organizationId: undefined` reach every query.**
- `requirePlatformAdmin`, `isManager`, `isBillingManager` **deliberately re-read the role from the DB and ignore the JWT claim**, so demotion applies immediately. Trusting `req.user.role` would be a real authz regression.
- Must stay **401** (not 403) for bad/expired tokens — `src/api.js:55` keys auto-logout off 401.

### 🟡 6. Multi-tenancy has no framework backstop
~163 manual `organization_id` predicates, always from the token, never the body. Four intentional exceptions: global `business_regions`, the platform-admin router, the Stripe webhook, login-by-email. Keep the explicit style for reviewability; consider Postgres RLS as a **follow-up**, not during the port.

### 🟡 7. Stripe
- Raw body must be read before parsing (`await request.body()`).
- Idempotency uses `INSERT … ON CONFLICT (event_id) DO NOTHING RETURNING event_id` **inside the same transaction as the work** — zero rows returned means duplicate. That coupling is load-bearing.
- **`invoice.subscription` moved** in 2025-era API versions → a naive port makes `past_due` silently never fire. **Pin the API version explicitly.**
- `stripe.customers.retrieve` can return a deleted-customer stub — needs a `.get()` guard.
- Stripe is **currently in bypass mode** (keys commented out in `.env`), so the real path has almost certainly never executed. **Treat every real-Stripe branch as untested code.**

### 🟡 8. bcrypt's 72-byte behaviour differs
Node truncates silently; Python `bcrypt>=4` **raises**. Truncate explicitly on hash *and* verify.

### 🟡 9. Upload-size guard disappears by default
`express.json({limit:"5mb"})` is the only cap on the base64 geometry-snapshot path (`estimates.js:20-30`). FastAPI has no default body limit — omitting one silently removes a guard.

---

## 3. Pre-existing bugs — decide port-as-is or fix

| # | Issue | Location | Suggested |
|---|---|---|---|
| 1 | **Transaction leak** — early `return` after `BEGIN`, no `ROLLBACK`, connection released mid-transaction | `projects.js:161-176, 257-266, 284` | ✅ Fix silently |
| 2 | **Read-then-insert race** on first company-profile access | `companyProfile.js:60-68` | ✅ Fix silently |
| 3 | **Estimate write paths disagree** — `projects.js` writes 41 cols, `estimates.js` 34 (omits `gst_rate`, 4 discount cols, 2 fitting-rate cols). Already drifted. | `estimates.js:65-97` | ⚠️ Decide |
| 4 | Estimates with `total = 0` silently not saved | `projects.js:194, 286` | ⚠️ Decide |
| 5 | Soft delete filtered only in `GET /projects`; other verbs act on deleted rows | `projects.js` | ⚠️ Decide |
| 6 | Org `status` (`canceled`/`past_due`) **never enforced** — cancelled orgs keep full access | no middleware | ⚠️ Decide |
| 7 | **`/uploads` unauthenticated static**, not org-scoped; `image/svg+xml` allowed with **caller-controlled file extension** → cross-tenant read + stored-XSS | `server.js:38`, `companyProfile.js:25` | 🔒 Recommend fixing |
| 8 | Login user-enumerable by timing; email match case-sensitive; no rate limiting | `auth.js:24-30` | ⚠️ Decide |
| 9 | Deleting a customer cascades away all projects/quotes/photos and **orphans files on disk** | `customers.js:64` | ⚠️ Decide |

---

## 4. Endpoint checklist — 64 total

### Auth & identity (12)
- [ ] `POST /api/auth/login` — ⚠️ password verified *before* `is_active` check; that order is load-bearing
- [ ] `GET /api/users` · `POST /api/users` · `PUT /api/users/:id` · `PATCH /api/users/:id/status`
- [ ] `GET /api/organization`
- [ ] `platform-admin` ×6 — cross-org by design, gated on the **DB** `is_platform_admin` flag

### Billing & Stripe (9)
- [ ] `POST /api/billing/checkout-session` — **public**; two divergent org-creation paths (bypass `status='trialing'` vs webhook `status='active'`) — unify into one service function
- [ ] `GET /portal-session` · `GET /payment-methods` · `GET /publishable-key`
- [ ] `POST /setup-intent` · `POST /payment-methods/dummy` · `POST /payment-methods/:id/default` · `DELETE /payment-methods/:id`
- [ ] `POST /api/stripe/webhook` — raw body; 4 events handled

### Core domain (10)
- [ ] `projects` ×6 — 41-param insert, `ON CONFLICT` upsert, `PROJECT_SELECT` join
- [ ] `estimates` ×4 — 44 columns, JSONB, geometry upsert, base64 image writes, **preserve-on-partial-save** (`estimates.js:129-145` — port exactly or re-saving geometry blanks the images)

### CRUD (12)
- [ ] `customers` ×5 · `jobs` ×5 · `quotes` ×2

### Files (9)
- [ ] `photos` ×3 · `job-photos` ×3 · `company-profile` ×3
- [ ] Filename patterns **must match exactly** so URLs already in the DB resolve
- [ ] Keep differing limits: photos/job-photos 10 MB × 10 (HEIC ok); branding 5 MB × 1 (SVG ok)

### Reference & settings (10)
- [ ] `materials` ×4 — see risk 4
- [ ] `settings` ×3 — note `GET /org-business-region` **writes** on first read
- [ ] `complexity-levels` ×2 — also auto-seeds on GET; `value` is TEXT-holding-JSON
- [ ] `roof-types` ×1 — ❌ **delete, don't port** (frontend never calls it; nothing seeds the table)

### Inline in `server.js` (2) — easy to miss
- [ ] `GET /api/dashboard` — aggregate `COUNT(*) FILTER (…)`, returns raw snake_case with **string** numerics
- [ ] `GET /api/pipeline`

---

## 5. Phases

| Phase | Scope | Notes |
|---|---|---|
| **0** | Ground truth + safety net | `pg_dump --schema-only`; Alembic `stamp head`; scaffold; **build the response-diffing harness first** |
| **1** | Auth | Everything depends on it. Preserve the `v >= 2` gate and the fresh-DB role reads |
| **2** | Simple CRUD | customers, jobs, quotes, settings, complexity-levels, organization, dashboard, pipeline |
| **3** | Core domain | projects + estimates — highest column count, highest diff value |
| **4** | Files | multer → `UploadFile`; add the explicit body-size limit |
| **5** | Billing + Stripe | Both branches; pin the API version; unify org creation |
| **6** | Materials | Rewrite the scoring search; port `importMaterials.js` with `openpyxl` |
| **7** | Cutover | uvicorn on existing `certs/` at port 3001; stop Express |

**Effort: days, not hours.** Phases 1, 3, 5, 6 carry nearly all the risk. Genuinely easy: `db.js` (3 lines), webhook raw-body, HTTPS, multer→`UploadFile`, and all of `settings`/`organization`/`quotes`/`auth`.

### Frontend changes needed: two lines
`src/api.js:4` and `src/LoginPage.jsx:3` both hardcode `:3001/api`. (`LoginPage` bypasses `api.js` with a direct `fetch` — don't miss it.) If FastAPI serves the same paths on 3001, even these stay unchanged.

### Not porting
- `scripts/importMaterials.js` → Python CLI (`openpyxl`, read-only mode for the 12 MB file). Its `classifyProductGroup` duplicates SQL in migration 13 — keep in sync.
- `roofTypes.js` → delete.

### Env vars to carry over
`DATABASE_URL`, `PORT`, `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `APP_URL`.
⚠️ `backend/env.example` is stale — omits `JWT_SECRET` and every Stripe var.

---

## 6. Auth specification (for exact reproduction)

**JWT** — HS256, secret `JWT_SECRET`, expiry **7 days**. Claims:

```json
{ "id": 1, "name": "…", "email": "…",
  "organizationId": 1, "role": "owner|admin|member",
  "isPlatformAdmin": false, "v": 2, "iat": …, "exp": … }
```

Header: `Authorization: Bearer <token>` — exact prefix, one space.

**Rejections (all 401, body `{"error": "…"}`):**
| Condition | Message |
|---|---|
| Missing / malformed header | `Unauthorised` (British spelling) |
| Verify fails (bad sig, expired) | `Invalid or expired token` |
| `!organizationId` or `v < 2` | `Session out of date, please log in again` |

**bcrypt** — cost **10** at every call site, `$2b$` prefix. Truncate to 72 bytes explicitly to match node's silent truncation.

**Roles** — `owner` and `admin` are **equivalent everywhere**; no check requires `owner` specifically. `is_platform_admin` is an orthogonal boolean column.

---

## 7. Verification

1. **Contract diffing (primary gate).** Every endpoint, same token, deep-diff both backends — keys, casing, types (string-vs-number decimals), null-vs-absent. Nothing is "done" until it diffs clean.
2. **JSONB round-trip.** Save a project with sections/accessories via FastAPI, read it back **through Express** — proves no double-encoding.
3. **Auth cross-compat.** Express token works on FastAPI; FastAPI token works on Express; a real existing password logs in.
4. **Tenancy.** With two orgs, every endpoint 404s (not 403s) on the other org's ids; `organization_id` in a request body is ignored.
5. **Roles.** A `member` is refused user-management and billing writes; a demoted admin loses access *immediately without re-logging-in* (proves the fresh-DB read survived).
6. **Files.** Upload via FastAPI, confirm filename pattern + URL resolution; confirm previously-uploaded files still serve.
7. **Stripe.** Replay `checkout.session.completed` via the Stripe CLI → org + owner + materials-template clone. Confirm `invoice.payment_failed` actually sets `past_due` on the pinned API version. Confirm bypass mode still works with keys absent.
8. **End-to-end.** Run the React app against FastAPI: login → trace a roof → save geometry → produce a quote → view it.

---

## 8. Cutover / rollback runbook

**Cutover**
1. Full diff suite green across all 64 endpoints.
2. Stop Express.
3. Start uvicorn on port **3001** with the existing certs:
   `uvicorn app.main:app --port 3001 --ssl-keyfile ../certs/key.pem --ssl-certfile ../certs/cert.pem`
4. Smoke-test the end-to-end journey (§7.8).

**Rollback** — stop uvicorn, restart Express on 3001. No data changes are involved, so rollback is instant and lossless at any point.

> `certs/san.cnf` pins LAN IPs for phone testing over HTTPS — keep that working, the React Native app will need it.
