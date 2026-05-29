# AtoProof — Roofing CRM & Estimating Tool 🏠

A full-stack web app for roofing contractors — manage customers, measure roofs, generate estimates, and track your sales pipeline.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite |
| Charts | Recharts |
| Backend | Node.js + Express |
| Database | PostgreSQL |
| Auth | JWT + bcrypt |

---

## Project Structure

```
curves-work/
├── src/                   # React frontend
│   ├── App.jsx
│   ├── LoginPage.jsx
│   ├── AuthContext.jsx
│   ├── CurrencyContext.jsx
│   └── api.js
├── public/                # Static assets
├── backend/               # Express API server
│   ├── server.js
│   ├── db.js
│   ├── .env               # Your local env (not committed)
│   ├── env.example        # Copy this to .env
│   └── routes/
│       ├── auth.js
│       ├── users.js
│       ├── customers.js
│       ├── projects.js
│       ├── estimates.js
│       ├── settings.js
│       ├── roofTypes.js
│       └── seed.js
├── database/
│   └── schema.sql         # Base schema
├── migrations/
│   └── 02_add_currency_support.sql   # Adds currencies, app_settings, roof_types + user currency columns
├── package.json           # Frontend dependencies
└── vite.config.js
```

---

## Prerequisites

- **Node.js** v18+ (includes npm)
- **PostgreSQL** running locally (or a hosted instance like Supabase / Railway)

---

## Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/YOUR_USERNAME/curves-work.git
cd curves-work
```

Install frontend dependencies:

```bash
npm install
```

Install backend dependencies:

```bash
cd backend
npm install
cd ..
```

> This installs `bcrypt`, `jsonwebtoken`, `express`, `pg`, `cors`, and `dotenv`.

---

### 2. Set up the database

Create a PostgreSQL database, then restore from the provided backup file:

```bash
pg_restore -U your_user -d your_db_name atoproff.backup
```

> This restores all tables, indexes, triggers, and seed data in one step — no need to run `schema.sql` or migrations manually.

---

### 3. Configure environment variables

Copy the example file inside the `backend/` folder:

```bash
cp backend/env.example backend/.env
```

Edit `backend/.env` with your actual values:

```env
# PostgreSQL connection string
DATABASE_URL=postgresql://YOUR_USER:YOUR_PASSWORD@localhost:5432/YOUR_DB_NAME

# Backend port
PORT=3001

# Secret key for signing JWT tokens — use a long random string in production
JWT_SECRET=your_secret_key_here
```

Also create a `.env` file in the **project root** (next to `package.json`) for Vite:

```env
VITE_API_URL=http://localhost:3001/api
```

> Vite only reads env vars from the root `.env`. The `VITE_` prefix is required.

---

### 4. Create your first user account

Before you can log in, register an account by sending one POST request (do this once):

```bash
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Your Name","email":"you@example.com","password":"yourpassword"}'
```

Or use Postman / Thunder Client:
- **URL:** `POST http://localhost:3001/api/auth/register`
- **Body (JSON):** `{ "name": "Your Name", "email": "you@example.com", "password": "yourpassword" }`

---

## Running the App

You need **two terminals open at the same time**.

### Terminal 1 — Backend

```bash
cd backend
npm run dev
```

API runs at `http://localhost:3001`.

### Terminal 2 — Frontend

```bash
# From the project root
npm run dev
```

App runs at `http://localhost:5173`.

---

## Features

- 🔐 **Auth** — Login/logout with JWT; accounts can be enabled or disabled by an admin
- 👤 **Customer CRM** — Add, edit, and manage roofing customers
- 📋 **Projects** — Kanban pipeline: New Lead → Estimating → Quote Sent → Won / Lost
- 📐 **Roof Measurement Tool** — Canvas tool to draw roof sections and calculate area
- 💰 **Estimate Engine** — Auto-calculates materials, labour, margin, GST, and total
- 🖨️ **Quote Generator** — Professional printable / PDF-ready quote
- 📊 **Dashboard** — Revenue, pipeline value, and lead stats with Recharts charts
- 🏠 **Roof Types** — Admin-managed list of roof materials with rate per m²
- 💱 **Multi-Currency** — Users can set a preferred currency; supported currencies stored in DB
- ⚙️ **App Settings** — Key/value settings table for configurable app behaviour
- 👥 **User Management** — Admin can create, enable, and disable team accounts

---

## Database Schema

The full live schema (from `atoproff.backup`) contains these tables:

### `users`
```sql
CREATE TABLE public.users (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(100) NOT NULL,
    email               VARCHAR(150) NOT NULL UNIQUE,
    password_hash       TEXT,
    is_active           BOOLEAN DEFAULT TRUE NOT NULL,
    currency            VARCHAR(3) DEFAULT 'NZD',
    preferred_currency  VARCHAR(3) DEFAULT 'NZD' REFERENCES currencies(code),
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ
);
```

