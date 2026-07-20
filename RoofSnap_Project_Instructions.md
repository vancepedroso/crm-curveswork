# RoofApp Project Instructions

> **Important**
>
> - Do **NOT** position this as a generic CRM.
> - Write **production-quality code**.
> - Follow **best practices**.
> - Keep the codebase **modular, scalable, and maintainable**.

You are an expert SaaS product engineer, UX designer, and full-stack architect.

Create a modern web application called **RoofSnap**.

---

# Core Idea

RoofSnap is **NOT** a traditional CRM.

It is a **Photo → Estimate → Quote → CRM** platform built specifically for roofing contractors.

---

# Main Value Proposition

> **"Get a roof quote in 3 minutes from a photo."**

---

# Target Users

- Roofing contractors
- Small to medium roofing companies
- Primary market: **New Zealand**
- Primary market: **Australia**
- Secondary market: Global roofing contractors

---

# Goal

Build an MVP (Minimum Viable Product) that allows contractors to:

1. Upload roof photos
2. Estimate roof dimensions
3. Generate roofing quotes
4. Save customer/project data
5. Manage leads and projects

---

# Product Principles

- Speed
- Simplicity
- Mobile-first experience
- Fast performance
- Easy for non-technical contractors

---

# Tech Stack (as built)

## Frontend

- React 18 (Vite)
- Plain CSS-in-JS style objects (no Tailwind yet — see *Deviations* below)
- Recharts for dashboard charts
- jsPDF + html2canvas for quote PDF export
- Responsive layout (mobile drawer nav, collapsing grids)

## Backend

- Node.js + Express (not Supabase — see *Deviations* below)
- PostgreSQL via `pg`
- Plain SQL migrations in `migrations/` (numbered, hand-written, re-runnable via a small Node script — no ORM/migration framework)

## Authentication

- Email/password login
- Token-based session stored in `localStorage`, sent as `Authorization: Bearer`
- Admin-managed user accounts (see **Users** module below) rather than self-serve signup — matches a single-company deployment, not multi-tenant SaaS onboarding yet

## Storage

- Roof/job photos stored on local disk (`backend/uploads/`), served statically by Express
- Not yet on cloud object storage (S3/Supabase Storage) — flagged as a pre-launch task

## Deployment

- Currently runs as local dev servers (Vite + Express) with a shared self-signed HTTPS certificate (`certs/`) so it can be reached securely from other devices (phones/tablets) on the same LAN — needed for camera access, which browsers only allow on secure origins
- Not yet deployed to Replit/hosted infrastructure

