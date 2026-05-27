# RoofSnap 🏠

**Photo → Estimate → Quote → CRM** for NZ roofing contractors.

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

## Deploy to Vercel (1 minute)

```bash
npm install -g vercel
vercel
```

Or connect your GitHub repo at [vercel.com](https://vercel.com) for auto-deploys on every push.

## Stack

- React 18 + Vite
- Recharts (pipeline chart)
- Persistent in-browser storage (window.storage / localStorage)
- Zero backend dependencies for the MVP

## Features

- 📸 Photo upload + canvas roof measurement tool
- 📊 Live estimate engine (material, labour, GST)
- 💰 Professional quote generator (print / PDF)
- ▦ Kanban pipeline (New Lead → Won)
- 👤 Customer CRM with full CRUD
- 💾 Data persists across sessions

## Roadmap

- [ ] Supabase backend (auth, DB, photo storage)
- [ ] AI roof detection (Claude Vision API)
- [ ] PDF export via react-pdf
- [ ] Email quotes via Resend
- [ ] Stripe subscription billing
- [ ] Mobile PWA