### `currencies` *(added in migration 02)*
```sql
CREATE TABLE public.currencies (
    code    VARCHAR(3)  PRIMARY KEY,   -- e.g. 'NZD', 'USD'
    symbol  VARCHAR(10) NOT NULL,      -- e.g. '$'
    name    VARCHAR(100) NOT NULL,     -- e.g. 'New Zealand Dollar'
    locale  VARCHAR(10) DEFAULT 'en-US'
);
```

### `app_settings` *(added in migration 02)*
```sql
CREATE TABLE public.app_settings (
    key     VARCHAR(100) PRIMARY KEY,
    value   TEXT NOT NULL
);
```

### `roof_types` *(added in migration 02)*
```sql
CREATE TABLE public.roof_types (
    id            SERIAL PRIMARY KEY,
    label         VARCHAR(100) NOT NULL,
    rate_per_sqm  NUMERIC(10,2) NOT NULL,
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### `customers`
```sql
CREATE TABLE public.customers (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(120) NOT NULL,
    email       VARCHAR(180),
    phone       VARCHAR(40),
    address     TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### `projects`
```sql
CREATE TABLE public.projects (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    address      TEXT,
    status       project_status DEFAULT 'New Lead',  -- ENUM
    area         NUMERIC(10,2) DEFAULT 0,
    roof_type    VARCHAR(60),
    notes        TEXT,
    quote_num    VARCHAR(20),
    quote_date   DATE,
    created_at   DATE DEFAULT CURRENT_DATE,
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
```

### `estimates`
```sql
CREATE TABLE public.estimates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    area            NUMERIC(10,2) DEFAULT 0,
    pitch           NUMERIC(6,3)  DEFAULT 1.15,
    waste           NUMERIC(5,1)  DEFAULT 10,
    material_rate   NUMERIC(8,2)  DEFAULT 55,
    material_label  VARCHAR(60)   DEFAULT 'Long Run Steel',
    flashings       NUMERIC(8,2)  DEFAULT 0,
    guttering       NUMERIC(8,2)  DEFAULT 0,
    day_rate        NUMERIC(8,2)  DEFAULT 850,
    days            NUMERIC(4,1)  DEFAULT 2,
    margin          NUMERIC(5,1)  DEFAULT 20,
    -- computed/stored totals:
    adj_area    NUMERIC(10,2), mat_cost   NUMERIC(10,2),
    flash_cost  NUMERIC(10,2), gut_cost   NUMERIC(10,2),
    lab_cost    NUMERIC(10,2), margin_amt NUMERIC(10,2),
    sell_price  NUMERIC(10,2), gst        NUMERIC(10,2),
    total       NUMERIC(10,2),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### `project_geometries`
```sql
CREATE TABLE public.project_geometries (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id          UUID UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sections            JSONB DEFAULT '[]',
    accessories         JSONB DEFAULT '{}',
    asbestos            BOOLEAN DEFAULT FALSE,
    scale_m_per_px      NUMERIC(12,8) DEFAULT 0.05,
    total_footprint_m2  NUMERIC(10,2) DEFAULT 0,
    total_surface_m2    NUMERIC(10,2) DEFAULT 0,
    total_flashing_m    NUMERIC(8,2)  DEFAULT 0,
    total_gutter_m      NUMERIC(8,2)  DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);
```

---

## API Endpoints (Reference)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | ❌ | Login — returns JWT token |
| POST | `/api/auth/register` | ❌ | Create a new user account |
| GET | `/api/customers` | ✅ | List all customers |
| GET | `/api/projects` | ✅ | List all projects |
| GET | `/api/estimates` | ✅ | List all estimates |
| GET | `/api/dashboard` | ✅ | Dashboard stats |
| GET | `/api/pipeline` | ✅ | Full pipeline with customer names |
| GET | `/api/users` | ✅ | List users |
| GET | `/api/roof-types` | ✅ | List roof types |
| GET | `/api/settings` | ✅ | App settings |

All ✅ routes require `Authorization: Bearer <token>` in the request header.

---

## Common Issues

**`bcrypt` install fails on Windows or ARM**
> Try: `npm install bcrypt --build-from-source`
> Or swap to the pure-JS drop-in: `npm install bcryptjs` and update the `require` in `routes/auth.js` and `routes/users.js`.

**`Cannot connect to database`**
> Check your `DATABASE_URL` in `backend/.env`. Make sure PostgreSQL is running and the database exists.

**Schema errors on startup / missing table**
> Make sure you ran both files in order — `schema.sql` first, then `migrations/02_add_currency_support.sql`. The `currencies`, `app_settings`, and `roof_types` tables only exist after the migration.

**Frontend shows API errors**
> Make sure the backend is running on port 3001 and `VITE_API_URL` is set in the root `.env` (not `backend/.env`).

**JWT "Unauthorised" errors**
> Make sure `JWT_SECRET` is set in `backend/.env`. Tokens are signed with that secret — if it changes, old tokens become invalid.

---

## Contributing

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Commit: `git commit -m "add: your feature"`
3. Push and open a Pull Request

---

## License

MIT