### Deviations from the original spec (flag for review)
- **Tailwind** was specced but the app was actually built with inline style objects (`src/App.jsx`'s `s` constant). Revisit if a design-system rework is prioritized.
- **Supabase** was specced as an option but the app uses a self-managed Express + PostgreSQL backend instead, with its own auth/session handling rather than Supabase Auth/Storage.
- **Multi-tenant SaaS signup** isn't built — today it's a single company with an internally managed user list (Users module), not a public onboarding flow.

---

# Main Features

## 1. Dashboard — ✅ Implemented

- Stats cards: Total Leads, Quotes Sent, Projects Won, Pending Quotes
- Pipeline-by-stage bar chart
- Recent projects panel
- Mobile responsive

## 2. Photo Upload System — ✅ Implemented (now job-scoped)

- Drag-and-drop + click-to-browse upload, image preview, lightbox
- Photos live in a **Job's photo library** (see **Jobs module** below) rather than being uploaded ad hoc per project — this is a deliberate evolution beyond the original spec: photos are captured once against a Job and then reused/selected when creating a Project, instead of re-uploading per quote
- Projects created without a linked Job still get a standalone project-level photo uploader as a fallback

## 3. Jobs Module — ✅ Implemented (new — not in original spec)

A layer between Customers and Projects that wasn't in the original design:

- Each Customer can have one or more **Jobs**, identified by a contractor-entered **Job Number**
- Each Job has its own **photo library** (upload/browse/delete), independent of any specific quote/project
- When starting a **New Project**, the wizard lets you pick **Customer → Job**, then select photos from that job's library to use for measurement and to attach to the project
- A photo picked for measurement loads directly into the Roof Measurement Tool's canvas (same trace/measure flow as an uploaded file)
- Rationale: contractors often photograph a site before quoting is finalized, and the same site visit's photos get reused across multiple quote revisions — the Jobs module avoids re-uploading photos each time

## 4. Roof Measurement Tool (MVP) — ✅ Implemented, extended beyond spec

> AI roof detection is still **not** used — this remains manual/assisted measurement, per the original constraint.

- Upload a roof photo (or select one from a Job's photo library)
- Draw roof outline (polygon sections), flashings, gutters, downpipes, drains, penetrations
- **Set Scale** tool: click two points over a feature of known real-world length, type that length in, and the tool computes m/px scale live — editable at any time (not frozen after drawing), so it stays accurate rather than defaulting to a placeholder value
- Zoom (wheel + buttons), pan (Space+drag, middle-mouse, or Pan tool)
- Editable points — drag any placed point (section corner, line point, marker) to reposition it via an "Edit Points" toggle
- Asbestos-risk flag on the geometry, surfaced for site-visit escalation
- **Live Camera measurement** — an additional capture method (open device camera, freeze a frame, trace on it) — only offered on phones/tablets (detected via user-agent + touch support), since laptop/desktop webcams aren't useful for this and the option is hidden there
- **AR Camera** — placeholder tab marked "Coming Soon" (not implemented), matches the original "Future Architecture" AR item

## 5. Estimate Engine — ✅ Implemented, extended with a real supplier price catalog

Inputs:

- Roofing material (see **Materials catalog** below)
- Labor rate, wastage %, roof pitch, accessories (flashings/guttering)

Outputs:

- Material quantities, labor cost, total project cost, sell price incl. margin & GST

### Materials Catalog (Supplier Price Database) — ✅ Implemented (new — not in original spec)

The original spec implied a flat rate table per material type. This was replaced with a real supplier price catalog:

- Imported from a supplier price spreadsheet (multiple supplier sheets: Dimond, Armorsteel, Metalcraft, Kingspan, Skylight, TPO, etc.) into a `roof_materials` table — ~6,800 real priced SKUs (roof sheets, flashings, fixings, skylights, accessories)
- Re-importable via a Node script (`backend/scripts/importMaterials.js`) whenever the source spreadsheet is updated
- **Material Type** picker in the Estimate step offers two ways to choose a material:
  1. Cascading **Supplier → Type → Material** dropdowns
  2. Keyword search (tokenized/per-word matching across description, SKU, supplier, type — since real trade terminology like "Colorsteel" or "Corrugate 0.40 Zincalume" doesn't match generic phrases like "Long Run Steel" as an exact substring)
- Selecting a material auto-fills its real `$/m²` supplier rate; a manual rate override and the original 5-item quick-pick list remain available as fallbacks
- 🔜 Not yet implemented: multi-material line items (e.g. main cladding + separate flashing SKU + separate fixings, each with its own qty/rate) — currently one material per estimate. Flagged as a near-term follow-up (a "+ Add Material" row pattern was discussed as the direction).

## 6. Quote Generator — ✅ Implemented

- Customer info, project summary, roof area, materials, labor, totals, company branding
- **PDF export** (jsPDF + html2canvas, paginated to A4) and printable view
- **Copy-to-clipboard rich HTML** quote + deep links to compose in Gmail/Outlook/Yahoo Mail as a lighter-weight alternative to a full email-sending backend
- Quote history persisted per project (numbered `QT-###` quotes, snapshotted on save)

## 7. Mini CRM — ✅ Implemented, extended

- **Leads / Customers / Projects** — as specced
- **Jobs** — new module, see above
- **Users** — admin-managed user accounts (create, edit, enable/disable) — not in the original spec's feature list but necessary for the auth model actually built
- **Currency selector** — user-level display currency preference (topbar selector), not in original spec
- Quote history, project status
- Statuses: New Lead, Estimating, Quote Sent, Won, Lost
- **Kanban-style pipeline** — drag-and-drop between status columns, implemented
- **Soft delete for Projects** — deleting a project sets an `is_deleted` flag rather than removing the row, so its estimates/quotes/geometry history are preserved and it can be restored at the database level if needed. Not in the original spec but a standard safety net for a system that stores financial quote history.

## 8. Project Details — ✅ Implemented, extended

- Customer info, roof photos, measurements, estimates, quotes, notes — as specced
- Photos shown here are **read-only**, pulled from the linked Job's photo library (uploading happens on the Jobs page against the shared library, not per-project) when the project has a linked job; falls back to a per-project uploader otherwise
- Delete action (soft delete, see above)

---

# Design Style

- Modern SaaS, clean, minimal, contractor-friendly
- Inspired by modern construction software, Stripe, Linear.app
- Rounded cards, soft shadows, spacious layouts, modern typography
- Amber/dark-navy accent palette in the implementation (`#f59e0b` on `#0f172a`)

---

# Product Strategy

Core workflow:

```text
📸 Photo → 📐 Estimate → 💰 Quote → 📋 CRM
```

Priorities:

1. Fast quote generation
2. Easy photo workflow
3. Mobile usability
4. Simple contractor experience

---

# Future Architecture

- AI roof detection — not started
- AR measuring — placeholder tab exists, not implemented
- Satellite integrations — not started
- Team collaboration — partially covered by the Users module (multi-user access), but no real-time collaboration features
- SMS/email automation — email is currently a manual "copy + open your email client" flow, not automated sending
- Subscription billing — not started
- Multi-company SaaS — not started; current auth/data model assumes a single company

---

# Output Requirements

1. Full project architecture
2. Database schema
3. Frontend component structure
4. Backend API structure
5. Folder structure
6. MVP roadmap
7. Recommended libraries
8. Core React components
9. UI/UX flow
10. ~~Suggested Supabase tables~~ → see `database/schema.sql` and `migrations/` for the actual PostgreSQL schema (customers, jobs, job_photos, projects, estimates, project_photos, project_geometries, quotes, users, roof_materials)
11. Estimation logic examples

---

# Implementation Order (actual)

1. Project setup — done
2. Dashboard — done
3. Authentication — done (token-based, admin-managed users)
4. Database schema — done, evolving (7 migrations applied so far: currency, photos/quotes, jobs/job_photos, project↔job link, roof_materials, projects soft-delete)
5. Photo upload module — done, evolved into the Jobs photo library model

---

# Development Standards

- Production-quality code
- Best practices
- Modular architecture
- Scalable design
- Performance optimized
- Future extensibility
