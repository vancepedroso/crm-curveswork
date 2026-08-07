import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, Fragment, forwardRef, useImperativeHandle } from "react"
import { createPortal } from "react-dom"
import { loadStripe } from "@stripe/stripe-js"
import { Elements, CardNumberElement, CardExpiryElement, CardCvcElement, useStripe, useElements } from "@stripe/react-stripe-js"
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts"
import { customersApi, projectsApi, usersApi, photosApi, quotesApi, jobsApi, jobPhotosApi, materialsApi, companyProfileApi, estimatesApi, complexityLevelsApi, organizationApi, billingApi, platformAdminApi, API_ORIGIN } from "./api"
import { useAuth } from "./AuthContext"
import LoginPage   from "./LoginPage"
import SignupPage  from "./SignupPage"
import { CurrencyProvider, useCurrency } from "./CurrencyContext"
import { TaxProvider, useTax } from "./TaxContext"
import jsPDF from "jspdf"
import html2canvas from "html2canvas"
import LiveCameraMeasurements from "./LiveCamera/LiveCameraMeasurement";


// ─────────────────────────── CONSTANTS ───────────────────────────
const STATUSES = ["New Lead","Estimating","Quote Sent","Won","Lost"]
const STATUS_STYLE = {
  "New Lead":   { bg:"#dbeafe", color:"#1e40af", dot:"#3b82f6" },
  "Estimating": { bg:"#ede9fe", color:"#5b21b6", dot:"#8b5cf6" },
  "Quote Sent": { bg:"#fef3c7", color:"#92400e", dot:"#f59e0b" },
  "Won":        { bg:"#d1fae5", color:"#065f46", dot:"#10b981" },
  "Lost":       { bg:"#fee2e2", color:"#991b1b", dot:"#ef4444" },
}
const MATERIALS = [
  { label:"Corrugated Iron",  rate:35  },
  { label:"Long Run Steel",   rate:55  },
  { label:"Metal Tiles",      rate:65  },
  { label:"Concrete Tiles",   rate:80  },
  { label:"Terracotta Tiles", rate:110 },
]
const PITCHES = [
  { label:"Flat ≤5°",         factor:1.0  },
  { label:"Low 5–15°",        factor:1.1  },
  { label:"Medium 15–30°",    factor:1.15 },
  { label:"Steep 30–45°",     factor:1.25 },
  { label:"Very Steep >45°",  factor:1.4  },
]

const RATES = { flashings: 28, guttering: 45, downpipe: 35, drain: 40, penetration: 65, underlayment: 8 }

// Given a traced downpipe run length and the stock lengths a supplier cuts
// downpipe in, picks whichever stock length needs the fewest pieces (ties
// broken by less waste) and returns how many pieces to buy.
function calculateDownpipe(lengthM, stockLengths) {
  const lengths = (stockLengths?.length ? stockLengths : [1.8, 2.4]).filter(n=>n>0)
  let best = null
  for (const stock of lengths) {
    const quantity = Math.ceil(lengthM / stock)
    const waste = quantity * stock - lengthM
    if (!best || quantity < best.quantity || (quantity === best.quantity && waste < best.waste)) {
      best = { preferredLength: stock, quantity, waste }
    }
  }
  return { inputLength: lengthM, preferredLength: best.preferredLength, quantity: best.quantity, waste: Number(best.waste.toFixed(2)) }
}
// Full cost of one downpipe item: stock pieces (rate × calculated quantity)
// plus bends/elbows and an optional spreader, each at their own flat rate —
// bendRate/spreaderRate are per-organization Settings values (with the
// organization's own defaults as the fallback here), not hardcoded constants.
function downpipeItemTotal(d, bendRate=15, spreaderRate=45) {
  return (d.rate||0)*(d.quantity||1) + (d.bends||0)*bendRate + (d.spreader?spreaderRate:0)
}
// ← Fallback only, for when no rate was resolved/threaded through (e.g. old
//   saved estimates predating gst_rate). The real, dynamic rate now comes
//   from the caller's organization's tax_country setting — see TaxContext
//   and calcEst's `e.gstRate` below — not this constant.
const GST_RATE = 0.15

const DEFAULT_SETTINGS = {
  companyName:"DK Roofing",
  companyAddress:"159 New Plymouth, New Zealand",
  companyEmail:"info@dkroofing.com",
  companyPhone:"021 555 1234",
  companyGst:"123-456-789",
  companyBank:"ANZ 01-2345-6789012-00",
  dayRate:850,
  margin:20,
  wastage:10,
  discountEnabled:false,
  discountType:"percent",
  discountValue:0,
  downpipeStockLengths:"1.8,2.4",
  downpipeBendRate:15,
  spreaderRate:45,
}

// ─────────────────────────── HELPERS ───────────────────────────
const uid   = () => Math.random().toString(36).slice(2,10)
// Module-level fmt is kept as a plain fallback (used in seed data only).
// All UI components override it via useCurrency().formatMoney.
const fmt   = n => "$"+Math.round(n).toLocaleString()
const fmtD  = d => {
  if(!d) return "—"
  const str = String(d)
  const iso = str.includes("T") ? str : str.slice(0,10)+"T12:00:00"
  return new Date(iso).toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"})
}
const today = () => new Date().toISOString().slice(0,10)

const toCamel = str => str.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const normalizeKeys = obj => {
  if(!obj || typeof obj !== "object" || Array.isArray(obj)) return obj
  return Object.fromEntries(Object.entries(obj).map(([k,v]) => [toCamel(k), v]))
}
const normalizeProject = raw => {
  if(!raw) return null
  const p = normalizeKeys(raw)
  if(p.estimate) p.estimate = normalizeKeys(p.estimate)
  return p
}

// Labour-cost multiplier by job complexity (Low/Medium/High/Complex/Very
// Complex) — access, roof shape/cutting, and safety requirements all drive
// labour time up independent of raw m². Used to be hardcoded here; now a
// global, editable list (Job Complexity settings page) fetched at runtime
// — EstimateEngine resolves the current factor for e.complexity and passes
// it in as e.complexityFactor, so calcEst itself stays a pure function with
// no dependency on the fetched list.

function calcEst(e) {
  if(!e) return null
  // Wastage % also covers the lap/overlap allowance every flashing and
  // gutter join needs — traced/entered lengths are the raw run, not what
  // gets ordered.
  const wasteFactor = 1 + (e.waste||0)/100
  // ← Each traced roof section can carry its own brand/rate (assigned right
  //   after tracing it, adjustable here) — sums replace the old single
  //   global area×rate. Falls back to the flat area/pitch/rate fields when
  //   there are no sections (manual entry / estimates predating this).
  const sectionList = e.sections?.length ? e.sections : null
  const adjArea   = sectionList
    ? sectionList.reduce((a,s)=>a+(s.surface_m2||0),0) * wasteFactor
    : e.area * e.pitch * wasteFactor
  const matCost   = sectionList
    ? sectionList.reduce((a,s)=>a+(s.surface_m2||0)*wasteFactor*(s.rate||0),0)
    : adjArea * e.materialRate
  // ← Named flashing runs (ridge cap, valley, etc.), each with its own
  //   traced length + supplier rate, replace the old single flat-rate
  //   flashings number. Falls back to the flat rate when there are no
  //   runs (old saved estimates / seed data predating this feature).
  const flashCost = (e.flashingRuns?.length ? e.flashingRuns : null)
    ?.reduce((a,r)=>a+flashingQtyM(r)*wasteFactor*(r.rate||0),0)
    ?? (e.flashings||0) * wasteFactor * RATES.flashings
  // ← Same pattern as sections/flashing runs: each traced gutter run,
  //   downpipe, drain, and penetration can carry its own picked brand/rate
  //   (assigned right after tracing it) — sums replace the old flat
  //   count/length × one global rate. Falls back to the flat fields when
  //   there's nothing traced (manual entry / estimates predating this).
  const gutCost = (e.gutterRuns?.length ? e.gutterRuns : null)
    ?.reduce((a,g)=>a+(g.length_m||0)*wasteFactor*(g.rate||0),0)
    ?? (e.guttering||0) * wasteFactor * RATES.guttering
  const downpipeCost = (e.downpipeItems?.length ? e.downpipeItems : null)
    ?.reduce((a,d)=>a+downpipeItemTotal(d, e.downpipeBendRate, e.spreaderRate),0)
    ?? (e.downpipes||0) * RATES.downpipe
  const drainCost = (e.drainItems?.length ? e.drainItems : null)
    ?.reduce((a,d)=>a+(d.rate||0),0)
    ?? (e.drains||0) * RATES.drain
  const penetrationCost = (e.penetrationItems?.length ? e.penetrationItems : null)
    ?.reduce((a,p)=>a+(p.rate||0),0)
    ?? (e.penetrations||0) * RATES.penetration
  const labCost   = (e.dayRate||850) * (e.days||0) * (e.complexityFactor||1)
  const sub       = matCost + flashCost + gutCost + downpipeCost + drainCost + penetrationCost + labCost
  const marginAmt = sub * ((e.margin||0)/100)
  const preDiscountSell = sub + marginAmt
  // ← General Customer Discount — a promo-style discount off the marked-up
  //   price (not a cost adjustment), applied before GST so tax is only
  //   charged on what the customer actually pays. Math.max guards a fixed
  //   discount larger than the price.
  const discountAmt = e.discountEnabled
    ? (e.discountType==="fixed" ? (e.discountValue||0) : preDiscountSell * ((e.discountValue||0)/100))
    : 0
  const sellPrice = Math.max(0, preDiscountSell - discountAmt)
  const gstRate   = e.gstRate ?? GST_RATE
  const gst       = sellPrice * gstRate
  const total     = sellPrice + gst
  return { ...e, adjArea, matCost, flashCost, gutCost, downpipeCost, drainCost, penetrationCost, labCost, marginAmt, preDiscountSell, discountAmt, sellPrice, gst, gstRate, total }
}

// ← Every quote line's materialLabel is built by MaterialPicker.pick() as
//   "{supplier} — {description}" — this pulls just the supplier/brand part
//   back out, so it can be shown once as a group heading instead of
//   repeating on every line that happens to use the same product.
function extractBrand(materialLabel) {
  if (!materialLabel) return null
  const idx = materialLabel.indexOf(" — ")
  return idx > 0 ? materialLabel.slice(0, idx) : null
}
// ← Display-only post-process on an already-built flat quote line list:
//   when 2+ lines share the same brand, insert one header row for it and
//   strip "{brand} — " out of each of those lines' own desc (wherever it
//   appears — at the start for roof sections, after a label prefix like
//   "Ridge Cap — " for flashing/gutter/accessory lines). A brand used by
//   only one line is untouched — full description, no heading, exactly as
//   before — this only kicks in where the repetition actually exists.
function groupQuoteLinesByBrand(lines) {
  const counts = {}
  lines.forEach(l => { if (l.brand) counts[l.brand] = (counts[l.brand]||0) + 1 })
  const seen = new Set()
  const out = []
  lines.forEach(l => {
    if (l.brand && counts[l.brand] >= 2) {
      if (!seen.has(l.brand)) { seen.add(l.brand); out.push({ isBrandHeader: true, brand: l.brand }) }
      out.push({ ...l, desc: l.desc.replace(`${l.brand} — `, ""), indented: true })
    } else {
      out.push(l)
    }
  })
  return out
}

function nextQuoteNum(projects) {
  const nums = projects.filter(p=>p.quoteNum).map(p=>parseInt(p.quoteNum.replace("QT-","")||"0"))
  return "QT-"+String((nums.length ? Math.max(...nums) : 40)+1).padStart(3,"0")
}

// ─────────────────────────── UI PRIMITIVES ───────────────────────────
const s = {
  app:    { display:"flex", height:"100vh", fontFamily:"'DM Sans', sans-serif", fontSize:14, color:"#0f172a", background:"#f8fafc", overflow:"hidden" },
  main:   { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
  content:{ flex:1, overflowY:"auto", padding:24 },
  sidebar:{ width:220, minWidth:220, background:"#0f172a", display:"flex", flexDirection:"column", height:"100%" },
  logo:   { padding:"20px 20px 16px", borderBottom:"1px solid rgba(255,255,255,0.08)" },
  nav:    { flex:1, padding:"12px 10px", display:"flex", flexDirection:"column", gap:2, overflowY:"auto" },
  navSec: { fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:1, padding:"10px 10px 4px" },
  navItem:{ display:"flex", alignItems:"center", gap:10, padding:"9px 10px", borderRadius:8, cursor:"pointer", color:"#94a3b8", fontSize:13, fontWeight:500, transition:"all .15s", userSelect:"none" },
  topbar: { padding:"14px 24px", borderBottom:"1px solid #e2e8f0", display:"flex", alignItems:"center", justifyContent:"space-between", background:"#fff", flexShrink:0 },
  card:   { background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:18 },
  grid4:  { display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14, marginBottom:24 },
  grid2:  { display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 },
  grid2r: { display:"grid", gridTemplateColumns:"1fr 340px", gap:16 },
  label:  { display:"block", fontSize:12, color:"#64748b", marginBottom:5, fontWeight:500 },
  input:  { width:"100%", padding:"8px 12px", border:"1px solid #e2e8f0", borderRadius:8, fontSize:13, fontFamily:"inherit", color:"#0f172a", outline:"none", boxSizing:"border-box" },
  th:     { textAlign:"left", padding:"10px 14px", fontSize:11, fontWeight:600, textTransform:"uppercase", letterSpacing:.5, color:"#64748b", borderBottom:"1px solid #e2e8f0", background:"#f8fafc" },
  td:     { padding:"12px 14px", borderBottom:"1px solid #f1f5f9", fontSize:13 },
}

function Btn({ children, primary, danger, sm, full, onClick, style={} }) {
  const base = `inline-flex items-center gap-1.5 ${sm?"px-3 py-1.5 text-xs":"px-4 py-2 text-[13px]"} rounded-lg font-medium cursor-pointer border transition-colors font-sans ${full?"w-full justify-center":""}`
  if(primary) return <button style={style} className={`${base} bg-accent hover:bg-accent-dark text-slate-900 border-accent`} onClick={onClick}>{children}</button>
  if(danger)  return <button style={style} className={`${base} bg-red-50 hover:bg-red-100 text-red-700 border-red-200`} onClick={onClick}>{children}</button>
  return <button style={style} className={`${base} bg-transparent hover:bg-slate-50 text-slate-500 border-slate-200`} onClick={onClick}>{children}</button>
}

function StatusBadge({ status }) {
  const st = STATUS_STYLE[status]||STATUS_STYLE["New Lead"]
  return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold" style={{background:st.bg,color:st.color}}>
    <span className="w-1.5 h-1.5 rounded-full" style={{background:st.dot}}/>
    {status}
  </span>
}

// ─── Responsive Modal: full-screen on mobile, large centered panel on
//     tablet/desktop, internal scroll. ───────────
function Modal({ title, onClose, children, width=560, height }) {
  return (
    <div
      className="fixed inset-0 bg-slate-900/50 flex items-start justify-center z-[1000] overflow-y-auto"
      onClick={e=>e.target===e.currentTarget&&onClose()}
    >
      <div
        className="responsive-modal bg-white w-full flex flex-col shadow-2xl"
        style={{ maxWidth:width, maxHeight: height ? height : "90vh" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
          <span className="font-bold text-base font-display">{title}</span>
          <button onClick={onClose} className="border-none bg-transparent cursor-pointer text-2xl text-slate-500 leading-none p-1 hover:text-slate-800">×</button>
        </div>
        <div className="responsive-modal-body p-5 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  )
}

function Toast({ msg, onDone }) {
  useEffect(()=>{ const t = setTimeout(onDone, 3000); return ()=>clearTimeout(t) },[onDone])
  return <div className="fixed bottom-6 right-6 bg-navy text-white px-5 py-3 rounded-xl text-[13px] font-medium z-[9999] flex items-center gap-2 shadow-lg">
    <span className="text-emerald-400 text-base">✓</span> {msg}
  </div>
}

// ─── Billing status banner — past-due payment or seat limit reached.
//     Rendered under the topbar, visible across every view when relevant.
function BillingBanner({ user }) {
  const [org, setOrg] = useState(null)
  const [redirecting, setRedirecting] = useState(false)

  useEffect(()=>{
    organizationApi.get().then(setOrg).catch(()=>{})
  },[])

  if (!org) return null
  const atSeatLimit = org.activeUserCount >= org.seatLimit
  const pastDue = org.status === "past_due"
  if (!pastDue && !atSeatLimit) return null

  async function openBillingPortal() {
    setRedirecting(true)
    try {
      const { url } = await billingApi.getPortalUrl()
      window.location.href = url
    } catch (err) {
      alert(err.message || "Couldn't open billing portal")
      setRedirecting(false)
    }
  }

  return (
    <div style={{
      display:"flex", alignItems:"center", justifyContent:"space-between", gap:12,
      padding:"9px 20px", fontSize:12.5, fontWeight:500,
      background: pastDue ? "#fee2e2" : "#fffbeb",
      color: pastDue ? "#991b1b" : "#92400e",
      borderBottom: `1px solid ${pastDue ? "#fca5a5" : "#fde68a"}`,
    }}>
      <span>
        {pastDue
          ? "⚠️ There's a problem with your last payment — update your billing details to avoid losing access."
          : `⚠️ Seat limit reached (${org.activeUserCount}/${org.seatLimit}) — upgrade your plan to add more people.`}
      </span>
      {(org.myRole === "owner" || org.myRole === "admin") && (
        <button onClick={openBillingPortal} disabled={redirecting}
          style={{padding:"5px 12px",borderRadius:6,border:"1px solid currentColor",background:"transparent",color:"inherit",fontSize:12,fontWeight:600,cursor:redirecting?"not-allowed":"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
          {redirecting ? "Opening…" : "Manage Billing"}
        </button>
      )}
    </div>
  )
}

// ─── Big money display: a single formal sans-serif weight for the whole
//     amount (no display/heading font on numerals — that's what read as
//     playful/"AI-generated" rather than an invoice), tabular figures so
//     digits don't jitter, symbol at the same baseline as the digits
//     instead of superscript-style. ─────────────────────────────────────
function Money({ value, size=24, weight=700, color="inherit" }) {
  return (
    <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:size,fontWeight:weight,color,fontVariantNumeric:"tabular-nums",letterSpacing:"-0.01em"}}>
      {value}
    </span>
  )
}

function FG({ label, children, half, error }) {
  return <div className={`mb-3.5 ${half?"col-span-1":""}`}>
    <label className="block text-xs text-slate-500 mb-1.5 font-medium">{label}</label>
    {children}
    {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
  </div>
}

// ─────────────────────────── SIDEBAR ───────────────────────────
function Sidebar({ view, onNav, projects, user, onLogout }) {
  const pending = projects.filter(p=>p.status==="Quote Sent").length

  const items = [
    { key:"dashboard",  label:"Dashboard",   icon:"⬛" },
    { key:"new",        label:"New Project", icon:"📸", primary:true },
    null,
    { key:"pipeline",   label:"Pipeline",    icon:"▦", badge:pending||null },
    { key:"projects",   label:"Projects",    icon:"📁" },
    { key:"customers",  label:"Customers",   icon:"👤" },
    { key:"jobs",       label:"Jobs",        icon:"🧰" },
    null,
    { key:"users",      label:"Users",       icon:"🔑" },
    { key:"settings",   label:"Settings",    icon:"⚙" },
  ]

  return (
    <div className="w-[220px] min-w-[220px] bg-navy flex flex-col h-full">
      <div className="px-5 pt-5 pb-4 border-b border-white/10">
        <img src="/aTopRoof.png" alt="aTopRoof" className="w-full max-w-[164px] block bg-white rounded-[10px] px-3 py-2 shadow-md"/>
        <div className="text-[10px] text-accent tracking-widest uppercase mt-2 font-semibold">Elevate Your Roofing Business</div>
      </div>
      <nav className="flex-1 px-2.5 py-3 flex flex-col gap-0.5 overflow-y-auto">
        {items.map((item,i)=> item===null
          ? <div key={i} className="h-px bg-white/[.06] my-2"/>
          : (
            <div key={item.key}
              onClick={()=>onNav(item.key)}
              className={`flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg cursor-pointer text-slate-300 text-[13px] font-medium transition-colors select-none hover:bg-white/5
                ${view===item.key ? "!bg-accent/15 !text-accent" : ""}
                ${item.primary ? "mt-1 bg-accent/10 text-accent border border-accent/20" : ""}`}
            >
              <span className="text-sm">{item.icon}</span>
              <span>{item.label}</span>
              {item.badge && <span className="ml-auto bg-accent text-slate-900 text-[10px] font-bold px-1.5 py-px rounded-full">{item.badge}</span>}
            </div>
          )
        )}
      </nav>
      <div className="flex items-center justify-between gap-2 mt-3 mx-2 mb-2 px-2.5 py-2 rounded-lg bg-white/[.04]">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-accent to-orange-500 flex items-center justify-center text-[11px] font-bold text-slate-900 shrink-0">
            {user?.name?.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-xs text-white font-medium whitespace-nowrap overflow-hidden text-ellipsis">{user?.name}</div>
            <div className="text-[10px] text-slate-500">aTopRoof CRM</div>
          </div>
        </div>
        <button onClick={onLogout} title="Sign out" className="bg-transparent border-none cursor-pointer text-slate-500 hover:text-slate-300 text-base p-1 leading-none shrink-0">⏻</button>
      </div>
    </div>
  )
}

// ─────────────────────────── DASHBOARD ───────────────────────────
function Dashboard({ projects, customers, setView, setSelectedProject, onNewProject }) {
  const { formatMoney: fmt } = useCurrency()   // ← currency-aware fmt

  const stats = useMemo(()=>{
    const won      = projects.filter(p=>p.status==="Won")
    const sent     = projects.filter(p=>p.status==="Quote Sent")
    const leads    = projects.filter(p=>p.status==="New Lead")
    const pending  = projects.filter(p=>p.status==="Estimating" || p.status==="Quote Sent")
    const revenue  = won.reduce((a,p)=>a+(p.estimate?.total||0),0)
    const pipeline = sent.reduce((a,p)=>a+(p.estimate?.total||0),0)
    const pendingValue = pending.reduce((a,p)=>a+(p.estimate?.total||0),0)
    return { leads:leads.length, sent:sent.length, won:won.length, pending:pending.length, pendingValue, revenue, pipeline, total:projects.length }
  },[projects])

  const chartData = STATUSES.map(st=>({
    name: st.replace(" ",""),
    count: projects.filter(p=>p.status===st).length,
    color: STATUS_STYLE[st].dot,
  }))

  const recent = [...projects].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,5)
  const openProject = p => { setSelectedProject(p); setView("project") }

  return (
    <div>
      <div className="grid grid-cols-4 gap-3.5 mb-6 grid4-responsive">
        {[
          { label:"Total Leads",    val:stats.leads,        sub:`${stats.total} total projects`,                                             bg:"#dbeafe", color:"#1e40af" },
          { label:"Quotes Sent",    val:stats.sent,         sub:fmt(stats.pipeline)+" in pipeline",                                         bg:"#fef3c7", color:"#92400e" },
          { label:"Projects Won",   val:stats.won,          sub:`${stats.total?Math.round(stats.won/stats.total*100):0}% conversion`,        bg:"#d1fae5", color:"#065f46" },
          { label:"Pending Quotes", val:stats.pending,      sub:fmt(stats.pendingValue)+" pending value",                                    bg:"#ede9fe", color:"#5b21b6" },
        ].map(c=>(
          <div key={c.label} className="bg-white border border-slate-200 rounded-xl p-[18px]">
            <div className="text-[11px] text-slate-500 uppercase tracking-wide mb-2">{c.label}</div>
            <div className="font-display text-[26px] font-extrabold">{c.val}</div>
            <div className="inline-flex items-center mt-1.5 text-[11px] px-2 py-0.5 rounded-full" style={{background:c.bg,color:c.color}}>{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_340px] gap-4 grid2r-responsive">
        <div>
          <div className="bg-white border border-slate-200 rounded-xl p-[18px]">
            <div className="flex items-center justify-between mb-4">
              <span className="font-bold text-sm">Recent Projects</span>
              <Btn sm onClick={()=>setView("projects")}>View all</Btn>
            </div>
            {recent.map(p=>{
              const cust = customers.find(c=>c.id===p.customerId)
              const st   = STATUS_STYLE[p.status]
              return (
                <div key={p.id} onClick={()=>openProject(p)} className="flex items-center gap-3.5 py-2.5 border-b border-slate-100 last:border-b-0 cursor-pointer">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{background:st.dot}}/>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[13px] whitespace-nowrap overflow-hidden text-ellipsis">{cust?.name||"—"}</div>
                    <div className="text-[11px] text-slate-500 whitespace-nowrap overflow-hidden text-ellipsis">{p.address}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <StatusBadge status={p.status}/>
                    <div className="text-[11px] text-slate-500 mt-0.5">{p.estimate ? fmt(p.estimate.total) : "No estimate"}</div>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-[18px] mt-4">
            <div className="font-bold text-sm mb-4">Pipeline by Stage</div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={chartData} barSize={32}>
                <XAxis dataKey="name" tick={{fontSize:11,fill:"#64748b"}} axisLine={false} tickLine={false}/>
                <YAxis hide/>
                <Tooltip formatter={(v)=>[v+" projects"]} contentStyle={{fontSize:12,border:"1px solid #e2e8f0",borderRadius:8}}/>
                <Bar dataKey="count" radius={[6,6,0,0]}>
                  {chartData.map((entry,i)=><Cell key={i} fill={entry.color}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="flex flex-col gap-3.5">
          <div className="bg-white border border-slate-200 rounded-xl p-[18px]">
            <div className="font-bold text-sm mb-3.5">Pipeline Summary</div>
            {STATUSES.map(st=>(
              <div key={st} className="flex items-center justify-between py-2 border-b border-slate-100 last:border-b-0">
                <div className="flex items-center gap-2 text-[13px] text-slate-600">
                  <span className="w-2 h-2 rounded-full inline-block" style={{background:STATUS_STYLE[st].dot}}/>
                  {st}
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="text-xs text-slate-500">{projects.filter(p=>p.status===st).length} jobs</span>
                  <span className="font-bold text-[13px]">{fmt(projects.filter(p=>p.status===st).reduce((a,p)=>a+(p.estimate?.total||0),0))}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-[18px]">
            <div className="font-bold text-sm mb-3">Quick Actions</div>
            <div className="flex flex-col gap-2">
              <Btn primary full onClick={onNewProject}>📸 New Roof Job</Btn>
              <Btn full onClick={()=>setView("pipeline")}>▦ View Pipeline</Btn>
              <Btn full onClick={()=>setView("customers")}>👤 Manage Customers</Btn>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── MODULE 1: ROOF MEASUREMENT TOOL (MVP) ───────────────────────────
// Assisted (non-AI) measurement: upload a photo, trace the roof outline with points,
// enter one known real-world measurement, and the tool scales everything proportionally.
// Includes zoom (buttons), pan (Space+drag, middle-mouse, or the Pan tool),
// and editable points — every placed point can be dragged to reposition it later.
const SEC_COLORS = ["#3b82f6","#10b981","#8b5cf6","#f59e0b","#ef4444","#06b6d4","#f97316","#84cc16","#ec4899","#14b8a6"]
const PEN_TYPES  = ["skylight","pipe","flue","vent","other"]
const PEN_COLORS = { skylight:"#f59e0b", pipe:"#94a3b8", flue:"#ef4444", vent:"#10b981", other:"#8b5cf6" }

// Named flashing runs, matching how a real roofing quote's scope-of-works
// lists them (ridge cap, hip cap, valley, etc.) rather than one generic
// "flashing" bucket — each gets its own traced length + supplier rate.
const FLASHING_TYPES = [
  { key:"ridge_cap",  label:"Ridge Cap"   },
  { key:"hip_cap",    label:"Hip Cap"     },
  { key:"head_apron", label:"Head Apron"  },
  { key:"side_apron", label:"Side Apron"  },
  { key:"barge",      label:"Barge"       },
  { key:"valley",     label:"Valley"      },
  { key:"eaves",      label:"Eaves"       },
  { key:"backtray",   label:"Backtray"    },
]
// Barge and Side Apron run straight up the slope, so 1/cos(θ) — the same
// factor roof area uses — is exactly right. Hip Cap and Valley run
// diagonally, whose strictly correct factor is √(1 + tan²θ/2); 1/cos(θ) is
// used for them too by deliberate choice (simpler, consistent with area),
// which over-measures a hip/valley by ~3.9% at 22.62°.
// The list of which subtypes get an angle lives in FLASHING_ANGLE_SUBTYPES
// below, next to flashingQtyM which actually applies the correction.
const flashingSlopeMult = pitchDeg =>
  pitchDeg > 0 ? 1/Math.cos(Math.min(pitchDeg, 85)*Math.PI/180) : 1
const flashingLabel = key => FLASHING_TYPES.find(f=>f.key===key)?.label || "Flashing"

// Hip/Valley/Apron/Barge/Eaves flashing physically follows the roof's
// slope, so its traced (plan-view) length under-states real material
// needed — same 1/cos(angle) correction sections already use for surface
// area. No angle set (null/0) = no adjustment.
function flashingQtyM(r) {
  const a = parseFloat(r.angleDeg)
  return (a>0 && a<90) ? (r.length_m||0)/Math.cos(a*Math.PI/180) : (r.length_m||0)
}
// ← Only runs that actually follow the slope. "eaves" used to be in here
//   but an eave runs horizontally along the gutter line, so its traced plan
//   length already IS its true length — applying 1/cos(θ) to it inflated the
//   order rather than correcting it. Ridge Cap / Head Apron / Backtray are
//   horizontal for the same reason and were never included.
const FLASHING_ANGLE_SUBTYPES = ["hip_cap","valley","side_apron","barge"]

// Units offered when calibrating the scale line — covers both metric and
// imperial so the tool reads like a proper survey/civil measurement app,
// not just "metres". Every unit converts to metres (the internal unit all
// geometry math is done in) via `toM`.
const CALIB_UNITS = [
  { key:"mm", label:"mm", toM:0.001,   placeholder:"e.g. 3000" },
  { key:"cm", label:"cm", toM:0.01,    placeholder:"e.g. 300"  },
  { key:"m",  label:"m",  toM:1,       placeholder:"e.g. 3"    },
  { key:"km", label:"km", toM:1000,    placeholder:"e.g. 0.003"},
  { key:"in", label:"in", toM:0.0254,  placeholder:"e.g. 120"  },
  { key:"ft", label:"ft", toM:0.3048,  placeholder:"e.g. 10"   },
  { key:"yd", label:"yd", toM:0.9144,  placeholder:"e.g. 3.3"  },
]

// Brand-picker popup shown right after drawing a gutter run, downpipe,
// roof drain, or penetration — mirrors the roof section popup so every
// traced item that carries its own materialLabel/rate gets assigned one
// on the spot instead of only in the Estimate step. `group` matches
// roof_materials.product_group (migrations/13, /14).
// `unit` picks how MaterialPicker.pick() derives a rate; `catalogUnit`
// filters results to rows priced that way in the catalog's own `unit`
// column — e.g. without it, a gutter run (priced per metre) could match an
// "ea" bracket/clip that happens to share the same product_group as the
// actual per-metre spouting product.
const ACCESSORY_MODAL_CONFIG = {
  // Title/prompt are overridden with the specific subtype name (Ridge Cap,
  // Valley, etc.) where the modal is rendered — a flashing run's brand
  // applies to every traced segment of that same subtype, not just the one
  // just drawn, since the Estimate step prices per-subtype, not per-line.
  flashing:    { title:"Flashing Brand",            group:"flashing",    unit:"lm",   catalogUnit:"LM", prompt:"What product will this flashing use?" },
  gutter:      { title:"Guttering Brand",           group:"gutter",      unit:"lm",   catalogUnit:"LM", prompt:"What guttering product will this run use?" },
  downpipe:    { title:"Downpipe Brand",            group:"downpipe",    unit:"each", catalogUnit:"ea", prompt:"What downpipe product is this?" },
  drain:       { title:"Roof Drain Brand",          group:"drain",       unit:"each", catalogUnit:"ea", prompt:"What roof drain product is this?" },
  penetration: { title:"Penetration Flashing Brand",group:"penetration", unit:"each", catalogUnit:"ea", prompt:"What penetration flashing/boot will seal this?" },
}

function parsePitch(str) {
  if(!str||str==="") return 1.0
  const s = String(str).trim()
  const m = s.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/)
  if(m) return Math.sqrt(parseFloat(m[1])**2+parseFloat(m[2])**2)/parseFloat(m[2])
  // ← Explicit degree marker (e.g. "5°") — checked before the bare-number
  //   fallbacks below so a shallow degrees pitch (≤5°) can't be confused
  //   with the "already a multiplier" case (bare "1.15" default etc.).
  //   Clamped below 90° — a roof plane can't actually be vertical, and
  //   Math.cos(90°) isn't exactly 0 in floating point (≈6e-17), so an
  //   unclamped 1/cos(90°) explodes to ~10^16 instead of erroring.
  const deg = s.match(/^(\d+(?:\.\d+)?)\s*°$/)
  if(deg) return 1/Math.cos(Math.min(Math.max(parseFloat(deg[1]),0),89)*Math.PI/180)
  const d = parseFloat(s)
  if(!isNaN(d) && d<=5)  return d
  // ← Same 89° ceiling as the explicit-"°" branch above — a bare number
  //   this close to 90 (e.g. "89.8" typed without the degree symbol) would
  //   otherwise explode toward infinity here uncapped, producing a
  //   nonsensical multiplier (and surface area) with no error shown.
  if(!isNaN(d) && d<90)  return 1/Math.cos(Math.min(Math.max(d,0),89)*Math.PI/180)
  return 1.15
}
// Reverse of the string-building the Roof Pitch popup does — derives the
// single canonical angle (in degrees) a stored pitch string represents, so
// the modal's Ratio/Degrees display never has to convert from a previously
// *displayed* (already-rounded) number: everything always derives fresh
// from this one angle. Returns null when no pitch has been set yet
// ("Unknown Pitch"), instead of a fake default.
function deriveSectionPitchInput(pitchStr) {
  const str = String(pitchStr ?? "").trim()
  if(!str) return null
  const ratioMatch = str.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/)
  if(ratioMatch) {
    const rise = parseFloat(ratioMatch[1]), run = parseFloat(ratioMatch[2])
    return { mode:"ratio", angleDeg: Math.atan(rise/run)*180/Math.PI }
  }
  const degMatch = str.match(/^(\d+(?:\.\d+)?)\s*°$/)
  if(degMatch) return { mode:"degrees", angleDeg: parseFloat(degMatch[1]) }
  const d = parseFloat(str)
  if(!isNaN(d) && d>5 && d<90) return { mode:"degrees", angleDeg: d }
  // ← Legacy bare-multiplier pitch (the old "1.15" default, from before
  //   "Unknown Pitch" existed as an explicit state) — best-effort
  //   reconstruct an equivalent angle so old data still opens sensibly
  //   instead of silently showing a blank field.
  if(!isNaN(d) && d>=1) return { mode:"ratio", angleDeg: Math.acos(1/d)*180/Math.PI }
  return null
}
function polyAreaPx(pts) {
  let sum=0; const n=pts.length
  for(let i=0;i<n;i++){const j=(i+1)%n;sum+=pts[i].x*pts[j].y-pts[j].x*pts[i].y}
  return Math.abs(sum/2)
}
// ← Ortho snap: forces the segment from `prevPt` to `pt` to be perfectly
//   horizontal or vertical — snaps to whichever axis the raw point is
//   already further along, flattening the other axis to match `prevPt`.
function orthoSnap(pt, prevPt) {
  if(!prevPt) return pt
  const dx = Math.abs(pt.x-prevPt.x), dy = Math.abs(pt.y-prevPt.y)
  return dx>=dy ? { x:pt.x, y:prevPt.y } : { x:prevPt.x, y:pt.y }
}
// ← When horizontal/vertical calibration scales differ (anisotropic), every
//   point fed into the existing area/length/clipping functions is squashed
//   along X by (sfX/sfY) first so those functions can stay untouched (see
//   `geometry` useMemo). A direction angle defined in true (unsquashed)
//   photo space — the Cut Angle slider, or a degree pitch — needs the same
//   transform applied to its unit vector, or the stripe direction computed
//   from it would silently drift from what the slider/photo actually show.
function squashAngleDeg(trueDeg, squashRatio) {
  if(squashRatio===1 || trueDeg==null || isNaN(trueDeg)) return trueDeg
  const rad = trueDeg*Math.PI/180
  return Math.atan2(Math.sin(rad), Math.cos(rad)*squashRatio)*180/Math.PI
}
// ← Classifies a section's shape (in true real-world coordinates — angles
//   only mean something before any anisotropic squashing) as "rectangle-
//   like" using GLOBAL properties (point count, opposite-side length
//   ratio, corner angles) rather than per-column sampling. This is what
//   decides whether the cutting list uses the Uniform strategy (every
//   sheet the same length) instead of the tapered polygon-clipping one —
//   verified against a battery of shapes (perfect rectangle, a rectangle
//   with a few-cm trace imprecision, a triangular hip apex, a stepped hip,
//   a genuinely skewed parallelogram, a quad with one hip-like corner)
//   before relying on it: it correctly passes only true 4-point,
//   near-rectangular shapes and correctly rejects every other case tested.
function isRectangleLike(pts, angleTolDeg=6, lengthTolPct=8) {
  if(!pts || pts.length!==4) return false
  const edges = []
  for(let i=0;i<4;i++){
    const a=pts[i], b=pts[(i+1)%4]
    edges.push({dx:b.x-a.x, dy:b.y-a.y, len:Math.hypot(b.x-a.x,b.y-a.y)})
  }
  const r1 = Math.abs(edges[0].len-edges[2].len)/Math.max(edges[0].len,edges[2].len)*100
  const r2 = Math.abs(edges[1].len-edges[3].len)/Math.max(edges[1].len,edges[3].len)*100
  if(r1>lengthTolPct || r2>lengthTolPct) return false
  for(let i=0;i<4;i++){
    const e1=edges[i], e2=edges[(i+1)%4]
    const cosA = (e1.dx*e2.dx+e1.dy*e2.dy)/(e1.len*e2.len)
    const angleDeg = Math.acos(Math.min(1,Math.max(-1,cosA)))*180/Math.PI
    if(Math.abs(angleDeg-90)>angleTolDeg) return false
  }
  return true
}
// ← Where a stripe line (p1→p2, spanning well past the polygon on both
//   ends) actually crosses the polygon boundary — used to trim each sheet
//   stripe down to its real in-roof length instead of a uniform bbox span
//   (a triangular/hip section narrows, so each stripe's true length differs).
function clipSegmentToPolygon(p1, p2, pts) {
  const dx=p2.x-p1.x, dy=p2.y-p1.y
  const ts=[]
  for(let i=0;i<pts.length;i++){
    const a=pts[i], b=pts[(i+1)%pts.length]
    const ex=b.x-a.x, ey=b.y-a.y
    const denom = dx*ey - dy*ex
    if(Math.abs(denom)<1e-9) continue
    const t = ((a.x-p1.x)*ey - (a.y-p1.y)*ex)/denom
    const u = ((a.x-p1.x)*dy - (a.y-p1.y)*dx)/denom
    // ← t needs the same small tolerance u already has — a legitimate
    //   intersection exactly at the query line's own endpoint (t≈0 or
    //   t≈1, which happens constantly here since every stripe's p1/p2 are
    //   built at the polygon's own perpMin/perpMax) can compute as a
    //   hair outside [0,1] from floating-point roundoff and get wrongly
    //   rejected. Without this, that edge silently drops from `ts`,
    //   sometimes leaving only 1 crossing where there should be 2 —
    //   undercounting the cutting list by a sheet.
    if(u>=-1e-6 && u<=1+1e-6 && t>=-1e-6 && t<=1+1e-6) ts.push(Math.min(Math.max(t,0),1))
  }
  if(ts.length<2) return null
  ts.sort((a,b)=>a-b)
  const tIn=ts[0], tOut=ts[ts.length-1]
  const q1={ x:p1.x+dx*tIn, y:p1.y+dy*tIn }
  const q2={ x:p1.x+dx*tOut, y:p1.y+dy*tOut }
  return { p1:q1, p2:q2, lenPx:Math.hypot(q2.x-q1.x,q2.y-q1.y) }
}
// ← Sheet "cutting list" stripes: direction comes from the section's pitch
//   angle (degrees) when set, otherwise falls back to treating the
//   polygon's longest edge as the eave/ridge line. Sheets lay side-by-side
//   along the eave (spaced by cover width), each running perpendicular
//   (down-slope), clipped to the polygon so each stripe's length reflects
//   how the roof section actually narrows/widens under it. Returns
//   pixel-space segments plus the counts/lengths the sidebar reads.
function sectionStripeInfo(pts, sheetWidthPx, angleDeg, anchorPt) {
  if(!pts || pts.length<3) return { stripes:[], count:0, dirLenPx:0, perpLenPx:0, longestEdgePx:0 }
  // ← Longest edge is computed unconditionally (not just for auto-direction)
  //   since RoofPlane summaries want it regardless of which direction mode
  //   is active.
  let longest=0, longestDir={x:1,y:0}, longestA=pts[0], longestB=pts[1]
  for(let i=0;i<pts.length;i++){
    const a=pts[i], b=pts[(i+1)%pts.length]
    const dx=b.x-a.x, dy=b.y-a.y, len=Math.hypot(dx,dy)
    if(len>longest){ longest=len; longestDir={x:dx/len,y:dy/len}; longestA=a; longestB=b }
  }
  const usingAutoDirection = !(angleDeg!=null && !isNaN(angleDeg))
  if(!sheetWidthPx || sheetWidthPx<=0) return { stripes:[], count:0, dirLenPx:0, perpLenPx:0, longestEdgePx:longest }
  // ← Auto-detect: `dir` runs along the longest edge (the eave), sheets
  //   (`perp`) run perpendicular to it — down-slope, the standard
  //   convention. A manual angle instead specifies the direction the SHEETS
  //   themselves should run (parallel to a drawn rafter/ridge line, or a
  //   typed Cut Angle) — so `perp` is built directly from it, and `dir`
  //   (the spacing axis sheets are laid out side-by-side along) is the
  //   90°-rotated vector, the reverse of the auto-detect assignment.
  let dir, perp
  if(usingAutoDirection){
    dir = longestDir
    perp = { x:-dir.y, y:dir.x }
  } else {
    perp = { x:Math.cos(angleDeg*Math.PI/180), y:Math.sin(angleDeg*Math.PI/180) }
    dir = { x:-perp.y, y:perp.x }
  }
  const perpVals = pts.map(p=>p.x*perp.x+p.y*perp.y)
  // ← When direction is auto-detected (from the longest edge), anchor the
  //   run's start/end to that EDGE'S OWN two endpoints rather than the
  //   min/max projection over every vertex — the eave's length is what the
  //   eave edge itself measures, not how far the whole shape's projected
  //   shadow happens to extend at that angle. Without this, a few-cm trace
  //   imprecision at one corner tilts the eave's implied angle just enough
  //   that the boundary-most column clips against a slightly-skewed side
  //   edge instead of crossing cleanly top-to-bottom, producing one
  //   dramatically short sheet next to an otherwise-uniform run. Interior
  //   clipping (hip/valley tapering) is untouched — perpMin/perpMax still
  //   come from the full polygon; only the run's own extent changes here.
  let dirMin, dirMax
  if(usingAutoDirection){
    const aProj=longestA.x*dir.x+longestA.y*dir.y, bProj=longestB.x*dir.x+longestB.y*dir.y
    dirMin=Math.min(aProj,bProj); dirMax=Math.max(aProj,bProj)
  } else {
    const dirVals = pts.map(p=>p.x*dir.x+p.y*dir.y)
    dirMin=Math.min(...dirVals); dirMax=Math.max(...dirVals)
  }
  const perpMin=Math.min(...perpVals), perpMax=Math.max(...perpVals)
  // ← dir/perp/dirMin/perpMin/perpMax are exposed (not just the derived
  //   lengths) so callers building a *uniform* sheet run (Rectangle/Gable
  //   roof-plane type — see `geometry` useMemo) can synthesize their own
  //   evenly-spaced, unclipped lines in the same coordinate frame instead
  //   of duplicating this direction/extent computation.
  // ← Guard against a runaway stripe count (bad/uncalibrated scale, or a
  //   sheet width much smaller than the section) that would otherwise draw
  //   thousands of overlapping lines and labels — no real roof needs this
  //   many sheets, so treat it as "can't generate" instead of freezing the
  //   canvas in a garbled mess.
  const MAX_STRIPES = 300
  if((dirMax-dirMin)/sheetWidthPx > MAX_STRIPES) return { stripes:[], count:0, dirLenPx:dirMax-dirMin, perpLenPx:perpMax-perpMin, longestEdgePx:longest, tooMany:true, dir, perp, dirMin, perpMin, perpMax }
  // ← The very first/last stripe sits exactly at dirMin/dirMax, which is
  //   the x-position of an actual polygon corner — a query line placed
  //   there passes through a single vertex (not a real cross-section), so
  //   its two bounding edges both intersect at essentially the same point
  //   and the clip degenerates to ~0 length and gets dropped, even though
  //   the section has real, full width just a hair inside that corner.
  //   Nudging only matters for those two ends — every interior sample is
  //   already comfortably clear of dirMin/dirMax and is unaffected.
  const EDGE_EPS = sheetWidthPx*0.01
  // ← When a manual angle came with an anchor point (the "last end" of a
  //   drawn cut-angle reference line), phase-shift the whole stripe grid so
  //   a boundary lands exactly on the anchor's own position along `dir`,
  //   instead of always starting from the polygon's own extreme corner —
  //   lets a user's drawn line dictate exactly where sheets line up, not
  //   just which direction they run. Anchor is meaningless for
  //   auto-detected direction (nothing was drawn), so it's ignored there.
  let stepStart = dirMin
  if(anchorPt && !usingAutoDirection){
    const anchorD = anchorPt.x*dir.x + anchorPt.y*dir.y
    const offset = ((dirMin - anchorD) % sheetWidthPx + sheetWidthPx) % sheetWidthPx
    stepStart = dirMin - offset
  }
  const stripes=[]
  for(let d=stepStart; d<=dirMax+1e-6; d+=sheetWidthPx){
    if(d < dirMin-1e-6) continue // phase shift can start slightly before the polygon's own edge — skip until inside
    const dSafe = Math.min(Math.max(d, dirMin+EDGE_EPS), dirMax-EDGE_EPS)
    const p1={ x:dSafe*dir.x+perpMin*perp.x, y:dSafe*dir.y+perpMin*perp.y }
    const p2={ x:dSafe*dir.x+perpMax*perp.x, y:dSafe*dir.y+perpMax*perp.y }
    const clipped = clipSegmentToPolygon(p1, p2, pts)
    if(clipped && clipped.lenPx>1) stripes.push({ id:uid(), startPoint:clipped.p1, endPoint:clipped.p2, lengthPx:clipped.lenPx })
  }
  return { stripes, count: stripes.length, dirLenPx: dirMax-dirMin, perpLenPx: perpMax-perpMin, longestEdgePx:longest, dir, perp, dirMin, perpMin, perpMax }
}
function linelenPx(pts) {
  let l=0
  for(let i=0;i<pts.length-1;i++) l+=Math.sqrt((pts[i+1].x-pts[i].x)**2+(pts[i+1].y-pts[i].y)**2)
  return l
}
function distToSegment(pt, a, b) {
  const dx=b.x-a.x, dy=b.y-a.y
  const lenSq = dx*dx+dy*dy
  if(lenSq===0) return Math.hypot(pt.x-a.x, pt.y-a.y)
  const t = Math.max(0, Math.min(1, ((pt.x-a.x)*dx+(pt.y-a.y)*dy)/lenSq))
  return Math.hypot(pt.x-(a.x+t*dx), pt.y-(a.y+t*dy))
}
// Standard ray-casting point-in-polygon test — used to hit-test a click
// landing inside a closed section's fill, not just on/near its outline.
function pointInPolygon(pt, poly) {
  let inside = false
  for(let i=0, j=poly.length-1; i<poly.length; j=i++){
    const xi=poly[i].x, yi=poly[i].y, xj=poly[j].x, yj=poly[j].y
    const intersect = ((yi>pt.y)!==(yj>pt.y)) && (pt.x < (xj-xi)*(pt.y-yi)/(yj-yi)+xi)
    if(intersect) inside = !inside
  }
  return inside
}

// Fixed internal drawing resolution (world / image space). Zoom & pan are
// applied as a view transform on top of this — stored points always stay in
// this fixed coordinate space, so area/length math never needs to know
// about the current zoom or pan.
const MT_CANVAS_W = 490
const MT_CANVAS_H = 330
const MIN_ZOOM = 0.4 // below 1 lets a large/wide roof that doesn't fit at 100% be zoomed out to see fully
const MAX_ZOOM = 6
const HIT_RADIUS = 9 // world-space px for grabbing an existing point

// ── Reconstructs MeasurementTool's editable state from the derived geometry
//    shape it reports upward via onGeometryChange (the same shape returned
//    by GET /api/estimates/:id/geometry) — lets a remounted or freshly
//    opened-for-edit tool start pre-populated instead of blank. ───────────
function initialSectionsFrom(g) {
  if(!g?.sections?.length) return []
  return g.sections.map((sec,i)=>({
    id: sec.id || uid(), name: sec.name || `Section ${i+1}`,
    pts: sec.shape_points || [], closed: true,
    pitch: sec.pitch ?? null, color: SEC_COLORS[i % SEC_COLORS.length],
    materialLabel: sec.materialLabel || "", rate: sec.rate || 0,
    sheetWidthMm: sec.sheetWidthMm || 762,
    cutAngleDeg: sec.cutAngleDeg ?? null,
    cutAngleAnchor: sec.cutAngleAnchor ?? null,
  }))
}
function initialLineItemsFrom(g) {
  const flashings = g?.accessories?.flashings || []
  const gutters    = g?.accessories?.gutters   || []
  // ← Spread the full source object (matching initialPtItemsFrom below)
  //   instead of hand-picking fields — otherwise materialLabel/rate (the
  //   brand/rate picked via the flashing/gutter popup) silently drop out
  //   on restore even though geometry.accessories already carries them.
  return [...flashings, ...gutters].map(l => ({ ...l, id: l.id || uid() }))
}
function initialPtItemsFrom(g) {
  const downpipes = g?.accessories?.downpipes   || []
  const drains     = g?.accessories?.drains     || []
  const pens       = g?.accessories?.penetrations || []
  return [...downpipes, ...drains, ...pens].map(p => ({ ...p, id: p.id || uid() }))
}
function initialKnownMFrom(g) {
  return g?.scale_m_per_px ? parseFloat((g.scale_m_per_px*100).toFixed(4)) : 10
}
// ← Confirmed calibration reference lines don't round-trip through the
//   single averaged scale_m_per_px number (the area math still gets the
//   right scale via that fallback, but the visual lines themselves — and
//   the "N references"/disagreement warning — need their own restore path.
function initialScaleLinesFrom(g) {
  return (g?.scaleLines||[]).map(l => ({ ...l, id: l.id || uid() }))
}
// ← Dimension Tool reference lines (PlanSwift-style click-two-points
//   measurement annotations) — visual-only, carries no rate/cost, never
//   feeds the estimate. Structurally identical to scaleLines (just p1/p2),
//   restored the same way.
function initialDimensionLinesFrom(g) {
  // ← DB column is snake_case (dimension_lines) and this object comes
  //   straight off a `SELECT *` row, not a camelCased API response —
  //   matches how scale_m_per_px is read directly elsewhere in this file.
  return (g?.dimension_lines||[]).map(l => ({ ...l, id: l.id || uid() }))
}

// ─────────────────────────── PHOTO PROTRACTOR ───────────────────────────
// Measures a roof's slope angle by dragging a line along the roof edge in a
// photo — the "measure it instead of typing it" counterpart to the Roof
// Pitch modal's Degrees field.
//
// Two things this deliberately does NOT do, both worth knowing:
//
//  1. It never measures on the main tracing canvas. That canvas draws the
//     photo with `drawImage(img,0,0,MT_CANVAS_W,MT_CANVAS_H)` — stretched to
//     a fixed 490x330 regardless of the image's real shape — so an angle
//     read off it is skewed by the stretch. Here the photo is drawn with a
//     single uniform scale (letterboxed to fit), which is what makes a
//     measured screen angle equal the true angle in the photo.
//
//  2. It can't turn an oblique photo into a true pitch. What's measured is
//     the *apparent* angle, which equals the real slope only when the camera
//     is roughly square-on to the gable end. Nothing in this app carries
//     camera pose/horizon data to correct for that, so the reading is
//     presented as an estimate rather than implying survey accuracy. The
//     optional horizontal reference line does fix the one error that IS
//     correctable without pose data: a tilted/rotated photo.
function fitContain(iw, ih, bw, bh) {
  if(!iw || !ih || !bw || !bh) return { x:0, y:0, w:0, h:0 }
  const scale = Math.min(bw/iw, bh/ih)   // ← uniform: preserves angles
  const w = iw*scale, h = ih*scale
  return { x:(bw-w)/2, y:(bh-h)/2, w, h }
}

// Normalises any measured line direction into the 0–90° range a roof slope
// actually lives in — a line drawn up-left and one drawn down-right describe
// the same steepness, and 158° is just 22° mirrored.
function toSlopeDeg(deg) {
  const a = ((deg % 180) + 180) % 180
  return a > 90 ? 180 - a : a
}

function ProtractorOverlay({ initialImage, onClose, onConfirm, confirmLabel = "Use this angle" }) {
  const wrapRef   = useRef(null)
  const canvasRef = useRef(null)
  const fileRef   = useRef(null)
  const dragRef   = useRef(null)

  const [img,     setImg]     = useState(initialImage || null)
  const [box,     setBox]     = useState({ w:0, h:0 })
  const [angle,   setAngle]   = useState(0)      // ruler rotation, degrees
  const [pos,     setPos]     = useState(null)   // ruler centre, CSS px
  const [baseDeg, setBaseDeg] = useState(0)      // "level" tare, see setLevel()

  // Track the drawing surface so the backing store stays sharp and the
  // letterbox fit recomputes on resize/rotate.
  useLayoutEffect(()=>{
    const el = wrapRef.current
    if(!el) return
    const sync = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return ()=>ro.disconnect()
  },[])

  // Park the ruler in the middle until the user first drags it.
  useEffect(()=>{
    if(!pos && box.w && box.h) setPos({ x: box.w/2, y: box.h/2 })
  },[box, pos])

  // Wheel rotates the ruler. Registered natively with passive:false because
  // preventDefault() is required to stop the page scrolling underneath, and
  // React's synthetic wheel handler can't guarantee that.
  useEffect(()=>{
    const cv = canvasRef.current
    if(!cv) return
    const onWheel = e => {
      e.preventDefault()
      const step = e.shiftKey ? 0.1 : 1
      setAngle(a => a + (e.deltaY > 0 ? step : -step))
    }
    cv.addEventListener("wheel", onWheel, { passive:false })
    return ()=>cv.removeEventListener("wheel", onWheel)
  },[])

  useEffect(()=>{
    function onKey(e){
      if(e.key==="Escape"){ onClose(); return }
      const step = e.shiftKey ? 0.1 : 1
      if(e.key==="ArrowLeft"||e.key==="ArrowDown"){ e.preventDefault(); setAngle(a=>a-step) }
      if(e.key==="ArrowRight"||e.key==="ArrowUp"){ e.preventDefault(); setAngle(a=>a+step) }
    }
    window.addEventListener("keydown", onKey)
    return ()=>window.removeEventListener("keydown", onKey)
  },[onClose])

  const displayDeg = toSlopeDeg(angle - baseDeg)
  // Same rise:run rendering the Roof Pitch modal shows, so both readouts agree.
  const ratioDisplay = `${Math.round(12*Math.tan(displayDeg*Math.PI/180)*100)/100} : 12`
  const tooSteep = displayDeg >= 85
  // A reading taken against a blank canvas isn't a measurement of anything.
  const canConfirm = !!img && !tooSteep

  useEffect(()=>{
    const cv = canvasRef.current
    if(!cv || !box.w || !box.h || !pos) return
    const dpr = Math.min(window.devicePixelRatio||1, 2)
    cv.width  = Math.round(box.w*dpr)
    cv.height = Math.round(box.h*dpr)
    const ctx = cv.getContext("2d")
    ctx.setTransform(dpr,0,0,dpr,0,0)
    ctx.fillStyle = "#0b1220"
    ctx.fillRect(0,0,box.w,box.h)

    // Nothing to measure against yet — leave the canvas empty so the DOM
    // "choose a photo" prompt over the top reads clearly, instead of
    // rendering a ruler across a blank backdrop and burying the instruction
    // underneath it.
    if(!img) return

    const r = fitContain(img.naturalWidth||img.width, img.naturalHeight||img.height, box.w, box.h)
    ctx.drawImage(img, r.x, r.y, r.w, r.h)

    const rad = angle*Math.PI/180

    // ── The ruler itself: a physical straightedge you lay over the roof
    //    line, rather than a line you draw. Long enough to always run off
    //    both sides of the canvas at any rotation.
    const H = 132
    const L = Math.hypot(box.w, box.h)*2 + 400
    ctx.save()
    ctx.translate(pos.x, pos.y)
    ctx.rotate(rad)

    ctx.fillStyle = "rgba(226,232,240,0.80)"
    ctx.fillRect(-L/2, -H/2, L, H)
    ctx.strokeStyle = "rgba(15,23,42,0.45)"
    ctx.lineWidth = 1.5
    ctx.strokeRect(-L/2, -H/2, L, H)

    // Graduations on both long edges, pointing inward.
    ctx.lineCap = "butt"
    for(let x = -Math.floor(L/2/10)*10; x <= L/2; x += 10){
      const i = Math.round(x/10)
      const major = i%10===0, mid = i%5===0
      const len = major ? 19 : mid ? 12 : 7
      ctx.strokeStyle = major ? "rgba(15,23,42,0.75)" : "rgba(15,23,42,0.45)"
      ctx.lineWidth   = major ? 1.5 : 1
      ctx.beginPath(); ctx.moveTo(x, -H/2); ctx.lineTo(x, -H/2+len); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x,  H/2); ctx.lineTo(x,  H/2-len); ctx.stroke()
    }
    ctx.restore()

    // ── Centre dial. Drawn unrotated so the number stays upright however far
    //    the ruler is turned, with a red pointer tracking the rotation.
    const R = 34
    ctx.save()
    ctx.translate(pos.x, pos.y)
    ctx.fillStyle = "rgba(255,255,255,0.94)"
    ctx.beginPath(); ctx.arc(0,0,R+9,0,Math.PI*2); ctx.fill()
    ctx.strokeStyle = "rgba(15,23,42,0.18)"; ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(0,0,R+9,0,Math.PI*2); ctx.stroke()
    for(let d=0; d<360; d+=6){
      const a = d*Math.PI/180
      const major = d%30===0
      ctx.strokeStyle = "rgba(15,23,42,0.7)"
      ctx.lineWidth   = major ? 1.6 : 1
      const r0 = R - (major ? 10 : 5)
      ctx.beginPath()
      ctx.moveTo(Math.cos(a)*r0, Math.sin(a)*r0)
      ctx.lineTo(Math.cos(a)*R,  Math.sin(a)*R)
      ctx.stroke()
    }
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2.5
    ;[rad, rad+Math.PI].forEach(a=>{
      ctx.beginPath()
      ctx.moveTo(Math.cos(a)*(R-3), Math.sin(a)*(R-3))
      ctx.lineTo(Math.cos(a)*(R+8), Math.sin(a)*(R+8))
      ctx.stroke()
    })
    ctx.fillStyle = "#0f172a"
    ctx.font = "bold 15px DM Sans"
    ctx.textAlign = "center"; ctx.textBaseline = "middle"
    ctx.fillText(`${displayDeg.toFixed(1)}°`, 0, 0)
    ctx.textBaseline = "alphabetic"
    ctx.restore()
  },[img, box, pos, angle, displayDeg])

  const ptFrom = e => {
    const r = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const onDown = e => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const p = ptFrom(e)
    dragRef.current = { from:p, origin:pos }
  }
  const onMove = e => {
    const d = dragRef.current
    if(!d || !d.origin) return
    const p = ptFrom(e)
    setPos({ x: d.origin.x + (p.x-d.from.x), y: d.origin.y + (p.y-d.from.y) })
  }
  const onUp = () => { dragRef.current = null }

  function pickPhoto(file){
    if(!file) return
    const r = new FileReader()
    r.onload = ev => {
      const im = new Image()
      im.onload = () => setImg(im)
      im.src = ev.target.result
    }
    r.readAsDataURL(file)
  }

  const btn = "px-2.5 py-1.5 rounded-md border border-white/15 text-slate-300 text-[11px] hover:bg-white/5"

  return (
    <div className="fixed inset-0 z-[2000] bg-slate-900/90 flex flex-col" onClick={e=>e.stopPropagation()}>
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-white font-display font-extrabold text-[15px]">📐 Protractor</span>
          <span className="text-slate-400 text-[11px]">
            Scroll to rotate · drag to move · hold Shift for 0.1° steps
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={e=>{ pickPhoto(e.target.files[0]); e.target.value="" }}/>
          <button onClick={()=>fileRef.current?.click()}
            title="Pitch isn't visible in a top-down aerial — load a side/elevation photo to measure it"
            className={btn}>🖼 Use a different photo</button>
          <button onClick={()=>setBaseDeg(angle)} disabled={!img}
            title="Lay the ruler on something you know is level (gutter, eave, window sill) and click this — the reading then counts from there, cancelling out a tilted photo"
            className={btn} style={{opacity:img?1:.4}}>⇔ Set level here</button>
          {baseDeg!==0 && (
            <button onClick={()=>setBaseDeg(0)} className="px-2.5 py-1.5 rounded-md border border-sky-400 text-sky-300 bg-sky-400/10 text-[11px]">
              level {baseDeg>0?"+":""}{baseDeg.toFixed(1)}° · reset
            </button>
          )}
          <button onClick={()=>{ setAngle(0); setBaseDeg(0); setPos({x:box.w/2,y:box.h/2}) }} className={btn}>Reset</button>
          {/* ← Duplicated up here because the footer's copy can sit below the
              fold on a short window, leaving no visible way to commit the
              measurement. The header is always on screen at any size. */}
          <span className="text-amber-400 font-bold text-[15px] tabular-nums pl-1">
            {img ? `${displayDeg.toFixed(2)}°` : "—"}
          </span>
          <Btn primary style={{opacity:canConfirm?1:.5}} onClick={()=>{ if(canConfirm) onConfirm(displayDeg) }}>
            {confirmLabel}
          </Btn>
          <button onClick={onClose} className={btn}>✕ Close</button>
        </div>
      </div>

      <div ref={wrapRef} className="flex-1 min-h-0 relative">
        <canvas
          ref={canvasRef}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          className={`absolute inset-0 w-full h-full block ${img?"cursor-move":"cursor-default"}`}
          style={{ touchAction:"none" }}/>
        {!img && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
            <div className="text-slate-300 text-sm text-center max-w-sm leading-relaxed px-4">
              Load a photo that shows the roof <strong className="text-white">from the side</strong> — a street-view
              screenshot or site photo. A top-down aerial can't show pitch.
            </div>
            <button onClick={()=>fileRef.current?.click()}
              className="pointer-events-auto px-4 py-2 rounded-lg bg-accent hover:bg-accent-dark text-slate-900 font-medium text-[13px]">
              🖼 Choose a photo
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 px-4 py-3 border-t border-white/10 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-5 flex-wrap">
          <div>
            <div className="text-slate-400 text-[10px] uppercase tracking-wide">Measured</div>
            <div className="text-amber-400 font-bold text-2xl leading-tight">{img ? `${displayDeg.toFixed(2)}°` : "—"}</div>
          </div>
          <div>
            <div className="text-slate-400 text-[10px] uppercase tracking-wide">Equivalent Ratio</div>
            <div className="text-white font-semibold text-[15px] leading-tight">{img ? ratioDisplay : "—"}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={()=>setAngle(a=>a-0.1)} className="w-7 h-7 rounded-md border border-white/15 text-slate-300 hover:bg-white/5">−</button>
            <button onClick={()=>setAngle(a=>a+0.1)} className="w-7 h-7 rounded-md border border-white/15 text-slate-300 hover:bg-white/5">+</button>
          </div>
          <div className="text-slate-400 text-[11px] max-w-[360px] leading-relaxed">
            Estimated from the photo — most accurate when the shot is square-on to the gable end. Worth confirming on site.
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tooSteep && <span className="text-red-400 text-[11px]">Over 85° — too steep to be a roof plane.</span>}
          <Btn primary style={{opacity:canConfirm?1:.5}} onClick={()=>{ if(canConfirm) onConfirm(displayDeg) }}>
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  )
}

const MeasurementTool = forwardRef(function MeasurementTool({ onGeometryChange, photoUrl, onPhotoChange, initialGeometry, company }, ref) {
  const canvasRef   = useRef(null)
  const imgRef      = useRef(null)
  // ← True only for the instant getSnapshot() redraws the canvas for capture,
  //   so on-screen-only UI hints (the "Upload a roof photo…" prompt) are left
  //   out of the PNG that gets embedded in client quotes.
  const snapshotModeRef = useRef(false)
  const [imgSrc,    setImgSrc]    = useState(null)
  const [sections,  setSections]  = useState(() => initialSectionsFrom(initialGeometry))
  const [expandedCutSections, setExpandedCutSections] = useState({}) // {[sectionId]: boolean} — cutting-list panel toggle
  // ← Per-section canvas visibility — a busy multi-plane roof (several
  //   sections traced close together) gets very cluttered with every
  //   section's outline/label/cutting-list all drawn at once; hiding one
  //   temporarily lets you focus on another without losing its data.
  const [hiddenSections, setHiddenSections] = useState({}) // {[sectionId]: boolean}
  // ← Same per-item hide toggle as hiddenSections above, for Dimension Tool
  //   lines — a plan with several reference measurements gets cluttered
  //   fast, so any one of them can be temporarily hidden without deleting
  //   it. Not part of undo/redo history, same as hiddenSections (a view
  //   toggle, not a data mutation).
  const [hiddenDimensionLines, setHiddenDimensionLines] = useState({}) // {[dimensionLineId]: boolean}
  // ← "cutangle" is a temporary activeTool value: click a section's 🧭
  //   button to enter it (cutAngleDrawSectionId records which section it's
  //   for), then click two points directly on the photo — e.g. tracing an
  //   actual visible rafter/ridge line — and that line's angle becomes the
  //   section's Cut Angle. Mirrors the Calibrate Image tool's two-click
  //   line-then-apply flow.
  const [cutAngleDrawSectionId, setCutAngleDrawSectionId] = useState(null)
  const [cutAngleLine, setCutAngleLine] = useState(null) // {p1, p2:null} while drawing
  // ← id of a just-closed section awaiting its "pick a roof sheet brand"
  //   popup — prompted immediately on close rather than only in Estimate.
  const [sectionMaterialModalId, setSectionMaterialModalId] = useState(null)
  // ← Picked-but-not-yet-saved brand for that popup — only committed to the
  //   section when "Save" is clicked, not the instant a result is picked,
  //   so browsing/searching doesn't accidentally close the popup early.
  const [pendingSectionMaterial, setPendingSectionMaterial] = useState(null)
  // ← Same "prompt right after closing the trace" idea as the brand popup,
  //   shown FIRST in the sequence (pitch, then brand) — a section's real
  //   surface area depends on its pitch, so it's asked before anything
  //   material-related. {mode:"ratio"|"degrees", value} pending until Save,
  //   same commit-on-Save pattern as pendingSectionMaterial.
  const [sectionPitchModalId, setSectionPitchModalId] = useState(null)
  const [pendingSectionPitch, setPendingSectionPitch] = useState(null)
  // ← Photo protractor. `null` = closed; otherwise {target} where target is
  //   "pitchModal" (fill the Roof Pitch modal's Degrees field) or a section
  //   id (apply straight to that section from the toolbar button).
  const [protractor, setProtractor] = useState(null)
  // ← Same "pick a brand right after drawing it" popup as roof sections,
  //   generalized to the other traced items that also carry their own
  //   materialLabel/rate: gutters, downpipes, roof drains, penetrations.
  //   {kind, id} of whichever one is awaiting its popup, kind matching
  //   ACCESSORY_MODAL_CONFIG below.
  const [accessoryModal, setAccessoryModal] = useState(null)
  const [pendingAccessoryMaterial, setPendingAccessoryMaterial] = useState(null)
  // ← Chained in front of the downpipe brand modal right after placement —
  //   see confirmPitch()'s "Roof Pitch → Roof Sheet Brand" chain for the
  //   same pattern.
  const [downpipeLengthModalId, setDownpipeLengthModalId] = useState(null)
  const [pendingDownpipeLength, setPendingDownpipeLength] = useState("")
  // ← Asked before the brand picker for flashings that follow the slope, so
  //   their ordered length can be corrected up from the traced plan length.
  const [flashingPitchModal, setFlashingPitchModal] = useState(null) // {id, subtype}
  const [pendingFlashingPitch, setPendingFlashingPitch] = useState("")
  const [lineItems, setLineItems] = useState(() => initialLineItemsFrom(initialGeometry))
  const [ptItems,   setPtItems]   = useState(() => initialPtItemsFrom(initialGeometry))
  // ← No on-canvas scale line is fabricated when restoring a saved project —
  //   only the resolved ratio is known, not where the original line sat, and
  //   drawing a fake one made it look like a real, editable scale line the
  //   user never drew. The ratio itself is kept as a silent fallback (below)
  //   so restored section areas stay correct until/unless the user redraws
  //   their own scale line, which then takes over.
  const [scaleLine, setScaleLine] = useState(null)
  // ← Confirmed calibration references (plural) — a photo can carry more
  //   than one known dimension, so mPerPx is averaged across all of these
  //   instead of trusting a single line. `scaleLine` above stays the
  //   in-progress line being drawn/confirmed; once confirmed it's pushed
  //   here and cleared, ready for the next reference.
  const [scaleLines, setScaleLines] = useState(() => initialScaleLinesFrom(initialGeometry)) // [{id, p1, p2, knownM}]
  const [knownM,    setKnownM]    = useState(() => initialKnownMFrom(initialGeometry))
  // ← Dimension Tool: `dimensionLine` is the in-progress line being drawn
  //   (mirrors scaleLine/cutAngleLine's draft pattern) — click 1 sets p1,
  //   click 2 sets p2 and immediately commits into `dimensionLines` below
  //   (no confirmation modal needed, unlike Calibrate Image, since the
  //   length is read off the already-calibrated scale, not typed in).
  const [dimensionLine, setDimensionLine] = useState(null) // {p1, p2:null} while drawing
  const [dimensionLines, setDimensionLines] = useState(() => initialDimensionLinesFrom(initialGeometry)) // [{id, p1, p2}]
  // ← Postgres DECIMAL columns come back as strings (e.g. "0.05000000"), not
  //   numbers — without parseFloat here, downstream math like sf.toFixed()
  //   throws since sf would be a string.
  const restoredMPerPx = useRef(initialGeometry?.scale_m_per_px ? parseFloat(initialGeometry.scale_m_per_px) : null).current
  const [calibModalOpen, setCalibModalOpen] = useState(false)
  const [calibUnit,      setCalibUnit]      = useState("m")
  const [calibInput,     setCalibInput]     = useState("")
  const [asbestos,  setAsbestos]  = useState(() => !!initialGeometry?.asbestos)
  const [activeTool,setActiveTool]= useState("section")
  const [penSub,    setPenSub]    = useState("pipe")
  const [flashSub,  setFlashSub]  = useState("ridge_cap")
  const [drawPts,   setDrawPts]   = useState([])
  const [hoverPt,   setHoverPt]   = useState(null)

  // ── Zoom / Pan view state ──────────────────────────────────────────
  // screenX = worldX*zoom + offX ,  screenY = worldY*zoom + offY
  const [view, setView] = useState({ zoom:1, offX:0, offY:0 })
  const panRef = useRef(null) // { startX, startY, startOffX, startOffY }
  const [spaceDown, setSpaceDown] = useState(false)

  // ── Editable points ─────────────────────────────────────────────────
  const dragRef = useRef(null) // { kind, id, idx? } currently-dragged point
  const clickStartRef = useRef(null) // {x,y} client coords at mousedown — tells an actual drag apart from a stationary click that happened to land on an existing point
  // ← Dragging a selected shape to reposition it (Select tool) — captures
  //   the mousedown world point plus each selected item's ORIGINAL points,
  //   so every mousemove translates from that fixed snapshot by a plain
  //   (dx,dy) offset instead of compounding deltas onto already-moved
  //   points (which drifts). `pushed` mirrors dragPushedRef's "only push
  //   history on first real movement, not on a non-drag click" pattern.
  const moveSelectionRef = useRef(null) // { startPt, origSections, origLines, origPoints, pushed }
  const [editMode, setEditMode] = useState(false)
  // ← "Ortho" (PlanSwift/CAD-style orthogonal snap): while tracing, forces
  //   each new point's segment from the previous point to be perfectly
  //   horizontal or vertical (whichever the raw cursor is closer to),
  //   instead of landing wherever the mouse happened to click — fixes
  //   freehand-traced rectangles coming out slightly skewed.
  const [orthoMode, setOrthoMode] = useState(false)
  // ← "Align": purely visual crosshair guide lines + X/Y coordinate readout
  //   through the cursor, independent of Ortho's snap behavior — helps
  //   trace straight lines by eye without changing where points land.
  const [alignMode, setAlignMode] = useState(true)
  // ── Undo / Redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y) ──────────────
  // A snapshot is pushed before every mutating action (adding a point to
  // a line, finishing a shape, deleting, dragging, calibrating scale), so
  // undo works one click/point at a time — not just whole-shape at a time.
  const historyRef = useRef([])
  const redoRef = useRef([]) // states popped by undo, so redo can restore them — cleared on any new action
  const dragPushedRef = useRef(false) // whether the current drag gesture has already pushed its pre-drag snapshot
  function snapshot(){
    return { sections, lineItems, ptItems, scaleLine, scaleLines, dimensionLine, dimensionLines, knownM, asbestos, drawPts }
  }
  function applySnapshot(snap){
    setSections(snap.sections); setLineItems(snap.lineItems); setPtItems(snap.ptItems)
    setScaleLine(snap.scaleLine); setScaleLines(snap.scaleLines||[]); setKnownM(snap.knownM); setAsbestos(snap.asbestos)
    setDimensionLine(snap.dimensionLine||null); setDimensionLines(snap.dimensionLines||[])
    setDrawPts(snap.drawPts)
  }
  function pushHistory(){
    historyRef.current.push(snapshot())
    if(historyRef.current.length>50) historyRef.current.shift()
    redoRef.current = [] // a fresh action invalidates whatever was redo-able
  }
  function undo(){
    const prev = historyRef.current.pop()
    if(!prev) return
    redoRef.current.push(snapshot())
    if(redoRef.current.length>50) redoRef.current.shift()
    applySnapshot(prev)
  }
  function redo(){
    const next = redoRef.current.pop()
    if(!next) return
    historyRef.current.push(snapshot())
    if(historyRef.current.length>50) historyRef.current.shift()
    applySnapshot(next)
  }

  // ── Marquee select (Photoshop-style drag-a-box, then Delete) ────────
  const [selectBox, setSelectBox] = useState(null) // {start:{x,y}, current:{x,y}} while dragging
  // ← Right-clicking mid-Flashing/Gutter trace used to silently finish the
  //   line; this instead offers an explicit choice — screen coords (not
  //   world coords) since it's positioned as a fixed-position popup.
  const [lineContextMenu, setLineContextMenu] = useState(null) // {x,y} | null
  const [selection, setSelection] = useState({ sections:[], lines:[], points:[], scale:false, scaleLineIds:[], dimensionLineIds:[] })
  const selectionCount = selection.sections.length + selection.lines.length + selection.points.length + (selection.scale?1:0) + selection.scaleLineIds.length + selection.dimensionLineIds.length
  // ← Explicit "Move" toggle — dragging inside a selection only repositions
  //   it while this is on, so an accidental drag (e.g. while just trying to
  //   click/select something) can't shift a shape unintentionally. Stays on
  //   across multiple drags until clicked again, like a normal Move tool.
  const [moveArmed, setMoveArmed] = useState(false)

  // ← In-app "duplicate shape" clipboard — holds the actual traced geometry
  //   (points/pitch/material/etc, same shape as `sections`/`lineItems`/
  //   `ptItems`) of the current Select-tool selection, not an image. Paste
  //   re-inserts a copy with fresh ids, offset to wherever the user pastes —
  //   this stays entirely inside the canvas, never touching the OS clipboard.
  const [shapeClipboard, setShapeClipboard] = useState(null) // {sections,lines,points} | null
  const [pastePopup, setPastePopup] = useState(null) // {x,y (screen), worldPt} | null — right-click "Paste" popup
  const [shapeCopyMsg, setShapeCopyMsg] = useState("") // short confirmation label shown on the Copy/Paste buttons

  // ← Each confirmed reference line yields its own meters-per-pixel ratio;
  //   mPerPx is the average across all of them so a photo carrying more
  //   than one known dimension (or a re-drawn correction) improves accuracy
  //   instead of only ever trusting the single most recent line.
  const scaleRatios = useMemo(()=>{
    return scaleLines.map(l=>{
      const px = Math.hypot(l.p2.x-l.p1.x, l.p2.y-l.p1.y)
      return px>0 ? l.knownM/px : null
    }).filter(v=>v!=null)
  },[scaleLines])
  const mPerPx = useMemo(()=>{
    if(scaleRatios.length) return scaleRatios.reduce((a,b)=>a+b,0)/scaleRatios.length
    return restoredMPerPx // fallback for a restored project until the user redraws a reference line
  },[scaleRatios, restoredMPerPx])
  // ← How much the references disagree with each other, as a % of their
  //   average — a large spread usually means a typo (wrong unit, extra
  //   zero) in one of the entered lengths, so it's worth flagging.
  const scaleSpreadPct = useMemo(()=>{
    if(scaleRatios.length<2) return null
    const min=Math.min(...scaleRatios), max=Math.max(...scaleRatios)
    const avg=scaleRatios.reduce((a,b)=>a+b,0)/scaleRatios.length
    return avg>0 ? ((max-min)/avg)*100 : null
  },[scaleRatios])
  // ← A tilted/perspective photo can have a genuinely different real-world
  //   meters-per-pixel horizontally vs vertically — blending both into one
  //   averaged mPerPx then stretches one axis and compresses the other
  //   (this is what made a traced 12x12m square keep coming out non-square).
  //   When at least one clearly-horizontal AND one clearly-vertical
  //   reference both exist, compute their scales separately instead;
  //   otherwise fall back to the single-average behavior unchanged.
  const axisScale = useMemo(()=>{
    const horiz=[], vert=[]
    scaleLines.forEach(l=>{
      const dx=Math.abs(l.p2.x-l.p1.x), dy=Math.abs(l.p2.y-l.p1.y)
      if(dx>dy){ if(dx>0) horiz.push(l.knownM/dx) }
      else{ if(dy>0) vert.push(l.knownM/dy) }
    })
    if(!horiz.length || !vert.length) return null
    const avg = arr => arr.reduce((a,b)=>a+b,0)/arr.length
    return { x: avg(horiz), y: avg(vert) }
  },[scaleLines])

  const geometry = useMemo(()=>{
    const sfIso = mPerPx || 0.05
    // ← sfY is used as the single uniform scale in every existing formula
    //   below (area, length, clipping) — anisotropy is handled entirely by
    //   pre-squashing each point set's X-axis by (sfX/sfY) before calling
    //   those formulas, so polyAreaPx/linelenPx/sectionStripeInfo/
    //   clipSegmentToPolygon themselves stay completely unmodified. When
    //   axisScale is null (no anisotropic calibration yet), squashRatio is
    //   1 and this is identical to the previous single-sf behavior.
    const sfX = axisScale ? axisScale.x : sfIso
    const sfY = axisScale ? axisScale.y : sfIso
    const squashRatio = sfX/sfY
    const squash = pts => squashRatio===1 ? pts : pts.map(p=>({x:p.x*squashRatio, y:p.y}))
    // ← Letter only assigned to sections that actually produce sheets (a
    //   section with no pitch yet has sheets:[] and consumes no letter), so
    //   the exported Measurement Plan's A/B/C sequence stays gap-free
    //   instead of skipping a letter for an incomplete section.
    let sectionLetterCounter = 0
    const processedSections = sections.map((sec)=>{
      const sqPts = squash(sec.pts)
      const fpPx = sec.closed ? polyAreaPx(sqPts) : 0
      const fp   = fpPx*sfY*sfY
      // ← "Unknown Pitch" is now an explicit, real state (the Roof Pitch
      //   modal's own dedicated button) instead of silently falling back
      //   to a fake default multiplier — Surface Area and the cutting list
      //   are only meaningful once a real pitch exists, so both are
      //   skipped entirely here rather than computed against a guess.
      const pitchUnknown = !sec.pitch
      const fac  = pitchUnknown ? null : parsePitch(sec.pitch)
      const sheetWidthMm = sec.sheetWidthMm || 762
      // ← Direction priority: explicit per-section Cut Angle override, else
      //   auto-detect from the shape's own longest edge (inside
      //   sectionStripeInfo). Pitch is a slope-steepness angle, not a 2D
      //   bearing in the photo — it must never feed stripe direction (that
      //   coupling used to exist here and produced skewed cutting-list
      //   stripes on genuinely rectangular, correctly-traced sections).
      //   True (photo-space) angle is what's shown/restored in the UI;
      //   sectionStripeInfo needs the same angle re-expressed in the
      //   squashed space its points now live in, or the stripe direction
      //   would drift from what the slider/photo actually show.
      const trueAngleDeg = sec.cutAngleDeg ?? null
      const stripeAngleDeg = squashAngleDeg(trueAngleDeg, squashRatio)
      // ← The "last end" point of a manually-drawn cut-angle reference line
      //   (see the cutangle tool) — re-expressed in the same squashed space
      //   sqPts lives in, same reasoning as stripeAngleDeg above, so the
      //   stripe grid can be phase-shifted to actually pass through it.
      const sqCutAngleAnchor = sec.cutAngleAnchor ? squash([sec.cutAngleAnchor])[0] : null
      const stripeInfo = (sec.closed && !pitchUnknown) ? sectionStripeInfo(sqPts, (sheetWidthMm/1000)/sfY, stripeAngleDeg, sqCutAngleAnchor) : { stripes:[], count:0, perpLenPx:0, longestEdgePx:0 }
      // ← RoofSheet objects: each clipped stripe becomes a structured sheet
      //   (not just a bare length) so future features (grouping, purchase
      //   lists) can be built on this without redoing the clipping algorithm.
      // ← Clip points come back in the squashed space sqPts was built in —
      //   fine for the length math above, but drawCanvas draws these
      //   directly as canvas/photo coordinates, so they need un-squashing
      //   back to true photo space or the rendered stripes would land in
      //   the wrong place whenever anisotropic calibration is active.
      const unsquash = p => squashRatio===1 ? p : { x: p.x/squashRatio, y: p.y }
      // ← Automatically detected, not user-classified: real-world (not
      //   squashed-pixel) angles are what "rectangular" actually means, so
      //   classification runs on points scaled by their own true per-axis
      //   factors. A shape that passes this is treated as a uniform slope —
      //   every sheet the same length, count from the eave's overall span —
      //   which reuses dirLenPx/perpLenPx (simple min/max spans, not
      //   per-column clipping) and so is immune to the boundary-column
      //   sensitivity the tapered strategy is inherently exposed to. Any
      //   shortfall between sheet-count×cover-width and the true eave
      //   length is intentionally not tracked as a "trimmed" sheet — real
      //   installers just buy another full sheet and trim the excess width
      //   on site, so every sheet is reported at the same nominal cover
      //   width, matching that practice instead of computing a bespoke
      //   final width.
      const realPts = sec.pts.map(p=>({x:p.x*sfX, y:p.y*sfY}))
      const isUniformPlane = sec.closed && isRectangleLike(realPts)
      let sheets
      if(pitchUnknown){
        sheets = []
      } else if(isUniformPlane && stripeInfo.dir){
        const eaveLenPxPerSheet = (sheetWidthMm/1000)/sfY
        const count = Math.max(1, Math.ceil(stripeInfo.dirLenPx/eaveLenPxPerSheet - 1e-6))
        const uniformLenM = parseFloat((stripeInfo.perpLenPx*sfY*fac).toFixed(3))
        sheets = Array.from({length:count},(_,i)=>{
          const d0 = stripeInfo.dirMin + i*eaveLenPxPerSheet
          const p1 = { x:d0*stripeInfo.dir.x+stripeInfo.perpMin*stripeInfo.perp.x, y:d0*stripeInfo.dir.y+stripeInfo.perpMin*stripeInfo.perp.y }
          const p2 = { x:d0*stripeInfo.dir.x+stripeInfo.perpMax*stripeInfo.perp.x, y:d0*stripeInfo.dir.y+stripeInfo.perpMax*stripeInfo.perp.y }
          return {
            id: uid(), planeId: sec.id,
            manufacturer: sec.materialLabel||"", material: sec.materialLabel||"",
            coverWidthMm: sheetWidthMm,
            lengthM: uniformLenM,
            startPoint: unsquash(p1), endPoint: unsquash(p2),
            installationOrder: i+1,
          }
        })
      } else {
        sheets = stripeInfo.stripes.map((s,i)=>({
          id: s.id, planeId: sec.id,
          manufacturer: sec.materialLabel||"", material: sec.materialLabel||"",
          coverWidthMm: sheetWidthMm,
          lengthM: parseFloat((s.lengthPx*sfY*fac).toFixed(3)),
          startPoint: unsquash(s.startPoint), endPoint: unsquash(s.endPoint),
          installationOrder: i+1,
        }))
      }
      // ← Sheet codes (e.g. "A-S01") for the exported Measurement Plan only
      //   — see drawCanvas's pill label and getSnapshot's legend composite.
      //   Assigned here (not on-canvas) since installationOrder/section
      //   identity are already resolved at this point.
      let sectionCode = null
      if(sheets.length){
        sectionCode = String.fromCharCode(65+sectionLetterCounter)
        sectionLetterCounter++
        sheets = sheets.map(s=>({...s, sectionCode, sheetCode:`${sectionCode}-S${String(s.installationOrder).padStart(2,"0")}`}))
      }
      const sheet_lengths_m = sheets.map(s=>s.lengthM)
      // ← Perimeter/longest edge/centroid: available as soon as the
      //   polygon closes, independent of pitch — matches how a roof
      //   plane's flat geometry is known before its slope is assigned.
      const perimeter_m = sec.closed ? parseFloat((linelenPx([...sqPts, sqPts[0]])*sfY).toFixed(2)) : 0
      // ← Centroid stays in true (unsquashed) photo pixel space — it's used
      //   for canvas label placement, not a real-world measurement.
      const centroid = sec.pts.length ? {
        x: sec.pts.reduce((a,p)=>a+p.x,0)/sec.pts.length,
        y: sec.pts.reduce((a,p)=>a+p.y,0)/sec.pts.length,
      } : null
      return {
        id:sec.id, name:sec.name, pitch:sec.pitch,
        shape_points:sec.pts,
        pitchUnknown,
        footprint_m2: parseFloat(fp.toFixed(2)),
        surface_m2:   pitchUnknown ? null : parseFloat((fp*fac).toFixed(2)),
        pitchFactor:  pitchUnknown ? null : parseFloat(fac.toFixed(3)),
        perimeter_m,
        longestEdge_m: parseFloat((stripeInfo.longestEdgePx*sfY).toFixed(2)),
        centroid,
        materialLabel: sec.materialLabel||"", rate: sec.rate||0,
        sheetWidthMm,
        isUniformPlane,
        // ← Raw manual override (distinct from pitchAngleDeg below, which
        //   is the *resolved* direction whether from this override or
        //   auto-detection) — without exposing it here, initialSectionsFrom
        //   has nothing to restore and a manual Cut Angle silently reverts
        //   to auto-detected on remount.
        cutAngleDeg: sec.cutAngleDeg ?? null,
        cutAngleAnchor: sec.cutAngleAnchor ?? null,
        pitchAngleDeg: trueAngleDeg,
        sheet_count: stripeInfo.count,
        sheets,
        sheet_lengths_m,
        sheet_length_m: sheet_lengths_m.length ? Math.max(...sheet_lengths_m) : 0,
        sheetsTooMany: !!stripeInfo.tooMany,
        edges:[]
      }
    })
    // ← length_m stays the traced PLAN length. The slope correction for
    //   runs that follow the roof (1/cos θ) is applied downstream by
    //   flashingQtyM in the Estimate step — doing it here as well would
    //   multiply it in twice.
    const flashings = lineItems.filter(l=>l.type==="flashing").map(l=>({...l,length_m:parseFloat((linelenPx(squash(l.pts))*sfY).toFixed(2))}))
    const gutters   = lineItems.filter(l=>l.type==="gutter").map(l=>({...l,length_m:parseFloat((linelenPx(squash(l.pts))*sfY).toFixed(2))}))
    const downpipes = ptItems.filter(p=>p.type==="downpipe")
    const drains    = ptItems.filter(p=>p.type==="drain")
    const pens      = ptItems.filter(p=>p.type==="penetration")
    // ← Grouped by named run (ridge cap, valley, etc.) so each traced
    //   subtype can get its own length + supplier rate in the Estimate
    //   step, instead of one flat "flashings" total.
    const flashingBySubtype = {}
    const flashingPitchBySubtype = {}
    const flashingMaterialBySubtype = {}
    flashings.forEach(f=>{
      const key = f.subtype || "other"
      flashingBySubtype[key] = parseFloat(((flashingBySubtype[key]||0) + f.length_m).toFixed(2))
      // ← Same "first non-empty wins" rule as the brand below: pitch is set
      //   per subtype via the popup, so every run of a subtype should agree.
      //   Seeds the Estimate step's Roof Angle field, which is what actually
      //   applies the slope correction (via flashingQtyM).
      if(f.pitchDeg > 0 && flashingPitchBySubtype[key] == null) flashingPitchBySubtype[key] = f.pitchDeg
      // ← First non-empty pick for this subtype wins as the "traced"
      //   default — all segments of the same subtype get the same brand
      //   applied via the popup anyway, so they should already agree.
      if(f.materialLabel && !flashingMaterialBySubtype[key]) flashingMaterialBySubtype[key] = { materialLabel:f.materialLabel, rate:f.rate||0 }
    })
    return {
      sections: processedSections,
      accessories:{ flashings, gutters, downpipes, drains, penetrations:pens },
      flashingBySubtype,
      flashingPitchBySubtype,
      flashingMaterialBySubtype,
      asbestos,
      // ← Raw reference lines (not just the averaged scale_m_per_px below) —
      //   without this, initialScaleLinesFrom has nothing to restore and
      //   the visible calibration lines vanish on remount, even though the
      //   scale factor itself survives via the scale_m_per_px fallback.
      scaleLines,
      scale_m_per_px: parseFloat(sfIso.toFixed(6)),
      axisScale,
      // ← Dimension Tool reference lines — visual-only annotations, never
      //   used in any area/cost calculation above, but still need to be
      //   part of the persisted payload (and this memo's deps) or they'd
      //   silently vanish on save/reload, same reasoning as scaleLines.
      dimensionLines,
      total_footprint_m2: parseFloat(processedSections.reduce((a,sec)=>a+sec.footprint_m2,0).toFixed(2)),
      total_surface_m2:   parseFloat(processedSections.reduce((a,sec)=>a+(sec.surface_m2||0),0).toFixed(2)),
      total_flashing_m:   parseFloat(flashings.reduce((a,f)=>a+f.length_m,0).toFixed(2)),
      total_gutter_m:     parseFloat(gutters.reduce((a,g)=>a+g.length_m,0).toFixed(2)),
    }
  },[sections,lineItems,ptItems,asbestos,mPerPx,scaleLines,axisScale,dimensionLines])

  useEffect(()=>{ onGeometryChange?.(geometry) },[geometry, onGeometryChange])

  // ← Lets the wizard grab a PNG of the traced canvas (sections, labels, m²)
  //   to embed in the generated quote — mirrors the marked-up roof plan
  //   images attached in the reference quotation template.
  //   getOriginalPhoto returns the separate, UNDRAWN-ON photo so reopening
  //   this project later traces on a clean image rather than the flattened
  //   snapshot (which has the previous drawing baked into its pixels).
  //   Two shapes, since a photo arrives either way:
  //     · a freshly-picked local file → a `data:` URL needing upload
  //     · one chosen from the job photo library → already a hosted http(s)
  //       URL, so it's passed straight through with nothing to re-upload
  //   (that second case previously returned null, leaving job-photo projects
  //   with no original saved at all).
  useImperativeHandle(ref, () => ({
    // ← Redraws once with the on-screen "Upload a roof photo…" placeholder
    //   suppressed before capturing, then restores the normal view. That
    //   prompt is UI guidance for the person tracing; baking it into the
    //   saved PNG put it straight into the client-facing quote whenever a
    //   project had no photo.
    getSnapshot: () => {
      const cv = canvasRef.current
      if(!cv) return null
      snapshotModeRef.current = true
      drawCanvas()

      // ← Sheet-code legend, composed only into the exported snapshot (never
      //   the live canvas) — reflowing the live 490x330 canvas to reserve a
      //   permanent column would touch the pan/zoom/hit-testing math used
      //   throughout editing. Instead a second, wider canvas is built here
      //   just for export, with the already-rendered base canvas copied in
      //   via drawImage (canvas-to-canvas, synchronous — no data-URL/Image
      //   round trip needed).
      const legendSections = geometry.sections.filter(gs=>gs.sheets?.length)
      let url
      if(legendSections.length){
        const dprScale = cv.width / MT_CANVAS_W
        const legendW  = Math.round(130*dprScale)
        const rowH     = Math.round(13*dprScale)
        const padTop   = Math.round(14*dprScale)
        const headerFontPx = Math.round(10*dprScale)
        const rowFontPx    = Math.round(9*dprScale)
        const brandFontPx  = Math.round(9.5*dprScale)
        const maxTextW      = legendW - Math.round(18*dprScale)

        // ← Sections sharing the same picked brand/product are grouped under
        //   one wrapped brand-name heading (so "Armorsteel — 0.55bmt..." only
        //   prints once), with each section's own "SECTION A/B/C" + sheet
        //   codes nested underneath — a section with no brand chosen yet
        //   falls back to the old flat "SECTION X" listing with no heading.
        const composite = document.createElement("canvas")
        const cctx = composite.getContext("2d")
        const wrapLines = (text, font) => {
          cctx.font = font
          const words = text.split(" ")
          const lines = []
          let current = ""
          words.forEach(word=>{
            const test = current ? current+" "+word : word
            if(current && cctx.measureText(test).width>maxTextW){ lines.push(current); current = word }
            else current = test
          })
          if(current) lines.push(current)
          return lines
        }
        const groups = []
        const groupIndex = new Map()
        legendSections.forEach(ls=>{
          const key = ls.materialLabel || ""
          if(!groupIndex.has(key)){ groupIndex.set(key, groups.length); groups.push({ materialLabel:key, sections:[] }) }
          groups[groupIndex.get(key)].sections.push(ls)
        })
        const drawOps = []
        groups.forEach(g=>{
          const nested = !!g.materialLabel
          if(nested){
            wrapLines(g.materialLabel, `bold ${brandFontPx}px DM Sans`).forEach(line=>
              drawOps.push({ text:line, font:`bold ${brandFontPx}px DM Sans`, color:"#0f172a", indent:10 }))
          }
          g.sections.forEach(ls=>{
            drawOps.push({ text:`SECTION ${ls.sheets[0].sectionCode}`, font:`bold ${headerFontPx}px DM Sans`, color:"#1e293b", indent: nested?16:10 })
            ls.sheets.forEach(s=>
              drawOps.push({ text:`${s.sheetCode}   ${s.lengthM.toFixed(2)}m`, font:`${rowFontPx}px DM Sans`, color:"#334155", indent: nested?20:14 }))
          })
        })

        const legendH = padTop*2 + drawOps.length*rowH
        composite.width  = cv.width + legendW
        composite.height = Math.max(cv.height, legendH)
        cctx.fillStyle = "#ffffff"
        cctx.fillRect(0,0,composite.width,composite.height)
        cctx.textBaseline = "alphabetic"
        let y = padTop
        drawOps.forEach(op=>{
          cctx.font = op.font
          cctx.fillStyle = op.color
          cctx.fillText(op.text, Math.round(op.indent*dprScale), y)
          y += rowH
        })
        cctx.drawImage(cv, legendW, 0)
        url = composite.toDataURL("image/png")
      } else {
        url = cv.toDataURL("image/png")
      }

      snapshotModeRef.current = false
      drawCanvas()
      return url
    },
    getOriginalPhoto: () => {
      if(!imgSrc) return null
      return imgSrc.startsWith("data:")
        ? { dataUrl: imgSrc }
        : { url: imgSrc.replace(/^https?:\/\/[^/]+/, "") } // store app-relative, same as snapshot_url
    },
  }))

  // Screen (rendered CSS pixels) -> world (fixed MT_CANVAS_W x MT_CANVAS_H
  // drawing space), accounting for CSS scaling of the canvas element AND
  // the current zoom/pan view transform.
  const getWorldPt = useCallback((clientX, clientY) => {
    const cv = canvasRef.current
    const r = cv.getBoundingClientRect()
    const cssScaleX = MT_CANVAS_W / r.width
    const cssScaleY = MT_CANVAS_H / r.height
    const cvX = (clientX - r.left) * cssScaleX
    const cvY = (clientY - r.top)  * cssScaleY
    return { x: (cvX - view.offX) / view.zoom, y: (cvY - view.offY) / view.zoom }
  }, [view])

  function clampView(v) {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom))
    // ← Math.max(0, zoom-1) instead of a bare (zoom-1): below 100% zoom that
    //   term would go negative and invert these bounds (min > max), locking
    //   panning to a single fixed offset. Below 100% the content already
    //   fits the viewport, so it only needs the flat 0.3-canvas-width nudge
    //   margin, not additional pan range.
    const rangeX = MT_CANVAS_W * Math.max(0, zoom-1)
    const rangeY = MT_CANVAS_H * Math.max(0, zoom-1)
    const maxOffX = rangeX + MT_CANVAS_W*0.3
    const maxOffY = rangeY + MT_CANVAS_H*0.3
    const minOffX = -rangeX - MT_CANVAS_W*0.3
    const minOffY = -rangeY - MT_CANVAS_H*0.3
    return { zoom, offX: Math.min(maxOffX, Math.max(minOffX, v.offX)), offY: Math.min(maxOffY, Math.max(minOffY, v.offY)) }
  }

  function zoomAt(cvX, cvY, factor) {
    setView(prev=>{
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.zoom*factor))
      const worldX = (cvX - prev.offX) / prev.zoom
      const worldY = (cvY - prev.offY) / prev.zoom
      return clampView({ zoom:newZoom, offX: cvX - worldX*newZoom, offY: cvY - worldY*newZoom })
    })
  }
  function zoomButton(factor) { zoomAt(MT_CANVAS_W/2, MT_CANVAS_H/2, factor) }
  function resetView() { setView({ zoom:1, offX:0, offY:0 }) }

  // Space bar toggles temporary pan mode (Photoshop/Figma-style)
  useEffect(()=>{
    function onKeyDown(e){ if(e.code==="Space" && !e.repeat) setSpaceDown(true) }
    function onKeyUp(e){ if(e.code==="Space") setSpaceDown(false) }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    return ()=>{ window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp) }
  },[])

  const isPanMode = activeTool==="pan" || spaceDown

  function deleteSelected() {
    pushHistory()
    if(selection.sections.length) setSections(prev=>prev.filter(s=>!selection.sections.includes(s.id)))
    if(selection.lines.length)    setLineItems(prev=>prev.filter(l=>!selection.lines.includes(l.id)))
    if(selection.points.length)   setPtItems(prev=>prev.filter(p=>!selection.points.includes(p.id)))
    if(selection.scale)           setScaleLine(null)
    if(selection.scaleLineIds.length) setScaleLines(prev=>prev.filter(l=>!selection.scaleLineIds.includes(l.id)))
    if(selection.dimensionLineIds.length) setDimensionLines(prev=>prev.filter(l=>!selection.dimensionLineIds.includes(l.id)))
    setSelection({ sections:[], lines:[], points:[], scale:false, scaleLineIds:[], dimensionLineIds:[] })
  }

  // Snapshots the currently-selected sections/lines/points (their full
  // geometry + attributes, not an image) into shapeClipboard, ready for
  // pasteShapes() to duplicate. Scale-calibration lines aren't copyable —
  // there should only ever be one calibration, not duplicates of it.
  function copySelectedShapes() {
    const copiedSections = sections.filter(s=>selection.sections.includes(s.id))
    const copiedLines    = lineItems.filter(l=>selection.lines.includes(l.id))
    const copiedPoints   = ptItems.filter(p=>selection.points.includes(p.id))
    if(!copiedSections.length && !copiedLines.length && !copiedPoints.length) return
    setShapeClipboard({ sections: copiedSections, lines: copiedLines, points: copiedPoints })
    setShapeCopyMsg("Copied!")
    setTimeout(()=>setShapeCopyMsg(""), 2000)
  }

  // Duplicates whatever's in shapeClipboard onto the canvas, translated so
  // the copied shapes' centroid lands on `worldPt` (the right-click/paste
  // location) — or offset a fixed amount from the originals when pasted via
  // Ctrl+V with no specific target point. Fresh ids throughout so the
  // duplicate is a fully independent, separately-editable shape.
  function pasteShapes(worldPt) {
    if(!shapeClipboard) return
    const { sections: cSections, lines: cLines, points: cPoints } = shapeClipboard
    const allPts = [
      ...cSections.flatMap(s=>s.pts),
      ...cLines.flatMap(l=>l.pts),
      ...cPoints.map(p=>({x:p.x, y:p.y})),
    ]
    if(!allPts.length) return
    const cx = allPts.reduce((a,p)=>a+p.x,0) / allPts.length
    const cy = allPts.reduce((a,p)=>a+p.y,0) / allPts.length
    const dx = worldPt ? worldPt.x - cx : 20
    const dy = worldPt ? worldPt.y - cy : 20

    pushHistory()
    const newSections = cSections.map(s=>({ ...s, id: uid(), pts: s.pts.map(p=>({x:p.x+dx,y:p.y+dy})) }))
    const newLines    = cLines.map(l=>({ ...l, id: uid(), pts: l.pts.map(p=>({x:p.x+dx,y:p.y+dy})) }))
    const newPoints   = cPoints.map(p=>({ ...p, id: uid(), x:p.x+dx, y:p.y+dy }))
    if(newSections.length) setSections(prev=>[...prev, ...newSections])
    if(newLines.length)    setLineItems(prev=>[...prev, ...newLines])
    if(newPoints.length)   setPtItems(prev=>[...prev, ...newPoints])

    // Select the freshly-pasted copy so it's immediately obvious what
    // happened, and ready to drag into its final position right away.
    setActiveTool("select")
    setSelection({
      sections: newSections.map(s=>s.id),
      lines:    newLines.map(l=>l.id),
      points:   newPoints.map(p=>p.id),
      scale: false, scaleLineIds: [], dimensionLineIds: [],
    })
    setShapeCopyMsg("Pasted!")
    setTimeout(()=>setShapeCopyMsg(""), 2000)
  }

  // Delete/Backspace removes the current marquee selection (Select tool only)
  useEffect(()=>{
    function onKeyDown(e){
      if(activeTool==="select" && (e.key==="Delete"||e.key==="Backspace") && selectionCount>0){
        e.preventDefault(); deleteSelected()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return ()=>window.removeEventListener("keydown", onKeyDown)
  },[activeTool, selection])

  // Ctrl/Cmd+C copies the current Select-tool selection's geometry (not an
  // image) into shapeClipboard; Ctrl/Cmd+V pastes a duplicate centered on
  // the last-known cursor position (hoverPt). Ctrl+C only intercepted when
  // something is actually selected, so normal text copy elsewhere on the
  // page (e.g. in an input) isn't hijacked.
  useEffect(()=>{
    function onKeyDown(e){
      const tag = e.target?.tagName
      if(tag==="INPUT" || tag==="TEXTAREA" || tag==="SELECT") return
      const key = e.key.toLowerCase()
      if((e.ctrlKey||e.metaKey) && key==="c" && selectionCount>0){
        e.preventDefault(); copySelectedShapes()
      } else if((e.ctrlKey||e.metaKey) && key==="v" && shapeClipboard){
        e.preventDefault(); pasteShapes(hoverPt)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return ()=>window.removeEventListener("keydown", onKeyDown)
  },[selection, selectionCount, shapeClipboard, hoverPt, sections, lineItems, ptItems])

  // Ctrl/Cmd+Z undoes the last point/line/action; Ctrl/Cmd+Shift+Z or
  // Ctrl+Y redoes it — skipped while typing in a field (e.g. the
  // scale-calibration input) so native text-undo still works there.
  useEffect(()=>{
    function onKeyDown(e){
      const tag = e.target?.tagName
      if(tag==="INPUT" || tag==="TEXTAREA" || tag==="SELECT") return
      const key = e.key.toLowerCase()
      if((e.ctrlKey||e.metaKey) && key==="z"){
        e.preventDefault()
        if(e.shiftKey) redo(); else undo()
      } else if((e.ctrlKey||e.metaKey) && key==="y"){
        e.preventDefault(); redo()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return ()=>window.removeEventListener("keydown", onKeyDown)
  },[])

  // Escape dismisses the Flashing/Gutter "New Line / Stop" popup, or the
  // right-click "Paste" popup, without taking any action.
  useEffect(()=>{
    if(!lineContextMenu && !pastePopup) return
    function onKeyDown(e){ if(e.key==="Escape"){ setLineContextMenu(null); setPastePopup(null) } }
    window.addEventListener("keydown", onKeyDown)
    return ()=>window.removeEventListener("keydown", onKeyDown)
  },[lineContextMenu, pastePopup])

  const drawCanvas = useCallback(()=>{
    const cv=canvasRef.current; if(!cv)return
    const ctx=cv.getContext("2d")
    ctx.setTransform(1,0,0,1,0,0)
    ctx.clearRect(0,0,cv.width,cv.height)
    // ← Fixed white backdrop, drawn before the pan/zoom transform below (raw
    //   device-pixel space) so it always fully covers the canvas regardless
    //   of view.zoom/offX/offY — otherwise, zoomed out with no photo loaded,
    //   the old MT_CANVAS_W×MT_CANVAS_H fill (inside the transform) shrinks
    //   smaller than the visible canvas and exposes whatever's behind it.
    //   Only the photo/drawing themselves should zoom/pan, not this backdrop.
    ctx.fillStyle="#fff"
    ctx.fillRect(0,0,cv.width,cv.height)
    ctx.save()
    // ← Backing store is now sized to the canvas's actual displayed CSS size
    //   × devicePixelRatio (see the resize effect below), not the fixed
    //   MT_CANVAS_W×MT_CANVAS_H logical size — this scale maps everything
    //   drawn below (still in that same 0..MT_CANVAS_W/0..MT_CANVAS_H space)
    //   onto the full higher-resolution backing store instead of a small
    //   bitmap that the browser would otherwise blur while upscaling.
    const dprScale = cv.width / MT_CANVAS_W
    ctx.scale(dprScale, dprScale)
    ctx.translate(view.offX, view.offY)
    ctx.scale(view.zoom, view.zoom)
    const lw = px=>px/view.zoom // keep stroke/point sizes visually constant across zoom levels
    const sf = mPerPx || 0.05
    // ← One tick + total-length label at the very end of a Draw/Flashing/
    //   Gutter line (traced or still in-progress) — a repeated label at
    //   every whole metre reads cluttered/unprofessional in front of a
    //   client, so only the final measurement is shown, same as a normal
    //   dimension annotation.
    const drawMeterTicks = (pts) => {
      if(pts.length<2 || sf<=0) return
      const totalLenM = linelenPx(pts)*sf
      if(totalLenM<0.05) return
      const end=pts[pts.length-1], prev=pts[pts.length-2]
      const segLen = Math.hypot(end.x-prev.x, end.y-prev.y)
      const dir = segLen>0 ? {x:(end.x-prev.x)/segLen,y:(end.y-prev.y)/segLen} : {x:1,y:0}
      const perp = { x:-dir.y, y:dir.x }
      ctx.strokeStyle="rgba(255,255,255,0.85)"; ctx.lineWidth=lw(1.5)
      ctx.beginPath()
      ctx.moveTo(end.x-perp.x*lw(5), end.y-perp.y*lw(5))
      ctx.lineTo(end.x+perp.x*lw(5), end.y+perp.y*lw(5))
      ctx.stroke()
      const label = `${totalLenM.toFixed(2)}m`
      const lx = end.x+perp.x*lw(11), ly = end.y+perp.y*lw(11)
      ctx.font=`600 ${8/view.zoom}px DM Sans`; ctx.textAlign="center"; ctx.textBaseline="middle"
      const boxW = ctx.measureText(label).width+lw(6), boxH=lw(11)
      ctx.fillStyle="rgba(15,23,42,0.75)"
      try{ ctx.beginPath(); ctx.roundRect(lx-boxW/2, ly-boxH/2, boxW, boxH, lw(3)); ctx.fill() }
      catch{ ctx.fillRect(lx-boxW/2, ly-boxH/2, boxW, boxH) }
      ctx.fillStyle="#fff"
      ctx.fillText(label, lx, ly)
    }

    if(imgRef.current){ ctx.drawImage(imgRef.current,0,0,MT_CANVAS_W,MT_CANVAS_H) }
    else if(!snapshotModeRef.current){
      // ← No separate fill needed here anymore — the fixed white backdrop
      //   drawn above (outside the pan/zoom transform) already covers this.
      //   Skipped entirely during snapshot capture: this is an on-screen
      //   prompt for whoever's tracing, not something a client should see
      //   printed across the roof plan in their quote.
      ctx.fillStyle="rgba(15,23,42,0.35)"; ctx.font=`${12/view.zoom}px DM Sans`; ctx.textAlign="center"
      ctx.fillText("Upload a roof photo or aerial image above",MT_CANVAS_W/2,MT_CANVAS_H/2-10)
      ctx.fillText("then click to trace sections, flashings & accessories",MT_CANVAS_W/2,MT_CANVAS_H/2+10)
    }

    sections.forEach((sec,idx)=>{
      if(!sec.pts.length || hiddenSections[sec.id]) return
      const col=sec.color
      ctx.strokeStyle=col; ctx.lineWidth=lw(2)
      ctx.setLineDash(sec.closed?[]:[lw(6),lw(3)])
      ctx.beginPath(); ctx.moveTo(sec.pts[0].x,sec.pts[0].y)
      sec.pts.forEach(p=>ctx.lineTo(p.x,p.y))
      if(sec.closed) ctx.closePath()
      ctx.stroke()
      ctx.setLineDash([])
      // ← Point markers drawn before the perimeter length tick/label below,
      //   so that label's dark pill always paints on top of a corner marker
      //   instead of being partly hidden under it — for a closed section the
      //   total-length label anchors right at the start/close corner, and
      //   the bigger i===0 marker circle used to be drawn afterward, on top,
      //   covering part of the digits (e.g. "38.15m" reading as "3.15m").
      sec.pts.forEach((p,i)=>{
        ctx.fillStyle=i===0?col:"#fff"; ctx.beginPath(); ctx.arc(p.x,p.y,lw(i===0?5:3),0,Math.PI*2); ctx.fill()
        ctx.strokeStyle=editMode?"#fff88f":col; ctx.lineWidth=lw(editMode?2.5:1.5); ctx.beginPath(); ctx.arc(p.x,p.y,lw(i===0?5:3),0,Math.PI*2); ctx.stroke()
      })
      // ← Same metre tick marks as Flashing/Gutter — include the closing
      //   edge (back to the first point) for a closed section so the
      //   ticks wrap all the way around the outline, not just the open path.
      drawMeterTicks(sec.closed ? [...sec.pts, sec.pts[0]] : sec.pts)

      const gs=geometry.sections[idx]

      // ← Pre-compute the name/area label's footprint here (before stripes
      //   are drawn below) so stripe-length pills can be skipped wherever
      //   they'd sit under that label instead of overlapping it.
      let nameRect=null
      if(sec.closed){
        const cx0=gs?.centroid?.x ?? sec.pts.reduce((a,p)=>a+p.x,0)/sec.pts.length
        const cy0=gs?.centroid?.y ?? sec.pts.reduce((a,p)=>a+p.y,0)/sec.pts.length
        const fontPx0 = 9/view.zoom
        ctx.font=`bold ${fontPx0}px DM Sans`; ctx.textAlign="center"
        const label0 = sec.name||`Sec ${idx+1}`
        const maxTextW0 = lw(110)
        const words0 = label0.split(" ")
        const lines0 = []
        let current0 = ""
        words0.forEach(word=>{
          const test = current0 ? current0+" "+word : word
          if(current0 && ctx.measureText(test).width>maxTextW0){ lines0.push(current0); current0 = word }
          else current0 = test
        })
        if(current0) lines0.push(current0)
        if(lines0.length>3){
          lines0.length = 3
          let last = lines0[2]
          while(last.length>1 && ctx.measureText(last+"…").width>maxTextW0) last = last.slice(0,-1)
          lines0[2] = last+"…"
        }
        const lineH0 = lw(11)
        const boxH0 = lines0.length*lineH0 + lw(8)
        const boxW0 = Math.max(lw(72), maxTextW0)
        nameRect = { x1:cx0-boxW0/2-lw(6), y1:cy0-boxH0/2-lw(6), x2:cx0+boxW0/2+lw(6), y2:cy0+boxH0/2+lw(16) }
      }

      // ← Cutting-list stripes/pills only drawn on canvas when this
      //   section's sidebar "Cutting list" panel is expanded — previously
      //   always-on for every section, which on a busy multi-plane roof
      //   (several sections traced close together) meant every sheet's
      //   length pill from every section rendered simultaneously, totally
      //   cluttering the photo. Reuses the same expand state the sidebar
      //   panel already has, so expanding one section's list there also
      //   reveals it here. Snapshot capture (the exported Measurement Plan)
      //   forces every section's pills on regardless of that toggle — sheet
      //   codes are meant to always be on the on-site reference, live
      //   editing keeps the opt-in clutter control.
      if(sec.closed && sec.pts.length>=3 && gs?.sheets?.length && (expandedCutSections[sec.id] || snapshotModeRef.current)){
        const sheets = gs.sheets
        {
          ctx.save()
          ctx.beginPath(); ctx.moveTo(sec.pts[0].x,sec.pts[0].y)
          sec.pts.forEach(p=>ctx.lineTo(p.x,p.y))
          ctx.closePath(); ctx.clip()
          ctx.strokeStyle="rgba(15,23,42,0.6)"; ctx.lineWidth=lw(1)
          ctx.setLineDash([lw(3),lw(3)])
          sheets.forEach(s=>{ ctx.beginPath(); ctx.moveTo(s.startPoint.x,s.startPoint.y); ctx.lineTo(s.endPoint.x,s.endPoint.y); ctx.stroke() })
          ctx.setLineDash([])
          ctx.restore()

          // ── per-sheet length pill, anchored near the top of each cut so
          //   it doesn't collide with the section-name box in the middle ──
          const inRect = (x,y) => nameRect && x>=nameRect.x1 && x<=nameRect.x2 && y>=nameRect.y1 && y<=nameRect.y2
          sheets.forEach(s=>{
            const top = s.startPoint.y<=s.endPoint.y ? s.startPoint : s.endPoint
            const bot = s.startPoint.y<=s.endPoint.y ? s.endPoint : s.startPoint
            // ← Try near the top first; if that spot sits under the name
            //   label, try progressively further down the stripe instead
            //   of drawing on top of it. Skip the label entirely if every
            //   candidate spot is covered (very small/narrow section).
            const candidates=[0.16,0.32,0.84,0.92]
            let t = candidates.find(tt=>!inRect(top.x+(bot.x-top.x)*tt, top.y+(bot.y-top.y)*tt))
            if(t==null) return
            const ax = top.x + (bot.x-top.x)*t
            const ay = top.y + (bot.y-top.y)*t
            let ang = Math.atan2(bot.y-top.y, bot.x-top.x)
            if(ang>Math.PI/2) ang-=Math.PI; else if(ang<-Math.PI/2) ang+=Math.PI
            const label = s.sheetCode || `${s.lengthM.toFixed(2)}m`
            ctx.save()
            ctx.translate(ax,ay); ctx.rotate(ang)
            const fontPx=9/view.zoom
            ctx.font=`600 ${fontPx}px DM Sans`; ctx.textAlign="center"; ctx.textBaseline="middle"
            const padX=lw(5), padY=lw(2.5)
            const boxW=ctx.measureText(label).width+padX*2, boxH=fontPx+padY*2
            ctx.fillStyle="rgba(255,255,255,0.94)"
            ctx.strokeStyle="rgba(15,23,42,0.12)"; ctx.lineWidth=lw(1)
            ctx.beginPath()
            try{ ctx.roundRect(-boxW/2,-boxH/2,boxW,boxH,lw(3)) }
            catch{ ctx.rect(-boxW/2,-boxH/2,boxW,boxH) }
            ctx.fill(); ctx.stroke()
            ctx.fillStyle="#1e293b"
            ctx.fillText(label,0,0)
            ctx.restore()
          })
        }
      }
      if(sec.closed){
        const cx=gs?.centroid?.x ?? sec.pts.reduce((a,p)=>a+p.x,0)/sec.pts.length
        const cy=gs?.centroid?.y ?? sec.pts.reduce((a,p)=>a+p.y,0)/sec.pts.length
        // ← Once a brand is picked, sec.name is the full supplier/product
        //   string (can be long) instead of "Section N" — word-wrapped onto
        //   several smaller lines (canvas text doesn't wrap on its own) so
        //   the whole name stays readable instead of being cut short with
        //   "…". Box grows to fit the wrapped lines, capped at maxLines with
        //   only that last line ellipsized as a safety net for one very
        //   long unbroken word that still can't fit.
        const fontPx = 9/view.zoom
        ctx.font=`bold ${fontPx}px DM Sans`; ctx.textAlign="center"
        const label = sec.name||`Sec ${idx+1}`
        const maxTextW = lw(110)
        const maxLines = 3
        const words = label.split(" ")
        const lines = []
        let current = ""
        words.forEach(word=>{
          const test = current ? current+" "+word : word
          if(current && ctx.measureText(test).width>maxTextW){ lines.push(current); current = word }
          else current = test
        })
        if(current) lines.push(current)
        if(lines.length>maxLines){
          lines.length = maxLines
          let last = lines[maxLines-1]
          while(last.length>1 && ctx.measureText(last+"…").width>maxTextW) last = last.slice(0,-1)
          lines[maxLines-1] = last+"…"
        }
        const lineH = lw(11)
        const boxH = lines.length*lineH + lw(8)
        ctx.save()
        // ← Shadow alone isn't enough on light patches of the photo (white
        //   roofing, concrete, etc.) — a dark outline stroke behind the
        //   white fill guarantees contrast no matter what's underneath.
        ctx.shadowColor="rgba(0,0,0,0.9)"; ctx.shadowBlur=lw(8); ctx.shadowOffsetY=lw(1)
        ctx.lineJoin="round"; ctx.strokeStyle="rgba(0,0,0,0.85)"; ctx.lineWidth=lw(3)
        ctx.textBaseline="middle"
        const firstLineY = cy-boxH/2+lineH/2
        lines.forEach((line,li)=>{
          ctx.strokeText(line,cx,firstLineY+li*lineH)
          ctx.fillStyle="#fff"
          ctx.fillText(line,cx,firstLineY+li*lineH)
        })
        ctx.textBaseline="alphabetic"
        if(gs?.pitchUnknown || gs?.surface_m2){
          ctx.font=`bold ${9/view.zoom}px DM Sans`
          const areaLabel = gs.pitchUnknown ? "⚠ Pitch not set" : `${gs.surface_m2} m² @ ${Math.round(deriveSectionPitchInput(gs.pitch)?.angleDeg ?? 0)}°`
          const areaY = cy+boxH/2+lw(11)
          ctx.lineWidth=lw(2.5)
          ctx.strokeText(areaLabel,cx,areaY)
          ctx.fillStyle="#fff"
          ctx.fillText(areaLabel,cx,areaY)
        }
        ctx.restore()
      }
    })

    if(activeTool==="section"&&drawPts.length>0){
      const col=SEC_COLORS[sections.length%SEC_COLORS.length]
      // ← "closing snap": cursor is near the first point, close enough that a
      //   click would close the shape (matches the d<15 threshold in handleClick)
      const isClosing = drawPts.length>=3 && hoverPt && Math.hypot(hoverPt.x-drawPts[0].x,hoverPt.y-drawPts[0].y)<15
      // ← The closing check above always uses the raw cursor position (so
      //   "am I near the first point" isn't thrown off by snapping) — this
      //   is the point actually used to draw the rubber-band preview, so a
      //   click lands exactly where the preview showed.
      const previewHoverPt = (hoverPt && orthoMode && !isClosing) ? orthoSnap(hoverPt, drawPts[drawPts.length-1]) : hoverPt

      // Live translucent fill — a "shadow" of the enclosed area that grows as
      // points are placed, instead of only appearing once the shape is closed.
      if(drawPts.length>=3){
        ctx.beginPath(); ctx.moveTo(drawPts[0].x,drawPts[0].y)
        drawPts.forEach(p=>ctx.lineTo(p.x,p.y))
        if(previewHoverPt && !isClosing) ctx.lineTo(previewHoverPt.x,previewHoverPt.y)
        ctx.closePath()
        ctx.fillStyle=col+"2a"
        ctx.fill()
      }

      ctx.strokeStyle=col; ctx.lineWidth=lw(2)
      ctx.setLineDash(isClosing?[]:[lw(6),lw(3)])
      ctx.beginPath(); ctx.moveTo(drawPts[0].x,drawPts[0].y)
      drawPts.forEach(p=>ctx.lineTo(p.x,p.y))
      if(previewHoverPt) ctx.lineTo(isClosing?drawPts[0].x:previewHoverPt.x, isClosing?drawPts[0].y:previewHoverPt.y)
      ctx.stroke(); ctx.setLineDash([])
      // ← Live tick marks while still tracing — same treatment as
      //   Flashing/Gutter, following the same endpoint the preview line
      //   itself uses (snapped to the start point while closing).
      if(previewHoverPt) drawMeterTicks([...drawPts, isClosing?drawPts[0]:previewHoverPt])
      else drawMeterTicks(drawPts)
      drawPts.forEach((p,i)=>{
        ctx.fillStyle=i===0?col:"#fff"; ctx.beginPath(); ctx.arc(p.x,p.y,lw(i===0?6:3.5),0,Math.PI*2); ctx.fill()
        if(i===0){
          ctx.strokeStyle=isClosing?"#ffffff":"#fff88f"
          ctx.lineWidth=lw(isClosing?2.5:1.5)
          ctx.globalAlpha=isClosing?1:0.6
          ctx.beginPath();ctx.arc(p.x,p.y,lw(isClosing?12:10),0,Math.PI*2);ctx.stroke()
          ctx.globalAlpha=1
        }
      })
    }

    lineItems.forEach(li=>{
      ctx.strokeStyle=li.type==="flashing"?"#f59e0b":"#06b6d4"
      ctx.lineWidth=lw(2.5); ctx.setLineDash(li.type==="flashing"?[lw(8),lw(4)]:[lw(4),lw(2)])
      ctx.beginPath(); li.pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y)); ctx.stroke()
      ctx.setLineDash([])
      li.pts.forEach(p=>{
        ctx.fillStyle=li.type==="flashing"?"#f59e0b":"#06b6d4";ctx.beginPath();ctx.arc(p.x,p.y,lw(3),0,Math.PI*2);ctx.fill()
        if(editMode){ ctx.strokeStyle="#fff88f"; ctx.lineWidth=lw(1.5); ctx.beginPath(); ctx.arc(p.x,p.y,lw(5),0,Math.PI*2); ctx.stroke() }
      })
      if(li.type==="flashing"||li.type==="gutter") drawMeterTicks(li.pts)
    })

    if((activeTool==="flashing"||activeTool==="gutter")&&drawPts.length>0){
      const col=activeTool==="flashing"?"#f59e0b":"#06b6d4"
      ctx.strokeStyle=col; ctx.lineWidth=lw(2.5); ctx.setLineDash(activeTool==="flashing"?[lw(8),lw(4)]:[lw(4),lw(2)])
      const previewHoverPt = (hoverPt && orthoMode) ? orthoSnap(hoverPt, drawPts[drawPts.length-1]) : hoverPt
      const previewPts = previewHoverPt ? [...drawPts, previewHoverPt] : drawPts
      ctx.beginPath(); ctx.moveTo(previewPts[0].x,previewPts[0].y)
      previewPts.forEach(p=>ctx.lineTo(p.x,p.y))
      ctx.stroke(); ctx.setLineDash([])
      // ← Live tick marks while still drawing — so the metre count is
      //   visible as the run is being traced, not only after Done ✓.
      drawMeterTicks(previewPts)
    }

    ptItems.forEach(pi=>{
      if(pi.type==="downpipe"){
        ctx.fillStyle="#0ea5e9"; ctx.strokeStyle=editMode?"#fff88f":"#0284c7"; ctx.lineWidth=lw(1.5)
        ctx.beginPath(); ctx.arc(pi.x,pi.y,lw(8),0,Math.PI*2); ctx.fill(); ctx.stroke()
        ctx.fillStyle="#fff"; ctx.font=`bold ${7/view.zoom}px DM Sans`; ctx.textAlign="center"; ctx.fillText("DP",pi.x,pi.y+lw(3))
      } else if(pi.type==="drain"){
        ctx.fillStyle="#6366f1"; ctx.strokeStyle=editMode?"#fff88f":"#4f46e5"; ctx.lineWidth=lw(1.5)
        ctx.beginPath(); ctx.arc(pi.x,pi.y,lw(8),0,Math.PI*2); ctx.fill(); ctx.stroke()
        ctx.fillStyle="#fff"; ctx.font=`bold ${7/view.zoom}px DM Sans`; ctx.textAlign="center"; ctx.fillText("DR",pi.x,pi.y+lw(3))
      } else if(pi.type==="penetration"){
        const col=PEN_COLORS[pi.subtype]||"#8b5cf6"
        ctx.fillStyle=col; ctx.strokeStyle=editMode?"#fff88f":"#fff"; ctx.lineWidth=lw(1.5)
        ctx.beginPath(); const r=lw(7)
        ctx.moveTo(pi.x,pi.y-r);ctx.lineTo(pi.x+r,pi.y);ctx.lineTo(pi.x,pi.y+r);ctx.lineTo(pi.x-r,pi.y)
        ctx.closePath(); ctx.fill(); ctx.stroke()
        ctx.fillStyle="#fff"; ctx.font=`bold ${7/view.zoom}px DM Sans`; ctx.textAlign="center"
        ctx.fillText(pi.subtype[0].toUpperCase(),pi.x,pi.y+lw(2.5))
      }
    })

    // ← A plain round endpoint dot, not a perpendicular cross-stroke — a
    //   fixed vertical tick looked fine on a vertical calibration line but
    //   read as a confusing extra little line sticking out of a horizontal
    //   one (it never rotated to match the line's own direction).
    const tick=p=>{ctx.beginPath();ctx.arc(p.x,p.y,lw(4),0,Math.PI*2);ctx.fillStyle="#10b981";ctx.fill();ctx.strokeStyle="#fff";ctx.lineWidth=lw(1.5);ctx.stroke()}
    const drawScaleLabel=(p1,p2,text)=>{
      const mx=(p1.x+p2.x)/2,my=(p1.y+p2.y)/2
      ctx.fillStyle="#10b981"
      try{ctx.beginPath();ctx.roundRect(mx-lw(22),my-lw(10),lw(44),lw(16),lw(4));ctx.fill()}catch{ctx.fillRect(mx-lw(22),my-lw(10),lw(44),lw(16))}
      ctx.fillStyle="#fff"; ctx.font=`bold ${10/view.zoom}px DM Sans`; ctx.textAlign="center"
      ctx.fillText(text,mx,my+lw(1))
    }
    // ← Every confirmed calibration reference is drawn, not just the most
    //   recent one — a photo can carry several known dimensions.
    scaleLines.forEach(l=>{
      ctx.strokeStyle="#10b981"; ctx.lineWidth=lw(2.5); ctx.setLineDash([])
      ctx.beginPath(); ctx.moveTo(l.p1.x,l.p1.y); ctx.lineTo(l.p2.x,l.p2.y); ctx.stroke()
      tick(l.p1); tick(l.p2)
      drawScaleLabel(l.p1,l.p2,`${l.knownM}m`)
    })
    if(scaleLine?.p1){
      ctx.strokeStyle="#10b981"; ctx.lineWidth=lw(2.5); ctx.setLineDash([])
      ctx.beginPath(); ctx.moveTo(scaleLine.p1.x,scaleLine.p1.y)
      const p2=scaleLine.p2||(activeTool==="scale"?hoverPt:null)
      if(p2) ctx.lineTo(p2.x,p2.y)
      ctx.stroke()
      tick(scaleLine.p1)
      if(scaleLine.p2){
        tick(scaleLine.p2)
        // Still being confirmed in the modal — no length known yet for
        // this specific line, so show a placeholder rather than a number
        // that looks like it's already been measured.
        drawScaleLabel(scaleLine.p1,scaleLine.p2,"? m")
      }
    }

    if(cutAngleLine?.p1){
      const p2 = cutAngleLine.p2||(activeTool==="cutangle"?hoverPt:null)
      ctx.strokeStyle="#8b5cf6"; ctx.lineWidth=lw(2.5); ctx.setLineDash([lw(6),lw(3)])
      ctx.beginPath(); ctx.moveTo(cutAngleLine.p1.x,cutAngleLine.p1.y)
      if(p2) ctx.lineTo(p2.x,p2.y)
      ctx.stroke(); ctx.setLineDash([])
      tick(cutAngleLine.p1)
      if(p2){
        tick(p2)
        const dx=p2.x-cutAngleLine.p1.x, dy=p2.y-cutAngleLine.p1.y
        const liveAngle = ((Math.atan2(dy,dx)*180/Math.PI)%180+180)%180
        const mx=(cutAngleLine.p1.x+p2.x)/2, my=(cutAngleLine.p1.y+p2.y)/2
        ctx.fillStyle="#8b5cf6"
        try{ctx.beginPath();ctx.roundRect(mx-lw(22),my-lw(10),lw(44),lw(16),lw(4));ctx.fill()}catch{ctx.fillRect(mx-lw(22),my-lw(10),lw(44),lw(16))}
        ctx.fillStyle="#fff"; ctx.font=`bold ${10/view.zoom}px DM Sans`; ctx.textAlign="center"
        ctx.fillText(`${liveAngle.toFixed(1)}°`,mx,my+lw(1))
      }
    }

    // ← Dimension Tool (PlanSwift-style click-two-points reference
    //   measurement) — deliberately styled differently from every other
    //   line on this canvas (light gray, solid, architectural T-bar end
    //   caps) so it reads as an added annotation, not a traced/priced shape
    //   or the automatic edge-length labels every section/line already
    //   shows. Length is read straight off the same calibrated scale (`sf`)
    //   as everywhere else — no separate calibration, and it carries no
    //   rate/cost so it never touches the estimate.
    const dimTick=(p,dir)=>{
      const perp={x:-dir.y,y:dir.x}, len=lw(6)
      ctx.beginPath()
      ctx.moveTo(p.x-perp.x*len,p.y-perp.y*len)
      ctx.lineTo(p.x+perp.x*len,p.y+perp.y*len)
      ctx.stroke()
    }
    const dimLineDir=(p1,p2)=>{
      const dx=p2.x-p1.x, dy=p2.y-p1.y, len=Math.hypot(dx,dy)
      return len>0 ? {x:dx/len,y:dy/len} : {x:1,y:0}
    }
    const drawDimLabel=(p1,p2,text)=>{
      const mx=(p1.x+p2.x)/2,my=(p1.y+p2.y)/2
      ctx.fillStyle="#ec4899"
      const boxW=Math.max(lw(30),ctx.measureText(text).width+lw(12))
      try{ctx.beginPath();ctx.roundRect(mx-boxW/2,my-lw(10),boxW,lw(16),lw(4));ctx.fill()}catch{ctx.fillRect(mx-boxW/2,my-lw(10),boxW,lw(16))}
      ctx.fillStyle="#fff"; ctx.font=`bold ${10/view.zoom}px DM Sans`; ctx.textAlign="center"
      ctx.fillText(text,mx,my+lw(1))
    }
    dimensionLines.forEach(l=>{
      if(hiddenDimensionLines[l.id]) return
      ctx.strokeStyle="#94a3b8"; ctx.lineWidth=lw(1.25)
      ctx.beginPath(); ctx.moveTo(l.p1.x,l.p1.y); ctx.lineTo(l.p2.x,l.p2.y); ctx.stroke()
      const dir=dimLineDir(l.p1,l.p2)
      dimTick(l.p1,dir); dimTick(l.p2,dir)
      const distM = Math.hypot(l.p2.x-l.p1.x,l.p2.y-l.p1.y)*sf
      drawDimLabel(l.p1,l.p2,`${distM.toFixed(2)}m`)
    })
    if(dimensionLine?.p1){
      const p2 = dimensionLine.p2||(activeTool==="dimension"?hoverPt:null)
      ctx.strokeStyle="#94a3b8"; ctx.lineWidth=lw(1.25)
      ctx.beginPath(); ctx.moveTo(dimensionLine.p1.x,dimensionLine.p1.y)
      if(p2) ctx.lineTo(p2.x,p2.y)
      ctx.stroke()
      if(p2){
        const dir=dimLineDir(dimensionLine.p1,p2)
        dimTick(dimensionLine.p1,dir); dimTick(p2,dir)
        const distM = Math.hypot(p2.x-dimensionLine.p1.x,p2.y-dimensionLine.p1.y)*sf
        drawDimLabel(dimensionLine.p1,p2,`${distM.toFixed(2)}m`)
      }
    }

    if(hoverPt&&["downpipe","drain","penetration"].includes(activeTool)){
      ctx.strokeStyle="rgba(255,255,255,0.35)"; ctx.lineWidth=lw(1); ctx.setLineDash([lw(4),lw(2)])
      ctx.beginPath();ctx.moveTo(hoverPt.x-lw(14),hoverPt.y);ctx.lineTo(hoverPt.x+lw(14),hoverPt.y);ctx.stroke()
      ctx.beginPath();ctx.moveTo(hoverPt.x,hoverPt.y-lw(14));ctx.lineTo(hoverPt.x,hoverPt.y+lw(14));ctx.stroke()
      ctx.setLineDash([])
    }

    // ← Alignment tool: full-length horizontal/vertical guide lines through
    //   the cursor plus an X/Y coordinate readout, for any active tool.
    //   Purely visual — does not affect point placement/snapping (that's
    //   what Ortho does). Excluded from the exported quote snapshot the
    //   same way the "Upload a roof photo" prompt is (line ~1572).
    if(alignMode&&hoverPt&&!snapshotModeRef.current){
      ctx.strokeStyle="rgba(59,130,246,0.55)"; ctx.lineWidth=lw(1); ctx.setLineDash([lw(5),lw(3)])
      ctx.beginPath(); ctx.moveTo(0,hoverPt.y); ctx.lineTo(MT_CANVAS_W,hoverPt.y); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(hoverPt.x,0); ctx.lineTo(hoverPt.x,MT_CANVAS_H); ctx.stroke()
      ctx.setLineDash([])

      const xM = (hoverPt.x*sf).toFixed(2), yM = (hoverPt.y*sf).toFixed(2)
      const label = `X: ${xM}m  Y: ${yM}m`
      ctx.font=`600 ${9/view.zoom}px DM Sans`; ctx.textAlign="left"; ctx.textBaseline="bottom"
      const lx = hoverPt.x+lw(8), ly = hoverPt.y-lw(8)
      const boxW = ctx.measureText(label).width+lw(8), boxH = lw(14)
      ctx.fillStyle="rgba(15,23,42,0.8)"
      try{ ctx.beginPath(); ctx.roundRect(lx, ly-boxH, boxW, boxH, lw(3)); ctx.fill() }
      catch{ ctx.fillRect(lx, ly-boxH, boxW, boxH) }
      ctx.fillStyle="#60a5fa"
      ctx.fillText(label, lx+lw(4), ly-lw(3))
    }

    // ── Marquee-selected items get a dashed bounding-box highlight — blue,
    //    not red, so a freshly-pasted (auto-selected) shape doesn't read as
    //    "about to be deleted" the way the red Delete Selected button does.
    if(selectionCount>0){
      const bboxOf = pts => ({
        x1:Math.min(...pts.map(p=>p.x)), y1:Math.min(...pts.map(p=>p.y)),
        x2:Math.max(...pts.map(p=>p.x)), y2:Math.max(...pts.map(p=>p.y)),
      })
      ctx.strokeStyle="#3b82f6"; ctx.lineWidth=lw(2); ctx.setLineDash([lw(5),lw(3)])
      sections.filter(s=>selection.sections.includes(s.id)).forEach(sec=>{
        const b=bboxOf(sec.pts)
        ctx.strokeRect(b.x1-lw(6),b.y1-lw(6),(b.x2-b.x1)+lw(12),(b.y2-b.y1)+lw(12))
      })
      lineItems.filter(li=>selection.lines.includes(li.id)).forEach(li=>{
        const b=bboxOf(li.pts)
        ctx.strokeRect(b.x1-lw(6),b.y1-lw(6),(b.x2-b.x1)+lw(12),(b.y2-b.y1)+lw(12))
      })
      ptItems.filter(pi=>selection.points.includes(pi.id)).forEach(pi=>{
        ctx.strokeRect(pi.x-lw(12),pi.y-lw(12),lw(24),lw(24))
      })
      if(selection.scale && scaleLine?.p1 && scaleLine?.p2){
        const b=bboxOf([scaleLine.p1,scaleLine.p2])
        ctx.strokeRect(b.x1-lw(6),b.y1-lw(6),(b.x2-b.x1)+lw(12),(b.y2-b.y1)+lw(12))
      }
      scaleLines.filter(l=>selection.scaleLineIds.includes(l.id)).forEach(l=>{
        const b=bboxOf([l.p1,l.p2])
        ctx.strokeRect(b.x1-lw(6),b.y1-lw(6),(b.x2-b.x1)+lw(12),(b.y2-b.y1)+lw(12))
      })
      dimensionLines.filter(l=>selection.dimensionLineIds.includes(l.id)).forEach(l=>{
        const b=bboxOf([l.p1,l.p2])
        ctx.strokeRect(b.x1-lw(6),b.y1-lw(6),(b.x2-b.x1)+lw(12),(b.y2-b.y1)+lw(12))
      })
      ctx.setLineDash([])
    }

    // ── Active marquee drag (Select tool) ───
    if(selectBox){
      const x1=Math.min(selectBox.start.x,selectBox.current.x), x2=Math.max(selectBox.start.x,selectBox.current.x)
      const y1=Math.min(selectBox.start.y,selectBox.current.y), y2=Math.max(selectBox.start.y,selectBox.current.y)
      ctx.fillStyle="rgba(59,130,246,0.15)"; ctx.fillRect(x1,y1,x2-x1,y2-y1)
      ctx.strokeStyle="rgba(59,130,246,0.85)"; ctx.lineWidth=lw(1); ctx.setLineDash([lw(4),lw(2)])
      ctx.strokeRect(x1,y1,x2-x1,y2-y1)
      ctx.setLineDash([])
    }

    ctx.restore()
  },[sections,lineItems,ptItems,activeTool,drawPts,hoverPt,scaleLine,scaleLines,dimensionLine,dimensionLines,hiddenDimensionLines,knownM,calibModalOpen,geometry,imgSrc,view,editMode,orthoMode,alignMode,selection,selectionCount,selectBox,mPerPx,expandedCutSections,hiddenSections,cutAngleLine])

  useEffect(()=>{ drawCanvas() },[drawCanvas])

  // ← The canvas is displayed at whatever width its responsive container
  //   gives it (CSS `width:100%!important` in index.css), but its backing
  //   store defaults to a fixed MT_CANVAS_W×MT_CANVAS_H bitmap — on any
  //   viewport wider than that, the browser upscales that small bitmap to
  //   fill the space, which blurs both the traced photo and the drawn
  //   overlay. Resizing the backing store to match the actual displayed
  //   size × devicePixelRatio (capped at 2x to bound redraw cost) fixes
  //   that; drawCanvas compensates with one extra uniform scale so every
  //   existing coordinate (points, hit-testing, geometry) still works in
  //   the same logical 0..MT_CANVAS_W / 0..MT_CANVAS_H space as before.
  useLayoutEffect(()=>{
    const cv = canvasRef.current
    if(!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const resize = () => {
      const rect = cv.getBoundingClientRect()
      if(rect.width<=0 || rect.height<=0) return
      const w = Math.round(rect.width*dpr), h = Math.round(rect.height*dpr)
      if(cv.width!==w || cv.height!==h){ cv.width=w; cv.height=h; drawCanvas() }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(cv)
    return () => ro.disconnect()
  },[drawCanvas])

  // ── Hit-testing for editable points ──────────────────────────────────
  function findHit(pt) {
    for(const sec of sections){
      for(let i=0;i<sec.pts.length;i++){
        if(Math.hypot(sec.pts[i].x-pt.x, sec.pts[i].y-pt.y) <= HIT_RADIUS) return { kind:"section", id:sec.id, idx:i }
      }
    }
    for(const li of lineItems){
      for(let i=0;i<li.pts.length;i++){
        if(Math.hypot(li.pts[i].x-pt.x, li.pts[i].y-pt.y) <= HIT_RADIUS) return { kind:"line", id:li.id, idx:i }
      }
    }
    for(const pi of ptItems){
      if(Math.hypot(pi.x-pt.x, pi.y-pt.y) <= HIT_RADIUS) return { kind:"point", id:pi.id }
    }
    if(scaleLine?.p1 && Math.hypot(scaleLine.p1.x-pt.x, scaleLine.p1.y-pt.y) <= HIT_RADIUS) return { kind:"scale", which:"p1" }
    if(scaleLine?.p2 && Math.hypot(scaleLine.p2.x-pt.x, scaleLine.p2.y-pt.y) <= HIT_RADIUS) return { kind:"scale", which:"p2" }
    for(const l of scaleLines){
      if(Math.hypot(l.p1.x-pt.x, l.p1.y-pt.y) <= HIT_RADIUS) return { kind:"scaleRef", id:l.id, which:"p1" }
      if(Math.hypot(l.p2.x-pt.x, l.p2.y-pt.y) <= HIT_RADIUS) return { kind:"scaleRef", id:l.id, which:"p2" }
    }
    for(const l of dimensionLines){
      if(Math.hypot(l.p1.x-pt.x, l.p1.y-pt.y) <= HIT_RADIUS) return { kind:"dimensionRef", id:l.id, which:"p1" }
      if(Math.hypot(l.p2.x-pt.x, l.p2.y-pt.y) <= HIT_RADIUS) return { kind:"dimensionRef", id:l.id, which:"p2" }
    }
    return null
  }

  // Edit Points mode only — clicking an edge (not an existing vertex) of an
  // already-traced section/line inserts a new point right there, so a
  // previously-measured roof area can be reshaped/extended instead of only
  // ever being re-traced from scratch. Area recalculates automatically
  // since it's derived from these same points (geometry useMemo), and that
  // flows into the Estimate step the same way any other re-trace does.
  function findEdgeHit(pt) {
    for(const sec of sections){
      if(!sec.closed || sec.pts.length<2) continue
      const n = sec.pts.length
      for(let i=0;i<n;i++){
        if(distToSegment(pt, sec.pts[i], sec.pts[(i+1)%n]) <= HIT_RADIUS) return { kind:"section", id:sec.id, insertIdx:i+1 }
      }
    }
    for(const li of lineItems){
      for(let i=0;i<li.pts.length-1;i++){
        if(distToSegment(pt, li.pts[i], li.pts[i+1]) <= HIT_RADIUS) return { kind:"line", id:li.id, insertIdx:i+1 }
      }
    }
    return null
  }

  // Whole-shape hit-testing (not a single vertex/edge) — a click anywhere
  // inside a closed section's fill, on/near a line item's path, or on a
  // point item. Used by the Select tool's right-click-and-hold shortcut so
  // any shape can be grabbed and moved instantly, without first marquee-
  // selecting it.
  function findShapeHit(pt) {
    for(const sec of sections){
      if(sec.pts.length<2) continue
      if(sec.closed && sec.pts.length>=3 && pointInPolygon(pt, sec.pts)) return { kind:"section", id:sec.id }
      const n = sec.closed ? sec.pts.length : sec.pts.length-1
      for(let i=0;i<n;i++){
        if(distToSegment(pt, sec.pts[i], sec.pts[(i+1)%sec.pts.length]) <= HIT_RADIUS) return { kind:"section", id:sec.id }
      }
    }
    for(const li of lineItems){
      for(let i=0;i<li.pts.length-1;i++){
        if(distToSegment(pt, li.pts[i], li.pts[i+1]) <= HIT_RADIUS) return { kind:"line", id:li.id }
      }
    }
    for(const pi of ptItems){
      if(Math.hypot(pi.x-pt.x, pi.y-pt.y) <= HIT_RADIUS) return { kind:"point", id:pi.id }
    }
    return null
  }

  function moveHit(hit, pt) {
    if(hit.kind==="section"){
      setSections(prev=>prev.map(sec=> sec.id!==hit.id ? sec : { ...sec, pts: sec.pts.map((p,i)=> i===hit.idx ? pt : p) }))
    } else if(hit.kind==="line"){
      setLineItems(prev=>prev.map(li=> li.id!==hit.id ? li : { ...li, pts: li.pts.map((p,i)=> i===hit.idx ? pt : p) }))
    } else if(hit.kind==="point"){
      setPtItems(prev=>prev.map(pi=> pi.id!==hit.id ? pi : { ...pi, x:pt.x, y:pt.y }))
    } else if(hit.kind==="scale"){
      setScaleLine(prev=> prev ? { ...prev, [hit.which]: pt } : prev)
    } else if(hit.kind==="scaleRef"){
      setScaleLines(prev=>prev.map(l=> l.id!==hit.id ? l : { ...l, [hit.which]: pt }))
    } else if(hit.kind==="dimensionRef"){
      setDimensionLines(prev=>prev.map(l=> l.id!==hit.id ? l : { ...l, [hit.which]: pt }))
    }
  }

  function handleMouseDown(e){
    if(isPanMode || e.button===1){
      panRef.current = { startX:e.clientX, startY:e.clientY, startOffX:view.offX, startOffY:view.offY }
      return
    }
    const pt = getWorldPt(e.clientX, e.clientY)

    // ← Right-click-and-hold: grab & move whatever shape is directly under
    //   the cursor, from ANY active tool — not just Select — without
    //   needing to select it first. Handled here, before findHit/edge-
    //   insert/handleClick below, so a right-click never drags a single
    //   vertex, inserts a point, or starts a new trace; it only ever means
    //   "move this shape" (or, if it misses everything, falls through to
    //   handleContextMenu's existing cancel/paste-popup behavior). Skipped
    //   while something is actively being traced/calibrated (in-progress
    //   section/flashing/gutter/scale/dimension/cut-angle line) since
    //   right-click already means "cancel" there.
    if(e.button===2){
      const midTrace = drawPts.length>0
        || (scaleLine?.p1 && !scaleLine?.p2)
        || (dimensionLine?.p1 && !dimensionLine?.p2)
        || !!cutAngleLine?.p1
      if(!midTrace){
        const startMove = (secIds, lineIds, ptIds) => {
          moveSelectionRef.current = {
            startPt: pt,
            origSections: sections.filter(s=>secIds.includes(s.id)).map(s=>({id:s.id,pts:s.pts,cutAngleAnchor:s.cutAngleAnchor||null})),
            origLines: lineItems.filter(l=>lineIds.includes(l.id)).map(l=>({id:l.id,pts:l.pts})),
            origPoints: ptItems.filter(p=>ptIds.includes(p.id)).map(p=>({id:p.id,x:p.x,y:p.y})),
            pushed: false,
          }
        }
        // Prefer moving the existing selection if the cursor is over it
        // (keeps a multi-shape selection moving together); otherwise grab +
        // auto-select whichever single shape is directly under the cursor.
        let grabbed = false
        if(selectionCount>0){
          const selPts = [
            ...sections.filter(s=>selection.sections.includes(s.id)).flatMap(s=>s.pts),
            ...lineItems.filter(l=>selection.lines.includes(l.id)).flatMap(l=>l.pts),
            ...ptItems.filter(p=>selection.points.includes(p.id)).map(p=>({x:p.x,y:p.y})),
          ]
          if(selPts.length){
            const x1=Math.min(...selPts.map(p=>p.x))-6, x2=Math.max(...selPts.map(p=>p.x))+6
            const y1=Math.min(...selPts.map(p=>p.y))-6, y2=Math.max(...selPts.map(p=>p.y))+6
            if(pt.x>=x1 && pt.x<=x2 && pt.y>=y1 && pt.y<=y2){ startMove(selection.sections, selection.lines, selection.points); grabbed = true }
          }
        }
        if(!grabbed){
          const shapeHit = findShapeHit(pt)
          if(shapeHit){
            const secIds  = shapeHit.kind==="section" ? [shapeHit.id] : []
            const lineIds = shapeHit.kind==="line"    ? [shapeHit.id] : []
            const ptIds   = shapeHit.kind==="point"   ? [shapeHit.id] : []
            setSelection({ sections:secIds, lines:lineIds, points:ptIds, scale:false, scaleLineIds:[], dimensionLineIds:[] })
            startMove(secIds, lineIds, ptIds)
            grabbed = true
          }
        }
        if(grabbed) return
      }
      return // any other right-click: let handleContextMenu (cancel in-progress trace / paste-duplicate popup) handle it
    }

    // ── everything below only ever runs for left-click (button 0) ──
    // Point/edge hit-testing runs before the Select tool's marquee-box —
    // otherwise having Select active (a natural choice when trying to click
    // on an existing shape) while Edit Points is on silently swallowed every
    // click into a selection drag instead of ever offering to edit anything.
    const hit = findHit(pt)
    if(hit){
      dragRef.current = hit
      dragPushedRef.current = false
      clickStartRef.current = { x:e.clientX, y:e.clientY }
      return
    }
    // Clicking an edge inserts a point there — either explicitly via Edit
    // Points, or directly with the Section/Flashing/Gutter/Select tool as
    // long as nothing is currently being traced. Left off for the
    // downpipe/drain/penetration/scale tools, where a click has its own
    // fixed meaning (place a marker exactly here) that shouldn't be
    // hijacked just because it happens to land near an old line.
    const canEdgeInsert = editMode || (drawPts.length===0 && ["section","flashing","gutter","select"].includes(activeTool))
    if(canEdgeInsert){
      const edgeHit = findEdgeHit(pt)
      if(edgeHit){
        pushHistory()
        if(edgeHit.kind==="section"){
          setSections(prev=>prev.map(s=>s.id!==edgeHit.id?s:{...s,pts:[...s.pts.slice(0,edgeHit.insertIdx),pt,...s.pts.slice(edgeHit.insertIdx)]}))
        } else {
          setLineItems(prev=>prev.map(l=>l.id!==edgeHit.id?l:{...l,pts:[...l.pts.slice(0,edgeHit.insertIdx),pt,...l.pts.slice(edgeHit.insertIdx)]}))
        }
        // Arm the freshly-inserted point for dragging in the same gesture,
        // so it can be fine-tuned immediately instead of landing exactly on
        // the old straight edge (where it'd have zero effect until moved).
        dragRef.current = { kind:edgeHit.kind, id:edgeHit.id, idx:edgeHit.insertIdx }
        dragPushedRef.current = true // history already captured above, before the insert
        clickStartRef.current = { x:e.clientX, y:e.clientY }
        return
      }
    }
    if(activeTool==="select"){
      // ← Clicking inside the existing selection's highlighted bounding box
      //   (same box drawn around a selection, see drawCanvas) starts a move
      //   instead of a brand new marquee — lets a selected shape be dragged
      //   to reposition it, not just selected/copied/deleted. Gated behind
      //   the explicit Move toggle so an ordinary click/drag while selecting
      //   things can't shift a shape by accident. (Right-click-and-hold is a
      //   separate, zero-setup shortcut handled at the top of this function.)
      if(moveArmed && selectionCount>0){
        const selPts = [
          ...sections.filter(s=>selection.sections.includes(s.id)).flatMap(s=>s.pts),
          ...lineItems.filter(l=>selection.lines.includes(l.id)).flatMap(l=>l.pts),
          ...ptItems.filter(p=>selection.points.includes(p.id)).map(p=>({x:p.x,y:p.y})),
        ]
        if(selPts.length){
          const x1=Math.min(...selPts.map(p=>p.x))-6, x2=Math.max(...selPts.map(p=>p.x))+6
          const y1=Math.min(...selPts.map(p=>p.y))-6, y2=Math.max(...selPts.map(p=>p.y))+6
          if(pt.x>=x1 && pt.x<=x2 && pt.y>=y1 && pt.y<=y2){
            moveSelectionRef.current = {
              startPt: pt,
              origSections: sections.filter(s=>selection.sections.includes(s.id)).map(s=>({id:s.id,pts:s.pts,cutAngleAnchor:s.cutAngleAnchor||null})),
              origLines: lineItems.filter(l=>selection.lines.includes(l.id)).map(l=>({id:l.id,pts:l.pts})),
              origPoints: ptItems.filter(p=>selection.points.includes(p.id)).map(p=>({id:p.id,x:p.x,y:p.y})),
              pushed: false,
            }
            return
          }
        }
      }
      setSelectBox({ start:pt, current:pt })
      return
    }
    if(editMode) return // in edit mode, empty-space clicks don't start new geometry
    handleClick(pt)
  }

  function handleMouseMove(e){
    if(panRef.current){
      const { startX, startY, startOffX, startOffY } = panRef.current
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      const cv = canvasRef.current
      const r = cv.getBoundingClientRect()
      const scaleX = MT_CANVAS_W / r.width, scaleY = MT_CANVAS_H / r.height
      setView(v=>clampView({ ...v, offX: startOffX + dx*scaleX, offY: startOffY + dy*scaleY }))
      return
    }
    const pt = getWorldPt(e.clientX, e.clientY)
    if(selectBox){ setSelectBox(prev=>({ ...prev, current:pt })); return }
    if(dragRef.current){
      // Push the pre-drag snapshot once, on the first real movement — not
      // on mousedown, so a plain click that lands on a point (no drag)
      // doesn't waste an undo step, and not on every mousemove tick either.
      if(!dragPushedRef.current){ pushHistory(); dragPushedRef.current = true }
      moveHit(dragRef.current, pt)
      return
    }
    if(moveSelectionRef.current){
      const m = moveSelectionRef.current
      if(!m.pushed){ pushHistory(); m.pushed = true }
      const dx = pt.x-m.startPt.x, dy = pt.y-m.startPt.y
      if(m.origSections.length) setSections(prev=>prev.map(s=>{
        const orig = m.origSections.find(o=>o.id===s.id)
        if(!orig) return s
        return { ...s, pts:orig.pts.map(p=>({x:p.x+dx,y:p.y+dy})),
          cutAngleAnchor: orig.cutAngleAnchor ? {x:orig.cutAngleAnchor.x+dx,y:orig.cutAngleAnchor.y+dy} : s.cutAngleAnchor }
      }))
      if(m.origLines.length) setLineItems(prev=>prev.map(l=>{
        const orig = m.origLines.find(o=>o.id===l.id)
        return orig ? { ...l, pts:orig.pts.map(p=>({x:p.x+dx,y:p.y+dy})) } : l
      }))
      if(m.origPoints.length) setPtItems(prev=>prev.map(p=>{
        const orig = m.origPoints.find(o=>o.id===p.id)
        return orig ? { ...p, x:orig.x+dx, y:orig.y+dy } : p
      }))
      return
    }
    setHoverPt(pt)
  }
  function handleMouseUp(e){
    if(moveSelectionRef.current){ moveSelectionRef.current = null; return }
    if(selectBox){
      const x1=Math.min(selectBox.start.x,selectBox.current.x), x2=Math.max(selectBox.start.x,selectBox.current.x)
      const y1=Math.min(selectBox.start.y,selectBox.current.y), y2=Math.max(selectBox.start.y,selectBox.current.y)
      // A tiny box (basically a click, not a drag) clears the selection —
      // matches Photoshop's "click empty space to deselect" behaviour.
      if(x2-x1>3 || y2-y1>3){
        const inBox = p => p.x>=x1&&p.x<=x2&&p.y>=y1&&p.y<=y2
        setSelection({
          sections: sections.filter(sec=>sec.pts.some(inBox)).map(s=>s.id),
          lines:    lineItems.filter(li=>li.pts.some(inBox)).map(l=>l.id),
          points:   ptItems.filter(inBox).map(p=>p.id),
          scale:    !!(scaleLine?.p1 && scaleLine?.p2 && (inBox(scaleLine.p1) || inBox(scaleLine.p2))),
          scaleLineIds: scaleLines.filter(l=>inBox(l.p1) || inBox(l.p2)).map(l=>l.id),
          dimensionLineIds: dimensionLines.filter(l=>inBox(l.p1) || inBox(l.p2)).map(l=>l.id),
        })
      } else {
        setSelection({ sections:[], lines:[], points:[], scale:false, scaleLineIds:[], dimensionLineIds:[] })
      }
      setSelectBox(null)
    }
    // A grabbed point that never actually moved was just a click, not a
    // drag — most likely the user was placing a NEW point for the active
    // tool that happened to land near an existing one (e.g. a section
    // corner traced close to the scale line), so fall through to adding it
    // instead of silently doing nothing. Real drags (mouse moved) still
    // just reposition the existing point, same as before.
    if(dragRef.current && !editMode && clickStartRef.current && e){
      const moved = Math.hypot(e.clientX-clickStartRef.current.x, e.clientY-clickStartRef.current.y)
      if(moved < 4) handleClick(getWorldPt(e.clientX, e.clientY))
    }
    panRef.current = null; dragRef.current = null; clickStartRef.current = null
  }
  function handleMouseLeave(){ panRef.current = null; dragRef.current = null; clickStartRef.current = null; moveSelectionRef.current = null; setSelectBox(null); setHoverPt(null) }

  function handleClick(pt){
    pushHistory()
    if(activeTool==="section"){
      if(drawPts.length>=3){
        const fp=drawPts[0], d=Math.hypot(pt.x-fp.x,pt.y-fp.y)
        if(d<15){
          const newId = uid()
          setSections(prev=>[...prev,{id:newId,name:`Section ${prev.length+1}`,pts:drawPts,closed:true,pitch:null,color:SEC_COLORS[prev.length%SEC_COLORS.length],materialLabel:"",rate:0,sheetWidthMm:762,cutAngleDeg:null,cutAngleAnchor:null}])
          setDrawPts([])
          // ← Prompt for this section's pitch, then its roof sheet brand,
          //   right away while the roofer is still looking at it, instead
          //   of making them remember to set either later in the Estimate
          //   step (both can still be changed there afterwards). Pitch
          //   popup chains into the brand popup on Save/Skip below.
          setSectionPitchModalId(newId)
          return
        }
      }
      setDrawPts(prev=>[...prev, orthoMode ? orthoSnap(pt, prev[prev.length-1]) : pt])
    }
    else if(activeTool==="flashing"||activeTool==="gutter"){ setDrawPts(prev=>[...prev, orthoMode ? orthoSnap(pt, prev[prev.length-1]) : pt]) }
    else if(activeTool==="downpipe")    { const id=uid(); setPtItems(prev=>[...prev,{id,type:"downpipe",   materialLabel:"",rate:0,x:pt.x,y:pt.y,length_m:0,quantity:1,preferredLength:null,waste:0,bends:0,spreader:false}]); setDownpipeLengthModalId(id) }
    else if(activeTool==="drain")       { const id=uid(); setPtItems(prev=>[...prev,{id,type:"drain",      materialLabel:"",rate:0,x:pt.x,y:pt.y}]); setAccessoryModal({kind:"drain",      id}) }
    else if(activeTool==="penetration") { const id=uid(); setPtItems(prev=>[...prev,{id,type:"penetration",subtype:penSub,materialLabel:"",rate:0,x:pt.x,y:pt.y}]); setAccessoryModal({kind:"penetration",id}) }
    else if(activeTool==="scale"){
      if(!scaleLine?.p1)       setScaleLine({p1:pt,p2:null})
      else if(!scaleLine?.p2){
        setScaleLine(prev=>({...prev,p2:pt}))
        // ← Blank, not the previous scale's value — the user is about to
        //   measure a brand new reference line and should type its actual
        //   real-world length, not see an old number that looks pre-confirmed.
        setCalibInput("")
        setCalibModalOpen(true)
      }
    }
    else if(activeTool==="dimension"){
      if(!dimensionLine?.p1) setDimensionLine({p1:pt,p2:null})
      else {
        // ← Unlike Calibrate Image, no modal — the length is read straight
        //   off the already-established scale, not typed in, so the second
        //   click commits the dimension immediately and the tool is ready
        //   to measure another one right away.
        setDimensionLines(prev=>[...prev,{id:uid(),p1:dimensionLine.p1,p2:pt}])
        setDimensionLine(null)
      }
    }
    else if(activeTool==="cutangle"){
      if(!cutAngleLine?.p1) setCutAngleLine({p1:pt,p2:null})
      else {
        const dx=pt.x-cutAngleLine.p1.x, dy=pt.y-cutAngleLine.p1.y
        const angleDeg = ((Math.atan2(dy,dx)*180/Math.PI)%180+180)%180
        // ← Anchor is the line's own end point (where you finished the
        //   drag) — the stripe grid gets phase-shifted so a boundary lands
        //   exactly there, not just matching the angle (sectionStripeInfo).
        setSections(prev=>prev.map(x=>x.id===cutAngleDrawSectionId?{...x,cutAngleDeg:angleDeg,cutAngleAnchor:pt}:x))
        setCutAngleLine(null)
        setCutAngleDrawSectionId(null)
        setActiveTool("select")
      }
    }
  }

  function handleContextMenu(e) {
    e.preventDefault() // stop the browser's right-click menu
    // A right-click-and-hold inside the current selection just armed a move
    // in handleMouseDown (fires first in the browser's event order) — don't
    // also pop the paste-duplicate menu on top of that drag.
    if(moveSelectionRef.current) return
    if(activeTool==="section" && drawPts.length>0) {
      // right-click cancels the in-progress section (not enough points to auto-close)
      setDrawPts([])
    }
    else if((activeTool==="flashing"||activeTool==="gutter") && drawPts.length>=2) {
      setLineContextMenu({ x:e.clientX, y:e.clientY })
    }
    else if((activeTool==="flashing"||activeTool==="gutter") && drawPts.length>0) {
      // fewer than 2 points — not enough to save a line, just cancel it
      setDrawPts([])
    }
    else if(activeTool==="scale" && scaleLine?.p1 && !scaleLine?.p2) {
      // cancel an in-progress scale line
      setScaleLine(null)
    }
    else if(activeTool==="dimension" && dimensionLine?.p1) {
      // cancel an in-progress dimension line
      setDimensionLine(null)
    }
    else if(activeTool==="cutangle") {
      // cancel drawing the cut-angle reference line and exit the tool entirely
      setCutAngleLine(null); setCutAngleDrawSectionId(null); setActiveTool("select")
    }
    // Nothing else claimed this right-click — if there's a copied shape
    // waiting, offer to paste it right here instead of showing nothing.
    else if(shapeClipboard) {
      setPastePopup({ x:e.clientX, y:e.clientY, worldPt: getWorldPt(e.clientX, e.clientY) })
    }
  }

  function finishLine(){
    pushHistory()
    if(drawPts.length>=2){
      const id = uid()
      setLineItems(prev=>[...prev,{id,type:activeTool,subtype:activeTool==="flashing"?flashSub:undefined,materialLabel:"",rate:0,pts:drawPts}])
      if(activeTool==="gutter") setAccessoryModal({kind:"gutter", id})
      // ← Flashing is priced per-subtype in the Estimate step (one rate for
      //   all Ridge Cap segments together, not one per traced line), so the
      //   popup asks once per subtype and its pick applies to every segment
      //   of that subtype — not just the one just drawn.
      // ← Slope-following subtypes ask for a pitch first, then chain into
      //   the brand picker (same two-step shape as Roof Pitch → Roof Sheet
      //   Brand). Horizontal ones go straight to the brand picker as before.
      else if(activeTool==="flashing"){
        if(FLASHING_ANGLE_SUBTYPES.includes(flashSub)) setFlashingPitchModal({ id, subtype:flashSub })
        else setAccessoryModal({kind:"flashing", id, subtype:flashSub})
      }
    }
    setDrawPts([])
  }

  function clearAll(){
    pushHistory()
    setSections([]); setLineItems([]); setPtItems([])
    setScaleLine(null); setScaleLines([]); setDrawPts([]); setAsbestos(false)
    setSelection({sections:[],lines:[],points:[],scale:false,scaleLineIds:[],dimensionLineIds:[]}); setSelectBox(null)
    resetView()
  }

  function applyCalibration(){
    const raw = parseFloat(calibInput)
    if(!raw || raw<=0 || !scaleLine?.p1 || !scaleLine?.p2) return
    pushHistory()
    const toM = CALIB_UNITS.find(u=>u.key===calibUnit)?.toM ?? 1
    const value = raw*toM
    setScaleLines(prev=>[...prev, { id:uid(), p1:scaleLine.p1, p2:scaleLine.p2, knownM:value }])
    setKnownM(value) // pre-fills the next reference's modal with the last value typed, for convenience
    setScaleLine(null)
    setCalibModalOpen(false)
  }

  function cancelCalibration(){
    setScaleLine(null)
    setCalibModalOpen(false)
  }

  function saveAccessoryMaterial(){
    if(!pendingAccessoryMaterial || !accessoryModal) return
    const { kind, id, subtype } = accessoryModal
    const { label, rate } = pendingAccessoryMaterial
    if(kind==="gutter") setLineItems(prev=>prev.map(li=>li.id===id?{...li,materialLabel:label,rate}:li))
    else if(kind==="flashing") setLineItems(prev=>prev.map(li=>li.type==="flashing"&&li.subtype===subtype?{...li,materialLabel:label,rate}:li))
    else setPtItems(prev=>prev.map(pi=>pi.id===id?{...pi,materialLabel:label,rate}:pi))
    setAccessoryModal(null); setPendingAccessoryMaterial(null)
  }

  function loadImage(file){
    const r=new FileReader()
    r.onload=e=>{
      const img=new Image()
      img.onload=()=>{imgRef.current=img;drawCanvas()}
      img.src=e.target.result; setImgSrc(e.target.result)
      // ← A locally-uploaded photo only ever lived in this component's own
      //   state, which React destroys when the wizard leaves the Measure
      //   step (this component unmounts) — so navigating Measure → Estimate
      //   → back to Measure showed a blank canvas even though the traced
      //   sections themselves survived (those come from `initialGeometry`,
      //   owned by the parent). Reporting the photo up the same way a
      //   job-picked photo already is means the parent's `photoUrl` prop
      //   restores it on remount instead of losing it.
      onPhotoChange?.(e.target.result)
    }
    r.readAsDataURL(file)
  }

  // ← Loads a photo picked from a job's photo library directly by URL
  //   (instead of a local file), so it can be traced the same way as an
  //   uploaded image.
  useEffect(()=>{
    if(!photoUrl) return
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => { imgRef.current = img; drawCanvas() }
    img.src = photoUrl
    setImgSrc(photoUrl)
  },[photoUrl])

  const TOOLS=[
    {key:"section",    label:"Draw",icon:"▲",color:"#3b82f6",hint:"Click to add points · click first point (⭕) to close · right-click to cancel"},
    {key:"flashing",   label:"Flashing",    icon:"⚡",color:"#f59e0b",hint:"Click points to trace · right-click or press Done ✓ to finish"},
    {key:"gutter",     label:"Gutter",      icon:"〰",color:"#06b6d4",hint:"Click points to trace · right-click or press Done ✓ to finish"},
    {key:"downpipe",   label:"Downpipe",    icon:"⬇",color:"#0ea5e9",hint:"Click canvas to place a downpipe (DP) marker"},
    {key:"drain",      label:"Roof Drain",  icon:"⊙",color:"#6366f1",hint:"Click canvas to place a roof drain (DR) marker"},
    {key:"penetration",label:"Penetration", icon:"◇",color:"#8b5cf6",hint:"Click to place — select type below"},
    {key:"scale",      label:"Calibrate Image", icon:"📏",color:"#10b981",hint:"Click two points over a known dimension · right-click to cancel"},
    {key:"dimension",  label:"Dimension",   icon:"↔",color:"#ec4899",hint:"Click two points to measure a distance for reference · right-click to cancel · not used in pricing"},
    {key:"select",     label:"Select",      icon:"⬚",color:"#ef4444",hint:"Drag a box over items to select them, then drag inside the selection to move it · Delete to remove · Ctrl+C to copy · Ctrl+V or right-click empty space to paste a duplicate"},
    {key:"pan",        label:"Pan",         icon:"✋",color:"#64748b",hint:"Drag to pan the image (or hold Space with any tool)"},
  ]

  const tip = isPanMode ? "Drag to pan · release Space to resume drawing"
    : activeTool==="cutangle" ? "Click two points on the photo (e.g. along a visible rafter/ridge line) to set this section's cut angle · right-click to cancel"
    : (TOOLS.find(t=>t.key===activeTool)?.hint||"")
    + " · right-click and hold directly on any shape to grab and move it instantly, from any tool"
    + (orthoMode && ["section","flashing","gutter"].includes(activeTool) ? " · Ortho: new points snap to horizontal/vertical" : "")

  return (
    <div>
      <div style={{border:"2px dashed #e2e8f0",borderRadius:10,padding:"13px 18px",cursor:"pointer",marginBottom:12,background:"#f8fafc",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}
        onClick={()=>document.getElementById("mt-upload").click()}>
        <input id="mt-upload" type="file" accept="image/*" style={{display:"none"}} onChange={e=>e.target.files[0]&&loadImage(e.target.files[0])}/>
        <span style={{fontSize:13,color:"#64748b"}}>📷 {imgSrc ? "Replace photo" : "Upload aerial or site photo"} <span style={{color:"#94a3b8",fontSize:11}}>(JPG / PNG / HEIC)</span></span>
        {imgSrc
          ? <span style={{fontSize:11,color:"#10b981",fontWeight:500}}>✓ Photo loaded — click to replace</span>
          : <span style={{fontSize:11,color:"#94a3b8"}}>or draw on blank canvas →</span>}
      </div>

      <div className="mt-grid">
        <div style={{border:"1px solid #334155",borderRadius:12,overflow:"hidden",background:"#0f172a"}}>
          <div className="mt-toolbar" style={{display:"flex",alignItems:"center",gap:5,padding:"8px 10px",background:"#1e293b",flexWrap:"wrap"}}>
            {TOOLS.map(t=>(
              <button key={t.key}
                onClick={()=>{setActiveTool(t.key);setDrawPts([]); if(t.key!=="select"){setSelection({sections:[],lines:[],points:[],scale:false,scaleLineIds:[],dimensionLineIds:[]});setSelectBox(null);setMoveArmed(false)}}}
                style={{padding:"5px 9px",borderRadius:6,
                  border:`1px solid ${activeTool===t.key?t.color:"rgba(255,255,255,0.14)"}`,
                  background:activeTool===t.key?t.color+"28":"transparent",
                  color:activeTool===t.key?t.color:"#94a3b8",
                  fontSize:11,fontWeight:activeTool===t.key?600:400,cursor:"pointer",
                  display:"flex",alignItems:"center",gap:4,fontFamily:"inherit"}}>
                <span>{t.icon}</span>{t.label}
              </button>
            ))}
            <button
              onClick={()=>setEditMode(m=>!m)}
              title="Toggle point editing — drag any existing point to move it"
              style={{padding:"5px 9px",borderRadius:6,
                border:`1px solid ${editMode?"#fbbf24":"rgba(255,255,255,0.14)"}`,
                background:editMode?"#fbbf2428":"transparent",
                color:editMode?"#fbbf24":"#94a3b8",
                fontSize:11,fontWeight:editMode?600:400,cursor:"pointer",
                display:"flex",alignItems:"center",gap:4,fontFamily:"inherit"}}>
              <span>✎</span>Edit Points
            </button>
            <button
              onClick={()=>setOrthoMode(m=>!m)}
              title={`Ortho: snap each new traced point to horizontal/vertical from the previous point — ${orthoMode?"ON":"OFF"} (click to turn ${orthoMode?"off":"on"})`}
              style={{padding:"5px 9px",borderRadius:6,
                border:`1px solid ${orthoMode?"#fbbf24":"rgba(255,255,255,0.14)"}`,
                background:orthoMode?"#fbbf2428":"transparent",
                color:orthoMode?"#fbbf24":"#94a3b8",
                fontSize:11,fontWeight:orthoMode?600:400,cursor:"pointer",
                display:"flex",alignItems:"center",gap:4,fontFamily:"inherit"}}>
              <span>⊥</span>Ortho
            </button>
            <button
              onClick={()=>setAlignMode(m=>!m)}
              title={`Alignment guides: show horizontal/vertical crosshair lines and coordinates through the cursor — ${alignMode?"ON":"OFF"} (click to turn ${alignMode?"off":"on"})`}
              style={{padding:"5px 9px",borderRadius:6,
                border:`1px solid ${alignMode?"#fbbf24":"rgba(255,255,255,0.14)"}`,
                background:alignMode?"#fbbf2428":"transparent",
                color:alignMode?"#fbbf24":"#94a3b8",
                fontSize:11,fontWeight:alignMode?600:400,cursor:"pointer",
                display:"flex",alignItems:"center",gap:4,fontFamily:"inherit"}}>
              <span>✛</span>Align
            </button>
            {/* ← Opens the protractor overlay rather than being a canvas draw
                mode: the tracing canvas stretches the photo to a fixed
                490x330, so an angle measured on it would be skewed. */}
            <button
              onClick={()=>setProtractor({ target: selection.sections.length===1 ? selection.sections[0] : null })}
              title={selection.sections.length===1
                ? "Protractor: measure a roof angle from a photo and apply it to the selected section"
                : "Protractor: measure a roof angle from a photo (select one section first to apply it directly)"}
              style={{padding:"5px 9px",borderRadius:6,
                border:"1px solid rgba(255,255,255,0.14)",
                background:"transparent",
                color:"#94a3b8",
                fontSize:11,fontWeight:400,cursor:"pointer",
                display:"flex",alignItems:"center",gap:4,fontFamily:"inherit"}}>
              <span>📐</span>Protractor
            </button>
            <div style={{marginLeft:"auto",display:"flex",gap:5,alignItems:"center"}}>
              {(activeTool==="flashing"||activeTool==="gutter")&&drawPts.length>=2&&(
                <button onClick={finishLine} style={{padding:"5px 10px",borderRadius:6,border:"1px solid #10b981",background:"#10b981",color:"#fff",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                  Done ✓
                </button>
              )}
              <button onClick={()=>zoomButton(1/1.3)} title="Zoom out" style={{width:26,height:26,borderRadius:6,border:"1px solid rgba(255,255,255,0.15)",background:"transparent",color:"#94a3b8",fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>−</button>
              <span style={{fontSize:10,color:"#64748b",width:34,textAlign:"center"}}>{Math.round(view.zoom*100)}%</span>
              <button onClick={()=>zoomButton(1.3)} title="Zoom in" style={{width:26,height:26,borderRadius:6,border:"1px solid rgba(255,255,255,0.15)",background:"transparent",color:"#94a3b8",fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>+</button>
              <button onClick={undo} title="Undo last point/action (Ctrl+Z)" style={{padding:"5px 9px",borderRadius:6,border:"1px solid rgba(255,255,255,0.15)",background:"transparent",color:"#64748b",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>↶ Undo</button>
              <button onClick={redo} title="Redo (Ctrl+Shift+Z / Ctrl+Y)" style={{padding:"5px 9px",borderRadius:6,border:"1px solid rgba(255,255,255,0.15)",background:"transparent",color:"#64748b",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>↷ Redo</button>
              <button onClick={resetView} title="Reset zoom/pan" style={{padding:"5px 9px",borderRadius:6,border:"1px solid rgba(255,255,255,0.15)",background:"transparent",color:"#64748b",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>Reset View</button>
              <button onClick={clearAll} style={{padding:"5px 10px",borderRadius:6,border:"1px solid rgba(255,255,255,0.15)",background:"transparent",color:"#64748b",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>
                Clear All
              </button>
            </div>
          </div>

          <div style={{padding:"5px 12px",background:"#0f172a",fontSize:11,color:"#475569",display:"flex",alignItems:"center",justifyContent:"space-between",minHeight:28,flexWrap:"wrap",gap:6}}>
            <span>{tip}{editMode && !isPanMode ? " · Edit mode: drag any highlighted point, or click a line to add a point" : ""}</span>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              {activeTool==="select"&&selectionCount>0&&(
                <button onClick={copySelectedShapes}
                  title="Copy the selected shape(s) — then press Ctrl+V or right-click anywhere to paste a duplicate"
                  style={{padding:"5px 10px",borderRadius:6,border:`1px solid ${shapeCopyMsg?"#10b981":"#475569"}`,background:shapeCopyMsg?"#10b98122":"transparent",color:shapeCopyMsg?"#10b981":"#94a3b8",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:4}}>
                  {shapeCopyMsg || `⧉ Copy (${selectionCount})`}
                </button>
              )}
              {activeTool==="select"&&selectionCount>0&&(
                <button onClick={()=>setMoveArmed(a=>!a)}
                  title={moveArmed ? "Move mode on — click and hold inside the selection, then drag" : "Turn on Move, then click and hold inside the selection to drag it — or skip this entirely and right-click-hold directly on any shape instead"}
                  style={{padding:"5px 10px",borderRadius:6,border:`1px solid ${moveArmed?"#3b82f6":"#475569"}`,background:moveArmed?"#3b82f622":"transparent",color:moveArmed?"#3b82f6":"#94a3b8",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:4}}>
                  🤚 Move{moveArmed?" (on)":""}
                </button>
              )}
              {activeTool==="select"&&selectionCount>0&&(
                <button onClick={deleteSelected}
                  style={{padding:"5px 10px",borderRadius:6,border:"1px solid #ef4444",background:"#ef444422",color:"#ef4444",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:4}}>
                  🗑 Delete Selected ({selectionCount})
                </button>
              )}
              {activeTool==="select"&&!selectionCount&&shapeClipboard&&(
                <span style={{fontSize:11,color:"#64748b"}}>Ctrl+V or right-click to paste</span>
              )}
              {activeTool==="penetration"&&(
                <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                  {PEN_TYPES.map(t=>(
                    <button key={t} onClick={()=>setPenSub(t)}
                      style={{padding:"1px 7px",borderRadius:4,border:`1px solid ${penSub===t?PEN_COLORS[t]:"rgba(255,255,255,0.1)"}`,
                        background:penSub===t?PEN_COLORS[t]+"33":"transparent",color:penSub===t?PEN_COLORS[t]:"#64748b",
                        fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>
                      {t}
                    </button>
                  ))}
                </div>
              )}
              {activeTool==="flashing"&&(
                <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                  {FLASHING_TYPES.map(f=>(
                    <button key={f.key} onClick={()=>setFlashSub(f.key)}
                      style={{padding:"1px 7px",borderRadius:4,border:`1px solid ${flashSub===f.key?"#f59e0b":"rgba(255,255,255,0.1)"}`,
                        background:flashSub===f.key?"#f59e0b33":"transparent",color:flashSub===f.key?"#f59e0b":"#64748b",
                        fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {imgSrc && !mPerPx && (
            <div style={{padding:"6px 12px",background:"#78350f",color:"#fde68a",fontSize:11,display:"flex",alignItems:"center",gap:6}}>
              <span>⚠</span>
              <span>This image has not been calibrated. Measurements are estimates until calibration is completed — use <strong>Calibrate Image</strong> above.</span>
            </div>
          )}

          <div className="mt-canvas-wrap">
            <canvas ref={canvasRef}
              style={{cursor:isPanMode?(panRef.current?"grabbing":"grab"):(["section","flashing","gutter","scale","dimension","select","cutangle"].includes(activeTool)?"crosshair":"cell")}}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              onContextMenu={handleContextMenu}/>
          </div>

          <div style={{padding:"7px 12px",background:"#0f172a",display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{fontSize:11}}>
              <span style={{color:"#475569"}}>Scale: </span>
              {geometry.axisScale ? (
                <span style={{color:"#10b981",fontWeight:600}}>
                  H: 1px = {(geometry.axisScale.x*100).toFixed(1)}cm · V: 1px = {(geometry.axisScale.y*100).toFixed(1)}cm
                </span>
              ) : (
                <span style={{color:mPerPx?"#10b981":"#f59e0b",fontWeight:600}}>
                  {mPerPx?`1px = ${(mPerPx*100).toFixed(1)}cm`:"Not calibrated (using 5cm/px default)"}
                </span>
              )}
              {scaleLines.length>1 && (
                <span style={{color:"#64748b"}}> · {scaleLines.length} references</span>
              )}
              {!geometry.axisScale && scaleSpreadPct!=null && scaleSpreadPct>5 && (
                <span style={{color:"#ef4444",fontWeight:600}}> · ⚠ disagree by {scaleSpreadPct.toFixed(0)}% — double-check your measurements</span>
              )}
            </div>
            <div style={{fontSize:11}}>
              <span style={{color:"#475569"}}>Surface area: </span>
              <span style={{color:"#f59e0b",fontWeight:700,fontSize:13}}>{geometry.total_surface_m2} m²</span>
            </div>
            <span style={{fontSize:11,color:"#475569",marginLeft:"auto"}}>{drawPts.length>0?`Drawing: ${drawPts.length} pts`:""}</span>
          </div>
        </div>

        <div className="mt-sidepanel" style={{display:"flex",flexDirection:"column",gap:10,overflowY:"auto",maxHeight:720}}>
          <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:10,padding:12}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:600,color:"#64748b",textTransform:"uppercase",letterSpacing:.5}}>Roof Sections</div>
              {sections.length>0 && (() => {
                // ← Convenience on top of the existing per-section ▸/▾
                //   toggle, not a replacement — expands/collapses every
                //   section's cutting list at once (sidebar + canvas, same
                //   expandedCutSections state) so a multi-section roof
                //   doesn't need opening one by one to review them all.
                const allExpanded = sections.every(s=>expandedCutSections[s.id])
                return (
                  <button
                    onClick={()=>setExpandedCutSections(allExpanded ? {} : Object.fromEntries(sections.map(s=>[s.id,true])))}
                    style={{padding:"2px 8px",border:"1px solid #e2e8f0",background:"transparent",color:"#3b82f6",borderRadius:4,fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                    {allExpanded ? "Hide all cutting lists" : "Show all cutting lists"}
                  </button>
                )
              })()}
            </div>
            {sections.length===0&&<div style={{fontSize:11,color:"#94a3b8",textAlign:"center",padding:"8px 0"}}>No sections yet — use ▲ Section tool</div>}
            {sections.map((sec,idx)=>{
              const gs=geometry.sections[idx]
              const expanded = !!expandedCutSections[sec.id]
              const hidden = !!hiddenSections[sec.id]
              return(
                <div key={sec.id} style={{marginBottom:10,paddingBottom:10,borderBottom:"1px solid #f1f5f9",opacity:hidden?0.5:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                    <div style={{width:10,height:10,borderRadius:2,background:sec.color,flexShrink:0}}/>
                    <input value={sec.name}
                      onChange={e=>setSections(prev=>prev.map(x=>x.id===sec.id?{...x,name:e.target.value}:x))}
                      style={{flex:1,padding:"2px 6px",border:"1px solid #e2e8f0",borderRadius:4,fontSize:11,fontFamily:"inherit"}}/>
                    <button onClick={()=>setHiddenSections(prev=>({...prev,[sec.id]:!prev[sec.id]}))}
                      title={hidden?"Show this section on the canvas":"Hide this section on the canvas"}
                      style={{padding:"1px 6px",border:"none",background:hidden?"#e2e8f0":"#f1f5f9",color:hidden?"#64748b":"#475569",borderRadius:4,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>
                      {hidden?"🚫":"👁"}
                    </button>
                    <button onClick={()=>setSections(prev=>prev.filter(x=>x.id!==sec.id))}
                      style={{padding:"1px 6px",border:"none",background:"#fee2e2",color:"#ef4444",borderRadius:4,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{fontSize:10,color:"#64748b",width:44,flexShrink:0}}>Degrees</span>
                    <button onClick={()=>setSectionPitchModalId(sec.id)}
                      style={{width:62,textAlign:"left",padding:"2px 6px",border:"1px solid #e2e8f0",borderRadius:4,fontSize:11,fontFamily:"inherit",
                        background:"#fff",cursor:"pointer",color:gs?.pitchUnknown?"#94a3b8":"#0f172a"}}>
                      {gs?.pitchUnknown ? "Set…" : `${(deriveSectionPitchInput(sec.pitch)?.angleDeg ?? 0).toFixed(2)}°`}
                    </button>
                    <span style={{fontSize:10,color:"#94a3b8"}}>{gs?.pitchUnknown ? "—" : `×${gs?.pitchFactor||1}`}</span>
                  </div>
                  <div style={{marginTop:5,fontSize:11,color:"#64748b",display:"flex",justifyContent:"space-between"}}>
                    <span>Plan: {gs?.footprint_m2||0} m²</span>
                    <span style={{color:sec.color,fontWeight:700}}>Surf: {gs?.pitchUnknown ? "—" : `${gs?.surface_m2||0} m²`}</span>
                  </div>
                  {sec.closed && (
                    <div style={{marginTop:2,fontSize:10,color:"#94a3b8",display:"flex",justifyContent:"space-between"}}>
                      <span>Perimeter: {gs?.perimeter_m||0}m</span>
                      <span>Longest edge: {gs?.longestEdge_m||0}m</span>
                    </div>
                  )}
                  {gs?.pitchUnknown && (
                    <div style={{marginTop:5,fontSize:10,color:"#b45309",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:6,padding:"5px 7px",lineHeight:1.5}}>
                      ⚠ Pitch not set. Surface Area and Cutting List will be calculated after a roof pitch is entered.
                    </div>
                  )}

                  {!gs?.pitchUnknown && (
                  <button
                    onClick={()=>setExpandedCutSections(prev=>({...prev,[sec.id]:!prev[sec.id]}))}
                    style={{marginTop:6,padding:"2px 0",border:"none",background:"transparent",color:"#3b82f6",fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                    {expanded?"▾":"▸"} Cutting list{gs?.sheet_count?` · ${gs.sheet_count} sheets`:""}
                  </button>
                  )}

                  {!gs?.pitchUnknown && expanded && (
                    <div style={{marginTop:6,paddingLeft:10,borderLeft:"2px solid #f1f5f9"}}>
                      {gs?.isUniformPlane && (
                        <div style={{fontSize:10,color:"#64748b",marginBottom:5,lineHeight:1.4}}>
                          Detected as a rectangular plane — every sheet gets the same length; the shortfall against a whole number of cover widths is normal trim waste, not a shorter sheet.
                        </div>
                      )}
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                        <span style={{fontSize:10,color:"#64748b",width:64,flexShrink:0}}>Sheet width</span>
                        <input type="number" value={sec.sheetWidthMm||762}
                          onChange={e=>setSections(prev=>prev.map(x=>x.id===sec.id?{...x,sheetWidthMm:parseFloat(e.target.value)||762}:x))}
                          style={{width:56,padding:"2px 6px",border:"1px solid #e2e8f0",borderRadius:4,fontSize:11,fontFamily:"inherit"}}/>
                        <span style={{fontSize:10,color:"#94a3b8"}}>mm cover</span>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                        <span style={{fontSize:10,color:"#64748b",width:64,flexShrink:0}}>Roof Direction</span>
                        <input type="number" min={0} max={179}
                          value={sec.cutAngleDeg ?? Math.round(gs?.pitchAngleDeg ?? 0)}
                          onChange={e=>{
                            const v = e.target.value
                            // ← Typing a plain number means the section no longer
                            //   follows a drawn line's exact position, only its
                            //   angle — clear the stale anchor so the stripe grid
                            //   goes back to starting at the shape's own edge.
                            setSections(prev=>prev.map(x=>x.id===sec.id?{...x,cutAngleDeg:v===""?null:((parseFloat(v)%180+180)%180),cutAngleAnchor:null}:x))
                          }}
                          style={{width:56,padding:"2px 6px",border:"1px solid #e2e8f0",borderRadius:4,fontSize:11,fontFamily:"inherit"}}/>
                        <span style={{fontSize:10,color:"#94a3b8"}}>°</span>
                        <button onClick={()=>{setCutAngleDrawSectionId(sec.id);setCutAngleLine(null);setDrawPts([]);setActiveTool("cutangle")}}
                          title="Click two points on the photo (e.g. along a visible rafter/ridge line) to set this angle"
                          style={{padding:"1px 6px",border:`1px solid ${activeTool==="cutangle"&&cutAngleDrawSectionId===sec.id?"#f59e0b":"#e2e8f0"}`,background:activeTool==="cutangle"&&cutAngleDrawSectionId===sec.id?"#fffbeb":"transparent",color:"#64748b",borderRadius:4,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
                          🧭
                        </button>
                        {sec.cutAngleDeg!=null && (
                          <button onClick={()=>setSections(prev=>prev.map(x=>x.id===sec.id?{...x,cutAngleDeg:null,cutAngleAnchor:null}:x))}
                            style={{padding:"1px 6px",border:"1px solid #e2e8f0",background:"transparent",color:"#64748b",borderRadius:4,fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>
                            Reset
                          </button>
                        )}
                      </div>
                      <input type="range" min={0} max={179} step={1}
                        value={sec.cutAngleDeg ?? Math.round(gs?.pitchAngleDeg ?? 0)}
                        onChange={e=>setSections(prev=>prev.map(x=>x.id===sec.id?{...x,cutAngleDeg:parseFloat(e.target.value),cutAngleAnchor:null}:x))}
                        style={{width:"100%",marginBottom:5}}/>
                      {gs?.sheetsTooMany && (
                        <div style={{fontSize:10,color:"#ef4444",marginBottom:4}}>
                          Sheet width is too small for this section's scale — increase "Sheet width" or re-check Calibrate Image, then try again.
                        </div>
                      )}
                      <div style={{fontSize:11,color:"#64748b",display:"flex",justifyContent:"space-between",marginBottom:4}}>
                        <span>{gs?.sheet_count||0} sheet{gs?.sheet_count===1?"":"s"}</span>
                        <span>longest {gs?.sheet_length_m||0} m</span>
                      </div>
                      {gs?.sheets?.length>0 && (() => {
                        // ← Group RoofSheet objects by length (rounded to
                        //   the nearest cm) so identical cuts collapse into
                        //   one row with a quantity, like a real cutting list.
                        const groups = new Map()
                        gs.sheets.forEach(sh=>{
                          const key = Math.round(sh.lengthM*100)
                          if(!groups.has(key)) groups.set(key, { lengthM: key/100, qty:0, material: sh.material, plane: sec.name })
                          groups.get(key).qty++
                        })
                        const rows = [...groups.values()].sort((a,b)=>b.lengthM-a.lengthM)
                        return (
                          <table style={{width:"100%",borderCollapse:"collapse",marginBottom:4}}>
                            <thead>
                              <tr style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:.3}}>
                                <th style={{textAlign:"left",fontWeight:600,padding:"2px 4px 2px 0"}}>Length</th>
                                <th style={{textAlign:"right",fontWeight:600,padding:"2px 4px"}}>Qty</th>
                                <th style={{textAlign:"left",fontWeight:600,padding:"2px 4px"}}>Material</th>
                                <th style={{textAlign:"left",fontWeight:600,padding:"2px 0 2px 4px"}}>Plane</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((r,ri)=>(
                                <tr key={ri} style={{fontSize:11,color:"#334155",borderTop:"1px solid #f1f5f9"}}>
                                  <td style={{padding:"3px 4px 3px 0"}}>{r.lengthM.toFixed(2)}m</td>
                                  <td style={{textAlign:"right",padding:"3px 4px"}}>{r.qty}</td>
                                  <td style={{padding:"3px 4px",color:r.material?"#334155":"#94a3b8"}}>{r.material||"—"}</td>
                                  <td style={{padding:"3px 0 3px 4px"}}>{r.plane}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )
                      })()}
                      {sec.cutAngleDeg==null && (
                        <div style={{fontSize:10,color:"#94a3b8",marginTop:4}}>
                          {gs?.pitchAngleDeg!=null ? `Using pitch angle (${gs.pitchAngleDeg}°). Drag above to override.` : "Direction auto-detected from shape. Drag above to set an exact angle."}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {geometry.total_surface_m2>0&&(
              <div style={{paddingTop:8,borderTop:"1px solid #e2e8f0",display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:700}}>
                <span>Total</span>
                <span style={{color:"#f59e0b"}}>{geometry.total_surface_m2} m²</span>
              </div>
            )}
          </div>

          {dimensionLines.length>0 && (
            <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:10,padding:12}}>
              <div style={{fontSize:11,fontWeight:600,color:"#64748b",textTransform:"uppercase",letterSpacing:.5,marginBottom:10}}>Dimensions</div>
              {dimensionLines.map(l=>{
                const hidden = !!hiddenDimensionLines[l.id]
                const distM = Math.hypot(l.p2.x-l.p1.x,l.p2.y-l.p1.y)*(mPerPx||0.05)
                return (
                  <div key={l.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,opacity:hidden?0.5:1}}>
                    <div style={{width:10,height:10,borderRadius:2,background:"#ec4899",flexShrink:0}}/>
                    <span style={{flex:1,fontSize:12,color:"#0f172a",fontWeight:600}}>{distM.toFixed(2)}m</span>
                    <button onClick={()=>setHiddenDimensionLines(prev=>({...prev,[l.id]:!prev[l.id]}))}
                      title={hidden?"Show this dimension on the canvas":"Hide this dimension on the canvas"}
                      style={{padding:"1px 6px",border:"none",background:hidden?"#e2e8f0":"#f1f5f9",color:hidden?"#64748b":"#475569",borderRadius:4,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>
                      {hidden?"🚫":"👁"}
                    </button>
                    <button onClick={()=>setDimensionLines(prev=>prev.filter(x=>x.id!==l.id))}
                      style={{padding:"1px 6px",border:"none",background:"#fee2e2",color:"#ef4444",borderRadius:4,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
                  </div>
                )
              })}
            </div>
          )}

          <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:10,padding:12}}>
            <div style={{fontSize:11,fontWeight:600,color:"#64748b",textTransform:"uppercase",letterSpacing:.5,marginBottom:8}}>Accessories</div>
            {[
              {label:"Flashings",   val:`${geometry.accessories.flashings.length} runs · ${geometry.total_flashing_m}m`,  color:"#f59e0b"},
              {label:"Gutters",     val:`${geometry.accessories.gutters.length} runs · ${geometry.total_gutter_m}m`,       color:"#06b6d4"},
              {label:"Downpipes",   val:`${geometry.accessories.downpipes.length} placed`,                                 color:"#0ea5e9"},
              {label:"Drains",      val:`${geometry.accessories.drains.length} placed`,                                    color:"#6366f1"},
              {label:"Penetrations",val:`${geometry.accessories.penetrations.length} placed`,                              color:"#8b5cf6"},
            ].map(item=>(
              <div key={item.label} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid #f1f5f9",fontSize:11}}>
                <span style={{display:"flex",alignItems:"center",gap:5}}>
                  <span style={{width:7,height:7,borderRadius:"50%",background:item.color,display:"inline-block"}}/>
                  {item.label}
                </span>
                <span style={{color:"#475569",fontWeight:500}}>{item.val}</span>
              </div>
            ))}
          </div>

          <div style={{background:asbestos?"#fff7ed":"#fff",border:`1px solid ${asbestos?"#f97316":"#e2e8f0"}`,borderRadius:10,padding:12,transition:"all .2s"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:asbestos?"#c2410c":"#0f172a"}}>⚠ Asbestos Risk</div>
                <div style={{fontSize:10,color:"#94a3b8",marginTop:1}}>Flags job for site visit & escalation</div>
              </div>
              <div onClick={()=>setAsbestos(prev=>!prev)}
                style={{width:38,height:21,borderRadius:10,background:asbestos?"#f97316":"#cbd5e1",cursor:"pointer",position:"relative",transition:"all .2s",flexShrink:0}}>
                <div style={{position:"absolute",top:2.5,left:asbestos?17:2.5,width:16,height:16,borderRadius:"50%",background:"#fff",transition:"all .2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/>
              </div>
            </div>
            {asbestos&&(
              <div style={{marginTop:10,padding:8,background:"#fff7ed",borderRadius:6,border:"1px solid #fed7aa",fontSize:11,color:"#c2410c",lineHeight:1.7}}>
                🚨 <strong>Site visit required</strong> before quoting. Do not disturb existing roofing material. Escalate to asbestos assessment.
              </div>
            )}
          </div>
        </div>
      </div>

      {protractor && (
        <ProtractorOverlay
          initialImage={imgRef.current}
          onClose={()=>setProtractor(null)}
          confirmLabel={
            protractor.target==="pitchModal" || protractor.target==="flashingPitch" ? "Use this angle"
            : protractor.target ? `Apply to ${sections.find(x=>x.id===protractor.target)?.name || "section"}`
            : "Done"
          }
          onConfirm={deg=>{
            if(protractor.target==="flashingPitch"){
              setPendingFlashingPitch(deg.toFixed(2))
            } else if(protractor.target==="pitchModal"){
              // Both fields matter: confirmPitch() builds the saved value
              // from rawInput, so setting angleDeg alone would display the
              // measured number but store the old one.
              setPendingSectionPitch({ rawInput: deg.toFixed(2), angleDeg: deg })
            } else if(protractor.target){
              pushHistory()
              setSections(prev=>prev.map(x=>x.id===protractor.target?{...x,pitch:`${deg.toFixed(2)}°`}:x))
            }
            setProtractor(null)
          }}/>
      )}

      {calibModalOpen && (
        <Modal title="Calibrate Image" onClose={cancelCalibration} width={360}>
          <div style={{fontSize:12,color:"#64748b",marginBottom:12,lineHeight:1.6}}>
            Enter the real-world length of the line you just drew.
            {scaleLines.length>0 && ` You already have ${scaleLines.length} reference${scaleLines.length===1?"":"s"} — this one will be averaged with ${scaleLines.length===1?"it":"them"} for a more accurate scale.`}
          </div>
          <div style={{display:"flex",gap:8,marginBottom:16}}>
            <input
              type="number" min="0.001" step="any" autoFocus value={calibInput}
              onChange={e=>setCalibInput(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter") applyCalibration(); if(e.key==="Escape") cancelCalibration() }}
              placeholder={CALIB_UNITS.find(u=>u.key===calibUnit)?.placeholder || "e.g. 3"}
              style={{...s.input,flex:1}}/>
            <select value={calibUnit} onChange={e=>setCalibUnit(e.target.value)} style={{...s.input,width:80}}>
              {CALIB_UNITS.map(u=><option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
          </div>
          <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
            <Btn onClick={cancelCalibration}>Cancel</Btn>
            <Btn primary onClick={applyCalibration} style={{opacity:(parseFloat(calibInput)>0)?1:.5}}>Apply Scale</Btn>
          </div>
        </Modal>
      )}

      {sectionPitchModalId && (() => {
        const section = sections.find(s=>s.id===sectionPitchModalId)
        // ← A roof plane can't reach 90°/vertical — that's a wall, not a
        //   roof — so the ceiling sits comfortably under that hard physical
        //   limit (1/cos(90°) is undefined).
        const MAX_PITCH_DEG = 85
        // ← Canonical state while the dialog is open: `angleDeg` is the one
        //   true numeric source of truth (full precision), `rawInput` is
        //   exactly what's in the editable field. Degrees-only — seeded via
        //   deriveSectionPitchInput, which still understands a legacy
        //   ratio-format string (e.g. "5:12") from before this dialog was
        //   simplified, converting it to its equivalent angle so old data
        //   keeps opening correctly even though editing is degrees-only now.
        const pending = pendingSectionPitch || (() => {
          const derived = deriveSectionPitchInput(section?.pitch)
          return derived
            ? { angleDeg: derived.angleDeg, rawInput: String(Math.round(derived.angleDeg*10)/10) }
            : { angleDeg: null, rawInput: "" }
        })()
        const angleDeg = pending.angleDeg
        const updateActive = (raw) => {
          const v = parseFloat(raw)
          const newAngle = raw==="" ? null : (isNaN(v) ? angleDeg : v)
          setPendingSectionPitch({ rawInput: raw, angleDeg: newAngle })
        }
        let pitchError = null
        if(pending.rawInput!==""){
          if(isNaN(angleDeg) || angleDeg<0 || angleDeg>=90){
            pitchError = `A roof pitch cannot be 90°. A 90° surface is a wall, not a roof plane.`
          } else if(angleDeg>=MAX_PITCH_DEG){
            pitchError = `Enter an angle between 0° and ${MAX_PITCH_DEG}°.`
          }
        }
        const hasValidAngle = angleDeg!=null && !isNaN(angleDeg) && !pitchError
        const multiplier = hasValidAngle ? 1/Math.cos(Math.min(angleDeg,89)*Math.PI/180) : null
        const gsForModal = geometry.sections.find(x=>x.id===sectionPitchModalId)
        const planArea = gsForModal?.footprint_m2 ?? 0
        const surfaceAreaPreview = multiplier!=null ? planArea*multiplier : null
        const equivRatioDisplay = hasValidAngle ? `${Math.round(12*Math.tan(angleDeg*Math.PI/180)*100)/100} : 12` : "—"
        const closeModal = () => { setSectionPitchModalId(null); setPendingSectionPitch(null) }
        const confirmPitch = () => {
          if(pending.rawInput==="" || pitchError) return
          const id = sectionPitchModalId
          const pitch = `${pending.rawInput}°`
          setSections(prev=>prev.map(s=>s.id===id?{...s,pitch}:s))
          closeModal()
          // ← Only chain into the brand-picker for a section that doesn't
          //   have a material yet (the original "just finished tracing"
          //   flow) — re-editing an already-configured section's pitch from
          //   the sidebar shouldn't force a re-pick of its material every time.
          if(!section?.materialLabel) setSectionMaterialModalId(id)
        }
        return (
        <Modal title="Roof Pitch" onClose={closeModal} width={380}>
          <div style={{fontSize:12,color:"#64748b",marginBottom:12,lineHeight:1.6}}>
            What's the pitch of <strong>{section?.name}</strong>? You can fine-tune this later from the sidebar.
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:pitchError?4:14}}>
            <span style={{fontSize:11,color:"#64748b",width:56,flexShrink:0}}>Degrees</span>
            <input type="number" min="0" max={MAX_PITCH_DEG} step="any" autoFocus value={pending.rawInput}
              onChange={e=>updateActive(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter" && pending.rawInput && !pitchError) confirmPitch() }}
              placeholder="e.g. 22.62"
              style={{...s.input,flex:1,...(pitchError?{borderColor:"#ef4444"}:{})}}/>
            <span style={{fontSize:13,color:"#64748b",fontWeight:600}}>°</span>
            {/* ← Measure it off a photo instead of typing it. Fills the field
                rather than saving outright, so the number can still be
                eyeballed and nudged before Save. */}
            <button type="button" onClick={()=>setProtractor({ target:"pitchModal" })}
              title="Measure the pitch from a photo with the protractor"
              style={{padding:"7px 9px",borderRadius:8,border:"1px solid #e2e8f0",background:"#f8fafc",
                cursor:"pointer",fontSize:14,lineHeight:1,flexShrink:0,fontFamily:"inherit"}}>
              📐
            </button>
          </div>
          {pitchError && (
            <div style={{fontSize:11,color:"#ef4444",marginBottom:12}}>{pitchError}</div>
          )}
          <div style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"10px 12px",marginBottom:16,display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
              <span style={{color:"#64748b"}}>Equivalent Ratio</span>
              <span style={{fontWeight:600}}>{equivRatioDisplay}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
              <span style={{color:"#64748b"}}>Surface Multiplier</span>
              <span style={{fontWeight:600}}>{multiplier!=null ? `×${multiplier.toFixed(3)}` : "—"}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
              <span style={{color:"#64748b"}}>Plan Area</span>
              <span style={{fontWeight:600}}>{planArea.toFixed(2)} m²</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
              <span style={{color:"#64748b"}}>Surface Area</span>
              <span style={{fontWeight:700,color:"#f59e0b"}}>{surfaceAreaPreview!=null ? `${surfaceAreaPreview.toFixed(2)} m²` : "—"}</span>
            </div>
          </div>
          <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
            <Btn primary style={{opacity:(pending.rawInput && !pitchError)?1:.5}} onClick={confirmPitch}>Save</Btn>
          </div>
        </Modal>
        )
      })()}

      {sectionMaterialModalId && (
        <Modal title="Roof Sheet Brand" onClose={()=>{ setSectionMaterialModalId(null); setPendingSectionMaterial(null) }} width={420}>
          <div style={{fontSize:12,color:"#64748b",marginBottom:12,lineHeight:1.6}}>
            What roof sheet will <strong>{sections.find(s=>s.id===sectionMaterialModalId)?.name}</strong> be covered in?
            You can change this later in the Estimate step.
          </div>
          <MaterialPicker
            group="roof_sheet"
            value={pendingSectionMaterial?.label ?? sections.find(s=>s.id===sectionMaterialModalId)?.materialLabel ?? ""}
            onSelect={({label,rate,coverWidth})=>setPendingSectionMaterial({label,rate,coverWidth})}
          />
          <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:16}}>
            <Btn primary style={{opacity:pendingSectionMaterial?1:.5}} onClick={()=>{
              if(!pendingSectionMaterial) return
              const id = sectionMaterialModalId
              // ← Section is renamed to the brand picked (was "Section N")
              //   so it reads meaningfully everywhere — sidebar, canvas
              //   label, and the Estimate step's per-section list — instead
              //   of a generic number no one can tell apart.
              setSections(prev=>prev.map(s=>s.id===id?{
                ...s,
                name: pendingSectionMaterial.label,
                materialLabel: pendingSectionMaterial.label,
                rate: pendingSectionMaterial.rate,
                // ← Cutting list now spaces sheets using the picked product's
                //   real cover width instead of a generic default — only
                //   overwritten when the catalog row actually has one set.
                sheetWidthMm: pendingSectionMaterial.coverWidth>0 ? pendingSectionMaterial.coverWidth : s.sheetWidthMm,
              }:s))
              setSectionMaterialModalId(null); setPendingSectionMaterial(null)
            }}>Save</Btn>
          </div>
        </Modal>
      )}

      {flashingPitchModal && (() => {
        const { id, subtype } = flashingPitchModal
        const label = flashingLabel(subtype)
        const MAX = 85
        // Prefill, best first: a pitch already set for this subtype, else the
        // roof's own pitch when every traced section agrees on one — a valley
        // almost always sits on the plane you just pitched.
        const existing = lineItems.find(l=>l.type==="flashing" && l.subtype===subtype && l.pitchDeg>0)?.pitchDeg
        const secAngles = sections.map(s=>deriveSectionPitchInput(s.pitch)?.angleDeg).filter(a=>a!=null)
        const uniformSec = secAngles.length && secAngles.every(a=>Math.abs(a-secAngles[0])<0.01) ? secAngles[0] : null
        const seed = existing ?? uniformSec
        const raw = pendingFlashingPitch !== "" ? pendingFlashingPitch : (seed!=null ? String(Math.round(seed*100)/100) : "")
        const deg = parseFloat(raw)
        const valid = raw!=="" && !isNaN(deg) && deg>=0 && deg<MAX
        const err = raw!=="" && !valid ? `Enter an angle between 0° and ${MAX}°.` : null
        // Every run of this subtype, since the pitch applies to all of them.
        const planLen = geometry.accessories.flashings
          .filter(f=>f.subtype===subtype)
          .reduce((a,f)=>a+(f.length_m||0),0)
        const mult = valid ? flashingSlopeMult(deg) : null
        const close = () => { setFlashingPitchModal(null); setPendingFlashingPitch("") }
        const save = () => {
          if(!valid) return
          // Applied to every run of this subtype, matching how the brand /
          // rate popup already behaves — a roof's valleys shouldn't disagree.
          setLineItems(prev=>prev.map(l=> l.type==="flashing"&&l.subtype===subtype ? {...l, pitchDeg:deg} : l))
          close()
          setAccessoryModal({ kind:"flashing", id, subtype })
        }
        return (
        <Modal title={`${label} Pitch`} onClose={close} width={380}>
          <div style={{fontSize:12,color:"#64748b",marginBottom:12,lineHeight:1.6}}>
            What pitch does this <strong>{label.toLowerCase()}</strong> run at? It was traced on a flat photo,
            so its ordered length is corrected up by the slope. Applies to every {label.toLowerCase()} run.
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:err?4:14}}>
            <span style={{fontSize:11,color:"#64748b",width:56,flexShrink:0}}>Degrees</span>
            <input type="number" min="0" max={MAX} step="any" autoFocus value={raw}
              onChange={e=>setPendingFlashingPitch(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter" && valid) save() }}
              placeholder="e.g. 22.62"
              style={{...s.input,flex:1,...(err?{borderColor:"#ef4444"}:{})}}/>
            <span style={{fontSize:13,color:"#64748b",fontWeight:600}}>°</span>
            <button type="button" onClick={()=>setProtractor({ target:"flashingPitch" })}
              title="Measure the pitch from a photo with the protractor"
              style={{padding:"7px 9px",borderRadius:8,border:"1px solid #e2e8f0",background:"#f8fafc",
                cursor:"pointer",fontSize:14,lineHeight:1,flexShrink:0,fontFamily:"inherit"}}>
              📐
            </button>
          </div>
          {err && <div style={{fontSize:11,color:"#ef4444",marginBottom:12}}>{err}</div>}
          <div style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"10px 12px",marginBottom:16,display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
              <span style={{color:"#64748b"}}>Traced (plan) length</span>
              <span style={{fontWeight:600}}>{planLen.toFixed(2)} m</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
              <span style={{color:"#64748b"}}>Slope Multiplier</span>
              <span style={{fontWeight:600}}>{mult!=null ? `×${mult.toFixed(3)}` : "—"}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
              <span style={{color:"#64748b"}}>Length to order</span>
              <span style={{fontWeight:700,color:"#f59e0b"}}>{mult!=null ? `${(planLen*mult).toFixed(2)} m` : "—"}</span>
            </div>
          </div>
          <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
            <Btn primary style={{opacity:valid?1:.5}} onClick={save}>Save</Btn>
          </div>
        </Modal>
        )
      })()}

      {downpipeLengthModalId && (() => {
        const stockLengths = (company?.downpipeStockLengths || "1.8,2.4").split(",").map(Number).filter(n=>n>0)
        const lengthM = parseFloat(pendingDownpipeLength)
        const preview = lengthM>0 ? calculateDownpipe(lengthM, stockLengths) : null
        const closeModal = () => { setDownpipeLengthModalId(null); setPendingDownpipeLength("") }
        const confirmLength = () => {
          if(!(lengthM>0)) return
          const calc = calculateDownpipe(lengthM, stockLengths)
          const id = downpipeLengthModalId
          setPtItems(prev=>prev.map(p=>p.id===id?{...p,length_m:lengthM,quantity:calc.quantity,preferredLength:calc.preferredLength,waste:calc.waste}:p))
          closeModal()
          // ← Chains straight into the existing, unmodified brand-picker
          //   flow (ACCESSORY_MODAL_CONFIG.downpipe below) — same "confirm
          //   this, then open the next modal" shape as Roof Pitch → Roof
          //   Sheet Brand above.
          setAccessoryModal({kind:"downpipe", id})
        }
        return (
        <Modal title="Downpipe Length" onClose={closeModal} width={380}>
          <div style={{fontSize:12,color:"#64748b",marginBottom:12,lineHeight:1.6}}>
            How long is this downpipe run? Used to work out how many stock lengths ({stockLengths.join("m / ")}m) to order and how much gets wasted.
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:preview?4:14}}>
            <input type="number" min="0" step="any" autoFocus value={pendingDownpipeLength}
              onChange={e=>setPendingDownpipeLength(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter" && lengthM>0) confirmLength() }}
              placeholder="e.g. 5.2"
              style={{...s.input,flex:1}}/>
            <span style={{fontSize:13,color:"#64748b",fontWeight:600}}>m</span>
          </div>
          {preview && (
            <div style={{fontSize:12,color:"#475569",background:"#f8fafc",borderRadius:8,padding:10,marginBottom:14,lineHeight:1.7}}>
              → <strong>{preview.quantity} × {preview.preferredLength}m</strong> piece{preview.quantity===1?"":"s"} (waste {preview.waste}m)
            </div>
          )}
          <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
            <Btn onClick={closeModal}>Cancel</Btn>
            <Btn primary onClick={confirmLength} style={{opacity:lengthM>0?1:.5}}>Continue</Btn>
          </div>
        </Modal>
        )
      })()}

      {accessoryModal && (() => {
        const cfg = ACCESSORY_MODAL_CONFIG[accessoryModal.kind]
        const subLabel = accessoryModal.kind==="flashing" ? flashingLabel(accessoryModal.subtype) : ""
        // ← A subtype may already have a brand from an earlier segment (this
        //   is at least its 2nd traced Ridge Cap, say) — pre-fill with that
        //   instead of blank, so re-tracing the same subtype doesn't look
        //   like it forgot what you already picked.
        const existingLabel = accessoryModal.kind==="flashing"
          ? lineItems.find(li=>li.type==="flashing"&&li.subtype===accessoryModal.subtype&&li.materialLabel)?.materialLabel ?? ""
          : ""
        return (
        <Modal title={subLabel ? `${subLabel} Flashing Brand` : cfg.title}
          onClose={()=>{ setAccessoryModal(null); setPendingAccessoryMaterial(null) }} width={420}>
          <div style={{fontSize:12,color:"#64748b",marginBottom:12,lineHeight:1.6}}>
            {subLabel ? `What product will the ${subLabel} flashing use?` : cfg.prompt}
            {" "}You can change this later in the Estimate step.
          </div>
          <MaterialPicker
            group={cfg.group}
            unit={cfg.unit}
            catalogUnit={cfg.catalogUnit}
            value={pendingAccessoryMaterial?.label ?? existingLabel}
            onSelect={({label,rate})=>setPendingAccessoryMaterial({label,rate})}
          />
          <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:16}}>
            <Btn primary style={{opacity:pendingAccessoryMaterial?1:.5}} onClick={saveAccessoryMaterial}>Save</Btn>
          </div>
        </Modal>
        )
      })()}

      {lineContextMenu && (
        <>
          <div onClick={()=>setLineContextMenu(null)}
            style={{position:"fixed",inset:0,zIndex:998}}/>
          <div style={{position:"fixed",left:lineContextMenu.x,top:lineContextMenu.y,zIndex:999,
            background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,boxShadow:"0 4px 16px rgba(0,0,0,0.15)",
            minWidth:120,padding:4,fontFamily:"inherit"}}>
            <button onClick={()=>{ finishLine(); setLineContextMenu(null) }}
              style={{display:"block",width:"100%",textAlign:"left",padding:"7px 10px",border:"none",background:"transparent",
                borderRadius:6,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}
              onMouseEnter={e=>e.currentTarget.style.background="#f1f5f9"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              New Line
            </button>
            <div style={{height:1,background:"#f1f5f9",margin:"2px 0"}}/>
            <button onClick={()=>{ finishLine(); setActiveTool("select"); setLineContextMenu(null) }}
              style={{display:"block",width:"100%",textAlign:"left",padding:"7px 10px",border:"none",background:"transparent",
                borderRadius:6,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}
              onMouseEnter={e=>e.currentTarget.style.background="#f1f5f9"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              Stop
            </button>
          </div>
        </>
      )}
      {pastePopup && (
        <>
          <div onClick={()=>setPastePopup(null)}
            style={{position:"fixed",inset:0,zIndex:998}}/>
          <div style={{position:"fixed",left:pastePopup.x,top:pastePopup.y,zIndex:999,
            background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,boxShadow:"0 4px 16px rgba(0,0,0,0.15)",
            minWidth:120,padding:4,fontFamily:"inherit"}}>
            <button onClick={()=>{ pasteShapes(pastePopup.worldPt); setPastePopup(null) }}
              style={{display:"block",width:"100%",textAlign:"left",padding:"7px 10px",border:"none",background:"transparent",
                borderRadius:6,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}
              onMouseEnter={e=>e.currentTarget.style.background="#f1f5f9"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              📋 Paste
            </button>
          </div>
        </>
      )}
    </div>
  )
});

// ─────────────────────────── ESTIMATE ENGINE ───────────────────────────
// ─── Searchable combobox over the supplier material price catalog ───────────
// Debounces server-side search (min 2 chars) instead of shipping the whole
// multi-thousand-row catalog to the client. `group` (roof_sheet/flashing)
// restricts results to that product family server-side — the catalog's
// `type` column otherwise mixes cladding profiles with unrelated hardware
// (gutters, downpipes, sealant, fixings...), see product_group on
// roof_materials (migrations/13_add_material_product_group.sql).
// Matches backend/routes/materials.js's NO_SUPPLIER sentinel — some catalog
// rows (generic gutter brackets, downpipes, etc.) have no supplier at all,
// so "supplier = ''" can't be used to mean "explicitly generic" the way it
// normally means "nothing selected yet"; this sentinel disambiguates it.
const NO_SUPPLIER = "__no_supplier__"

function MaterialPicker({ value, onSelect, unit="m2", group="", catalogUnit="" }) {
  const { currency } = useCurrency()
  const cs = currency?.symbol || "$"
  const [query,   setQuery]   = useState(value || "")
  const [results, setResults] = useState([])
  const [open,    setOpen]    = useState(false)
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef(null)
  const boxRef = useRef(null)
  const inputRef = useRef(null)
  const menuRef = useRef(null)
  const [menuStyle, setMenuStyle] = useState(null)

  // ── Cascading Supplier → Type → Material dropdowns ──────────────────
  const [suppliers,       setSuppliers]       = useState([])
  const [types,           setTypes]           = useState([])
  const [byTypeMaterials, setByTypeMaterials] = useState([])
  const [supplier,        setSupplier]        = useState("")
  const [type,            setType]            = useState("")
  const [materialId,      setMaterialId]      = useState("")
  // ← Target {supplier,type,materialId} we're trying to populate the
  //   cascade with, resolved from an already-picked `value` (e.g. reopening
  //   a section/run that already has a material saved) — without this the
  //   dropdowns stayed blank even though the search box showed the value.
  const restoreRef = useRef(null)

  useEffect(()=>{ materialsApi.getSuppliers().then(setSuppliers).catch(()=>setSuppliers([])) },[])

  useEffect(()=>{
    if(!value || supplier) return
    materialsApi.search(value, group, catalogUnit).then(rows=>{
      const m = rows.find(r=>(r.supplier?`${r.supplier} — ${r.description}`:r.description)===value) || rows[0]
      if(!m) return
      const sup = m.supplier || NO_SUPPLIER
      restoreRef.current = { supplier:sup, type:m.type||"", materialId:m.id }
      setSupplier(sup)
    }).catch(()=>{})
  },[value])

  useEffect(()=>{
    const restoring = restoreRef.current?.supplier===supplier
    if(!restoring){ setType(""); setMaterialId(""); setByTypeMaterials([]); restoreRef.current=null }
    if(!supplier){ setTypes([]); return }
    materialsApi.getTypes(supplier, group, catalogUnit)
      .then(rows=>{
        setTypes(rows)
        if(restoreRef.current?.supplier===supplier) setType(restoreRef.current.type)
      })
      .catch(()=>setTypes([]))
  },[supplier, group, catalogUnit])

  useEffect(()=>{
    const restoring = restoreRef.current?.supplier===supplier && restoreRef.current?.type===type
    if(!restoring) setMaterialId("")
    if(!supplier || !type){ setByTypeMaterials([]); return }
    materialsApi.getByType(supplier, type, group, catalogUnit).then(rows=>{
      setByTypeMaterials(rows)
      if(restoring){ setMaterialId(restoreRef.current.materialId); restoreRef.current=null }
    }).catch(()=>setByTypeMaterials([]))
  },[supplier, type, group, catalogUnit])

  function pickFromDropdown(id) {
    setMaterialId(id)
    const m = byTypeMaterials.find(x=>x.id===id)
    if(m) pick(m)
  }

  useEffect(()=>{ setQuery(value || "") },[value])

  useEffect(()=>{
    function onDocClick(e){
      const insideBox  = boxRef.current  && boxRef.current.contains(e.target)
      const insideMenu = menuRef.current && menuRef.current.contains(e.target)
      if(!insideBox && !insideMenu) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return ()=>document.removeEventListener("mousedown", onDocClick)
  },[])

  // The dropdown is portaled to <body> (see render below) so it can't be
  // clipped by the modal body's `overflow-y:auto` — without this, results
  // past the modal's visible edge were rendered but invisible, cut off
  // mid-row (reported: search results "cut off" in the roof sheet/flashing/
  // gutter/drain/penetration material pickers, all of which share this
  // component). Position is computed from the input's own bounding rect
  // in viewport (fixed) coordinates, and flips upward when there isn't
  // room below — recalculated on scroll/resize since the modal body itself
  // scrolls independently of the window.
  useEffect(()=>{
    if(!open || query.trim().length<2){ setMenuStyle(null); return }
    function updatePosition() {
      const el = inputRef.current
      if(!el) return
      const rect = el.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceAbove = rect.top
      const openUp = spaceBelow < 160 && spaceAbove > spaceBelow
      setMenuStyle({
        position: "fixed",
        left: rect.left,
        width: rect.width,
        zIndex: 2000,
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(120, Math.min(280, spaceAbove - 12)) }
          : { top: rect.bottom + 4, maxHeight: Math.max(120, Math.min(280, spaceBelow - 12)) }),
      })
    }
    updatePosition()
    window.addEventListener("scroll", updatePosition, true)
    window.addEventListener("resize", updatePosition)
    return ()=>{
      window.removeEventListener("scroll", updatePosition, true)
      window.removeEventListener("resize", updatePosition)
    }
  },[open, query])

  function handleChange(v) {
    setQuery(v)
    setOpen(true)
    clearTimeout(debounceRef.current)
    if(v.trim().length < 2){ setResults([]); return }
    setLoading(true)
    debounceRef.current = setTimeout(()=>{
      materialsApi.search(v.trim(), group, catalogUnit)
        .then(setResults)
        .catch(()=>setResults([]))
        .finally(()=>setLoading(false))
    }, 300)
  }

  // Flashing/gutter SKUs are already priced per lineal metre by the
  // supplier — reusing the m² cladding conversion (rate_lm ÷ cover_width)
  // on them produces the wrong unit. "each"-priced fittings (downpipes,
  // drains, penetration boots) store the same flat price in both rate
  // columns (confirmed against the catalog), so neither needs conversion —
  // the three picker modes derive rate differently.
  function pick(m) {
    const label = m.supplier ? `${m.supplier} — ${m.description}` : m.description
    const rate  = unit==="each" ? (m.rateLm ?? m.rateM2 ?? 0)
      : unit==="lm" ? (m.rateLm ?? (m.rateM2 && m.coverWidth ? m.rateM2 * (m.coverWidth/1000) : 0))
      : (m.rateM2 ?? (m.rateLm && m.coverWidth ? m.rateLm / (m.coverWidth/1000) : 0))
    // ← coverWidth passed through (not just used for the rate math above)
    //   so callers that need the real sheet width later — e.g. handing a
    //   section off to the Cutting List tool — don't have to re-fetch it.
    onSelect({ label, rate: parseFloat(rate.toFixed(2)), coverWidth: m.coverWidth||0 })
    setQuery(label)
    setOpen(false)
  }

  // Mirrors pick()'s unit preference so the displayed rate always matches what gets applied.
  function displayRate(m) {
    if(unit==="each") return m.rateLm ? `${cs}${m.rateLm.toFixed(2)} ea` : m.rateM2 ? `${cs}${m.rateM2.toFixed(2)} ea` : "no rate"
    if(unit==="lm") return m.rateLm ? `${cs}${m.rateLm.toFixed(2)}/lm` : m.rateM2 ? `${cs}${m.rateM2.toFixed(2)}/m²` : "no rate"
    return m.rateM2 ? `${cs}${m.rateM2.toFixed(2)}/m²` : m.rateLm ? `${cs}${m.rateLm.toFixed(2)}/lm` : "no rate"
  }

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:8}} className="grid2-responsive">
        <select style={s.input} value={supplier} onChange={ev=>setSupplier(ev.target.value)}>
          <option value="">— Supplier —</option>
          <option value={NO_SUPPLIER}>— No Supplier / Generic —</option>
          {suppliers.map(sup=><option key={sup} value={sup}>{sup}</option>)}
        </select>
        <select style={s.input} value={type} onChange={ev=>setType(ev.target.value)} disabled={!supplier}>
          <option value="">{supplier?"— Type —":"Pick a supplier first"}</option>
          {types.map(t=><option key={t} value={t}>{t}</option>)}
        </select>
        <select style={s.input} value={materialId} onChange={ev=>pickFromDropdown(ev.target.value)} disabled={!type}>
          <option value="">{type?"— Material —":"Pick a type first"}</option>
          {byTypeMaterials.map(m=>
            <option key={m.id} value={m.id}>
              {m.description}{(m.rateM2||m.rateLm)?` — ${displayRate(m)}`:""}
            </option>
          )}
        </select>
      </div>
      <div style={{fontSize:11,color:"#94a3b8",margin:"2px 0 8px"}}>or search by keyword instead:</div>
      <div ref={boxRef} style={{position:"relative"}}>
      <input
        ref={inputRef}
        style={s.input}
        value={query}
        placeholder="Search supplier catalog — e.g. Dimond corrugate, Metalcraft flashing…"
        onChange={e=>handleChange(e.target.value)}
        onFocus={()=>setOpen(true)}
      />
      {open && (query.trim().length>=2) && menuStyle && createPortal(
        <div ref={menuRef} style={{...menuStyle,background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,0.12)"}}>
          {loading && <div style={{padding:"10px 14px",fontSize:12,color:"#94a3b8"}}>Searching…</div>}
          {!loading && results.length===0 && <div style={{padding:"10px 14px",fontSize:12,color:"#94a3b8"}}>No matches in supplier catalog</div>}
          {!loading && results.map(m=>(
            <div key={m.id} onClick={()=>pick(m)}
              style={{padding:"9px 14px",cursor:"pointer",borderBottom:"1px solid #f1f5f9"}}
              onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"}
              onMouseLeave={e=>e.currentTarget.style.background="#fff"}>
              <div style={{fontSize:12,fontWeight:600,color:"#0f172a"}}>{m.description}</div>
              <div style={{fontSize:11,color:"#64748b",marginTop:2}}>
                {m.supplier && <span>{m.supplier} · </span>}
                {m.coating && <span>{m.coating} · </span>}
                {m.sku && <span>{m.sku} · </span>}
                <span style={{color:"#f59e0b",fontWeight:600}}>
                  {displayRate(m)}
                </span>
              </div>
            </div>
          ))}
        </div>,
        document.body
      )}
      </div>
    </div>
  )
}

function EstimateEngine({ initialArea, initialGeometry, initialEstimate, onEstimateChange, company }) {
  const { formatMoney: fmt, currency } = useCurrency()   // ← currency-aware fmt
  const cs = currency?.symbol || "$"   // ← for labels/inline strings fmt() can't be used on (not a full money value)
  // ← Live org setting, recalculated on every render — same as currency
  //   display, so editing an in-progress estimate always reflects the
  //   organization's current GST/VAT country. Only an already-saved,
  //   finalized quote (ProjectDetail/print view) uses the frozen gst_rate
  //   that was actually applied at save time, so a past quote never
  //   silently reprices itself if the org's setting changes later.
  const { gstRate } = useTax()

  // ← Job Complexity multipliers are a global, editable list now (Job
  //   Complexity settings page) instead of a hardcoded constant — fetched
  //   once here rather than re-derived from anything baked into the build.
  const [complexityLevels, setComplexityLevels] = useState([])
  useEffect(()=>{ complexityLevelsApi.getAll().then(setComplexityLevels).catch(()=>setComplexityLevels([])) },[])

  // ← Traced flashing runs (ridge cap, valley, etc.), the gutter total, and
  //   accessory counts (downpipes/drains/penetrations) come straight from
  //   the Measure step instead of starting at 0. When editing a project,
  //   initialEstimate (the previously-saved values) wins for anything the
  //   user could have typed/chosen by hand — material, pitch, waste,
  //   labour, margin, and each flashing run's assigned material/rate —
  //   otherwise reopening a project to edit silently reset all of it.
  //   Flashing/accessory lengths & counts still always refresh from the
  //   latest trace in case the roof was re-measured.
  const [e, setE] = useState(() => {
    const savedRuns = new Map((initialEstimate?.flashingRuns||[]).map(r=>[r.subtype,r]))
    // ← Matched by section/item id, not index, so re-tracing/reordering
    //   doesn't scramble which saved rate belongs to which one.
    const savedSections = new Map((initialEstimate?.sections||[]).map(sec=>[sec.id,sec]))
    const savedGutterRuns      = new Map((initialEstimate?.gutterRuns||[]).map(g=>[g.id,g]))
    const savedDownpipeItems   = new Map((initialEstimate?.downpipeItems||[]).map(d=>[d.id,d]))
    const savedDrainItems      = new Map((initialEstimate?.drainItems||[]).map(d=>[d.id,d]))
    const savedPenetrationItems= new Map((initialEstimate?.penetrationItems||[]).map(p=>[p.id,p]))
    return {
      area: initialEstimate?.area ?? initialArea ?? 0,
      pitch: initialEstimate?.pitch ?? 1.15,
      waste: initialEstimate?.waste ?? 10,
      materialRate: initialEstimate?.materialRate ?? 55,
      materialLabel: initialEstimate?.materialLabel ?? "Long Run Steel",
      sections: (initialGeometry?.sections||[]).map(sec=>{
        const prev = savedSections.get(sec.id)
        return {
          id: sec.id, name: sec.name, surface_m2: sec.surface_m2,
          // ← Per-section pitch (Ratio "4:12" or Degrees), same
          //   saved-wins-over-retrace pattern as materialLabel/rate below —
          //   otherwise reopening a project to edit would silently reset
          //   every section back to whatever the last trace happened to
          //   carry, discarding an Estimate-step pitch edit.
          pitch: prev?.pitch ?? sec.pitch ?? null,
          pitchFactor: prev?.pitchFactor ?? sec.pitchFactor ?? null,
          footprint_m2: sec.footprint_m2 ?? prev?.footprint_m2 ?? 0,
          materialLabel: prev?.materialLabel ?? sec.materialLabel ?? "",
          rate: prev?.rate ?? sec.rate ?? 0,
        }
      }),
      flashings: initialEstimate?.flashings ?? 0,
      guttering: initialEstimate?.guttering ?? initialGeometry?.total_gutter_m ?? 0,
      downpipes: initialEstimate?.downpipes ?? initialGeometry?.accessories?.downpipes?.length ?? 0,
      drains: initialEstimate?.drains ?? initialGeometry?.accessories?.drains?.length ?? 0,
      penetrations: initialEstimate?.penetrations ?? initialGeometry?.accessories?.penetrations?.length ?? 0,
      dayRate: initialEstimate?.dayRate ?? 850,
      days: initialEstimate?.days ?? 2,
      margin: initialEstimate?.margin ?? 20,
      complexity: initialEstimate?.complexity ?? "medium",
      // ← "Saved wins over global default" — same pattern as per-section
      //   materialLabel/rate above: a project's own discount choice sticks
      //   once set, otherwise a brand-new estimate picks up the org-wide
      //   default configured in Settings.
      discountEnabled: initialEstimate?.discountEnabled ?? company?.discountEnabled ?? false,
      discountType:    initialEstimate?.discountType    ?? company?.discountType    ?? "percent",
      discountValue:   initialEstimate?.discountValue   ?? company?.discountValue   ?? 0,
      downpipeBendRate: initialEstimate?.downpipeBendRate ?? company?.downpipeBendRate ?? 15,
      spreaderRate:     initialEstimate?.spreaderRate     ?? company?.spreaderRate     ?? 45,
      flashingRuns: Object.entries(initialGeometry?.flashingBySubtype||{}).map(([subtype,length_m])=>{
        const prev = savedRuns.get(subtype)
        const traced = initialGeometry?.flashingMaterialBySubtype?.[subtype]
        return { subtype, label:flashingLabel(subtype), length_m,
          materialLabel: prev?.materialLabel ?? traced?.materialLabel ?? "",
          rate: prev?.rate ?? traced?.rate ?? 0,
          // ← Seeded from the pitch entered when the run was traced, so the
          //   slope correction is already in place by the time you get here;
          //   an edit made on this screen still wins, same as every other
          //   saved-vs-retraced field.
          angleDeg: prev?.angleDeg ?? initialGeometry?.flashingPitchBySubtype?.[subtype] ?? null }
      }),
      gutterRuns: (initialGeometry?.accessories?.gutters||[]).map(g=>{
        const prev = savedGutterRuns.get(g.id)
        return { id:g.id, length_m:g.length_m, materialLabel:prev?.materialLabel ?? g.materialLabel ?? "", rate:prev?.rate ?? g.rate ?? 0 }
      }),
      downpipeItems: (initialGeometry?.accessories?.downpipes||[]).map(d=>{
        const prev = savedDownpipeItems.get(d.id)
        return { id:d.id, materialLabel:prev?.materialLabel ?? d.materialLabel ?? "", rate:prev?.rate ?? d.rate ?? 0,
          // ← length/quantity/preferredLength/waste always come fresh from
          //   the trace (same as a section's surface_m2) — only bends/
          //   spreader are genuine Estimate-step-only edits, so those alone
          //   follow the saved-wins-over-retrace pattern.
          length_m: d.length_m ?? 0, quantity: d.quantity ?? 1, preferredLength: d.preferredLength ?? null, waste: d.waste ?? 0,
          bends: prev?.bends ?? d.bends ?? 0, spreader: prev?.spreader ?? d.spreader ?? false }
      }),
      drainItems: (initialGeometry?.accessories?.drains||[]).map(d=>{
        const prev = savedDrainItems.get(d.id)
        return { id:d.id, materialLabel:prev?.materialLabel ?? d.materialLabel ?? "", rate:prev?.rate ?? d.rate ?? 0 }
      }),
      penetrationItems: (initialGeometry?.accessories?.penetrations||[]).map(p=>{
        const prev = savedPenetrationItems.get(p.id)
        return { id:p.id, subtype:p.subtype, materialLabel:prev?.materialLabel ?? p.materialLabel ?? "", rate:prev?.rate ?? p.rate ?? 0 }
      }),
    }
  })

  // ← Resolved live against the current global list every render, same as
  //   any other rate in this app (RATES.*) — not pinned to whatever the
  //   factor was when this estimate was first created.
  const complexityFactorValue = complexityLevels.find(c=>c.key===e.complexity)?.factor ?? 1
  const result = useMemo(()=>calcEst({...e, complexityFactor:complexityFactorValue, gstRate}),[e, complexityFactorValue, gstRate])
  useEffect(()=>{ onEstimateChange?.(result) },[result, onEstimateChange])

  // Same wastage % calcEst applies to flashing/gutter cost — recomputed
  // here so the displayed length matches what's actually being costed.
  const wasteFactor = 1 + (e.waste||0)/100

  // ← Whether each accessory was actually traced/saved at all, checked once
  //   against the props that seeded `e` (not the live `e` value) — so the
  //   field disappears when nothing was measured, but doesn't vanish out
  //   from under you just because you type it down to 0 while editing.
  const hasFlashingFallback = e.flashings>0 || (initialEstimate?.flashings??0)>0
  const hasGuttering    = e.gutterRuns.length>0      || e.guttering>0    || (initialEstimate?.guttering??0)>0
  const hasDownpipes    = e.downpipeItems.length>0   || e.downpipes>0
  const hasDrains       = e.drainItems.length>0      || e.drains>0
  const hasPenetrations = e.penetrationItems.length>0|| e.penetrations>0

  const upd = k => v => setE(prev=>({...prev,[k]:typeof v==="number"?v:parseFloat(v)||0}))

  const row = (label,val,bold,accent) => (
    <div style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid rgba(255,255,255,0.07)",fontSize:13}}>
      <span style={{color:bold?"#fff":"#94a3b8"}}>{label}</span>
      <span style={{fontWeight:bold?700:500,color:accent?"#f59e0b":"#fff"}}>{val}</span>
    </div>
  )

  return (
    <div style={s.grid2} className="grid2-responsive">
      <div>
        <div style={{...s.card,marginBottom:14}}>
          <div style={{fontWeight:700,marginBottom:14}}>Roof Dimensions</div>
          {e.sections.length>0 ? (
            <>
              <FG label="Wastage %"><input style={s.input} type="number" value={e.waste} onChange={ev=>upd("waste")(ev.target.value)}/></FG>
              <FG label="Adjusted Area"><input style={{...s.input,background:"#f8fafc",color:"#64748b"}} readOnly value={`${result.adjArea.toFixed(1)} m² across ${e.sections.length} section${e.sections.length===1?"":"s"}`}/></FG>
            </>
          ) : (
            <>
              <FG label="Roof Area (m²)"><input style={s.input} type="number" value={e.area} onChange={ev=>upd("area")(ev.target.value)}/></FG>
              <FG label="Roof Pitch">
                <select style={s.input} value={e.pitch} onChange={ev=>upd("pitch")(ev.target.value)}>
                  {PITCHES.map(p=><option key={p.factor} value={p.factor}>{p.label} — ×{p.factor}</option>)}
                </select>
              </FG>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <FG label="Wastage %"><input style={s.input} type="number" value={e.waste} onChange={ev=>upd("waste")(ev.target.value)}/></FG>
                <FG label="Adjusted Area"><input style={{...s.input,background:"#f8fafc",color:"#64748b"}} readOnly value={result.adjArea.toFixed(1)+" m²"}/></FG>
              </div>
            </>
          )}
        </div>
        <div style={{...s.card,marginBottom:14}}>
          <div style={{fontWeight:700,marginBottom:14}}>Materials</div>
          {e.sections.length>0 ? (
            <div style={{marginBottom:14}}>
              <label style={s.label}>Roof Sections (traced on photo)</label>
              {e.sections.map((sec,i)=>(
                <div key={sec.id} style={{border:"1px solid #e2e8f0",borderRadius:8,padding:10,marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <span style={{fontSize:13,fontWeight:600}}>{sec.name}</span>
                    <span style={{fontSize:12,color:"#64748b"}}>{sec.surface_m2!=null ? `${sec.surface_m2} m²` : "no pitch set"}</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                    <span style={{fontSize:11,color:"#64748b"}}>Pitch</span>
                    <input
                      value={sec.pitch ?? ""}
                      onChange={ev=>{
                        const pitch = ev.target.value
                        const pitchFactor = parseFloat(parsePitch(pitch).toFixed(3))
                        // ← Re-derive surface_m2 from the section's flat
                        //   footprint rather than adjusting the already-
                        //   sloped surface_m2 in place, since the latter
                        //   would compound with every edit instead of
                        //   recomputing cleanly from the original trace.
                        setE(prev=>({...prev,sections:prev.sections.map((s,si)=>si===i?{
                          ...s, pitch, pitchFactor,
                          surface_m2: parseFloat(((s.footprint_m2||0)*pitchFactor).toFixed(2)),
                        }:s)}))
                      }}
                      placeholder="4:12 or 30°"
                      style={{width:70,padding:"2px 6px",border:"1px solid #e2e8f0",borderRadius:4,fontSize:11,fontFamily:"inherit"}}/>
                    <span style={{fontSize:10,color:"#94a3b8"}}>×{sec.pitchFactor||1} · plan {sec.footprint_m2||0}m²</span>
                  </div>
                  <MaterialPicker
                    group="roof_sheet"
                    value={sec.materialLabel}
                    onSelect={({label,rate})=>setE(prev=>({...prev,sections:prev.sections.map((s,si)=>si===i?{...s,name:label,materialLabel:label,rate}:s)}))}
                  />
                  {sec.rate>0 && sec.surface_m2!=null && <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>{(sec.surface_m2*wasteFactor).toFixed(2)}m² (incl. {e.waste||0}% waste) × {cs}{sec.rate}/m² = {cs}{(sec.surface_m2*wasteFactor*sec.rate).toFixed(2)}</div>}
                </div>
              ))}
            </div>
          ) : (
            <>
              <FG label="Material Type">
                <MaterialPicker
                  group="roof_sheet"
                  value={e.materialLabel}
                  onSelect={({label,rate})=>setE(prev=>({...prev,materialLabel:label,materialRate:rate}))}
                />
              </FG>
              <FG label={`Material Rate (${cs}/m²)`}><input style={s.input} type="number" value={e.materialRate} onChange={ev=>upd("materialRate")(ev.target.value)}/></FG>
            </>
          )}
          {e.flashingRuns.length>0 ? (
            <div style={{marginBottom:14}}>
              <label style={s.label}>Flashing Runs (traced on photo)</label>
              {e.flashingRuns.map((run,i)=>(
                <div key={run.subtype} style={{border:"1px solid #e2e8f0",borderRadius:8,padding:10,marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <span style={{fontSize:13,fontWeight:600}}>{run.label}</span>
                    <span style={{fontSize:12,color:"#64748b"}}>{run.length_m} m traced</span>
                  </div>
                  {FLASHING_ANGLE_SUBTYPES.includes(run.subtype) && (
                    <div style={{marginBottom:8}}>
                      <label style={s.label}>Roof Angle (°) <span style={{color:"#94a3b8",fontWeight:400}}>— adjusts traced length to true sloped length</span></label>
                      <input type="number" min="0" max="85" step="any" value={run.angleDeg ?? ""}
                        onChange={ev=>{
                          const v = ev.target.value
                          setE(prev=>({...prev,flashingRuns:prev.flashingRuns.map((r,ri)=>ri===i?{...r,angleDeg:v===""?null:parseFloat(v)}:r)}))
                        }}
                        style={{...s.input,width:120}}/>
                      {run.angleDeg>0 && <span style={{fontSize:11,color:"#94a3b8",marginLeft:8}}>→ {flashingQtyM(run).toFixed(2)}m adjusted</span>}
                    </div>
                  )}
                  <MaterialPicker
                    unit="lm"
                    group="flashing"
                    value={run.materialLabel}
                    onSelect={({label,rate})=>setE(prev=>({...prev,flashingRuns:prev.flashingRuns.map((r,ri)=>ri===i?{...r,materialLabel:label,rate}:r)}))}
                  />
                  {run.rate>0 && <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>{(flashingQtyM(run)*wasteFactor).toFixed(2)}m (incl. {e.waste||0}% waste) × {cs}{run.rate}/m = {cs}{(flashingQtyM(run)*wasteFactor*run.rate).toFixed(2)}</div>}
                </div>
              ))}
            </div>
          ) : hasFlashingFallback ? (
            <FG label={`Flashings (m) @ ${cs}${RATES.flashings}/m`}><input style={s.input} type="number" value={e.flashings} onChange={ev=>upd("flashings")(ev.target.value)}/></FG>
          ) : null}
          {e.gutterRuns.length>0 ? (
            <div style={{marginBottom:14}}>
              <label style={s.label}>Guttering (traced on photo)</label>
              {e.gutterRuns.map((g,i)=>(
                <div key={g.id} style={{border:"1px solid #e2e8f0",borderRadius:8,padding:10,marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <span style={{fontSize:13,fontWeight:600}}>Gutter run</span>
                    <span style={{fontSize:12,color:"#64748b"}}>{g.length_m} m</span>
                  </div>
                  <MaterialPicker
                    unit="lm" group="gutter" catalogUnit="LM"
                    value={g.materialLabel}
                    onSelect={({label,rate})=>setE(prev=>({...prev,gutterRuns:prev.gutterRuns.map((r,ri)=>ri===i?{...r,materialLabel:label,rate}:r)}))}
                  />
                  {g.rate>0 && <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>{(g.length_m*wasteFactor).toFixed(2)}m (incl. {e.waste||0}% waste) × {cs}{g.rate}/m = {cs}{(g.length_m*wasteFactor*g.rate).toFixed(2)}</div>}
                </div>
              ))}
            </div>
          ) : hasGuttering ? (
            <FG label={`Guttering (m) @ ${cs}${RATES.guttering}/m`}><input style={s.input} type="number" value={e.guttering} onChange={ev=>upd("guttering")(ev.target.value)}/></FG>
          ) : null}
          {hasDownpipes && e.downpipeItems.length>0 && (
            <div style={{marginBottom:14}}>
              <label style={s.label}>Downpipes (traced on photo)</label>
              {e.downpipeItems.map((d,i)=>(
                <div key={d.id} style={{border:"1px solid #e2e8f0",borderRadius:8,padding:10,marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <span style={{fontSize:13,fontWeight:600}}>Downpipe #{i+1}</span>
                    <span style={{fontSize:12,color:"#64748b"}}>
                      {d.length_m>0 ? `${d.length_m}m → ${d.quantity} × ${d.preferredLength}m (waste ${d.waste}m)` : "no length set"}
                    </span>
                  </div>
                  <div style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-end"}}>
                    <FG label="Bends/Elbows">
                      <input style={{...s.input,width:90}} type="number" min="0" value={d.bends}
                        onChange={ev=>setE(prev=>({...prev,downpipeItems:prev.downpipeItems.map((r,ri)=>ri===i?{...r,bends:parseInt(ev.target.value)||0}:r)}))}/>
                    </FG>
                    <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"#475569",paddingBottom:9,cursor:"pointer"}}>
                      <div onClick={()=>setE(prev=>({...prev,downpipeItems:prev.downpipeItems.map((r,ri)=>ri===i?{...r,spreader:!r.spreader}:r)}))}
                        style={{width:34,height:19,borderRadius:10,background:d.spreader?"#10b981":"#cbd5e1",cursor:"pointer",position:"relative",flexShrink:0}}>
                        <div style={{position:"absolute",top:2,left:d.spreader?16:2,width:15,height:15,borderRadius:"50%",background:"#fff",transition:"all .15s"}}/>
                      </div>
                      Spreader included
                    </label>
                  </div>
                  <MaterialPicker
                    unit="each" group="downpipe" catalogUnit="ea"
                    value={d.materialLabel}
                    onSelect={({label,rate})=>setE(prev=>({...prev,downpipeItems:prev.downpipeItems.map((r,ri)=>ri===i?{...r,materialLabel:label,rate}:r)}))}
                  />
                  {d.rate>0 && (
                    <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>
                      {d.quantity} × {cs}{d.rate}{d.bends>0?` + ${d.bends} bend${d.bends===1?"":"s"} × ${cs}${e.downpipeBendRate}`:""}{d.spreader?` + spreader ${cs}${e.spreaderRate}`:""} = {cs}{downpipeItemTotal(d, e.downpipeBendRate, e.spreaderRate).toFixed(2)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {[
            { key:"drainItems",    has:hasDrains,       label:"Drains",    group:"drain" },
            { key:"penetrationItems", has:hasPenetrations, label:"Penetrations", group:"penetration" },
          ].filter(sec=>sec.has && e[sec.key].length>0).map(sec=>(
            <div key={sec.key} style={{marginBottom:14}}>
              <label style={s.label}>{sec.label} (traced on photo)</label>
              {e[sec.key].map((it,i)=>(
                <div key={it.id} style={{border:"1px solid #e2e8f0",borderRadius:8,padding:10,marginBottom:8}}>
                  <MaterialPicker
                    unit="each" group={sec.group} catalogUnit="ea"
                    value={it.materialLabel}
                    onSelect={({label,rate})=>setE(prev=>({...prev,[sec.key]:prev[sec.key].map((r,ri)=>ri===i?{...r,materialLabel:label,rate}:r)}))}
                  />
                  {it.rate>0 && <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>{cs}{it.rate} each</div>}
                </div>
              ))}
            </div>
          ))}
          {(hasDownpipes && e.downpipeItems.length===0 || hasDrains && e.drainItems.length===0 || hasPenetrations && e.penetrationItems.length===0) && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}} className="grid2-responsive">
              {hasDownpipes && e.downpipeItems.length===0 && <FG label={`Downpipes (each) @ ${cs}${RATES.downpipe}`}><input style={s.input} type="number" value={e.downpipes} onChange={ev=>upd("downpipes")(ev.target.value)}/></FG>}
              {hasDrains && e.drainItems.length===0 && <FG label={`Drains (each) @ ${cs}${RATES.drain}`}><input style={s.input} type="number" value={e.drains} onChange={ev=>upd("drains")(ev.target.value)}/></FG>}
              {hasPenetrations && e.penetrationItems.length===0 && <FG label={`Penetrations (each) @ ${cs}${RATES.penetration}`}><input style={s.input} type="number" value={e.penetrations} onChange={ev=>upd("penetrations")(ev.target.value)}/></FG>}
            </div>
          )}
        </div>
        <div style={s.card}>
          <div style={{fontWeight:700,marginBottom:14}}>Labour & Margin</div>
          <FG label="Job Complexity">
            <div style={{display:"flex",flexWrap:"wrap",gap:14}}>
              {complexityLevels.map(c=>(
                <label key={c.key} style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer",fontSize:13}} title={c.desc}>
                  <input type="radio" name="complexity" value={c.key} checked={e.complexity===c.key}
                    onChange={()=>setE(prev=>({...prev,complexity:c.key}))}/>
                  {c.label}
                </label>
              ))}
            </div>
          </FG>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <FG label={`Day Rate (${cs})`}><input style={s.input} type="number" value={e.dayRate} onChange={ev=>upd("dayRate")(ev.target.value)}/></FG>
            <FG label="Est. Days"><input style={s.input} type="number" step="0.5" value={e.days} onChange={ev=>upd("days")(ev.target.value)}/></FG>
          </div>
          <FG label="Margin %"><input style={s.input} type="number" value={e.margin} onChange={ev=>upd("margin")(ev.target.value)}/></FG>
        </div>
      </div>

      <div>
        <div style={{background:"#0f172a",borderRadius:12,padding:20,color:"#fff"}}>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:15,fontWeight:800,marginBottom:16,color:"#f59e0b"}}>Cost Breakdown</div>
          {e.sections.length>0
            ? e.sections.map(sec=>sec.rate>0 && sec.surface_m2!=null && row(`${sec.name} (${(sec.surface_m2*wasteFactor).toFixed(2)}m² incl. ${e.waste||0}% waste × ${cs}${sec.rate})`, fmt(sec.surface_m2*wasteFactor*sec.rate)))
            : row(`Material (${result.adjArea.toFixed(1)} m² × ${cs}${e.materialRate})`, fmt(result.matCost))}
          {e.flashingRuns.length>0
            ? e.flashingRuns.map(r=>row(`${r.label} (${(flashingQtyM(r)*wasteFactor).toFixed(2)}m incl. ${e.waste||0}% waste × ${cs}${r.rate||0})`, fmt(flashingQtyM(r)*wasteFactor*(r.rate||0))))
            : e.flashings>0 && row(`Flashings (${(e.flashings*wasteFactor).toFixed(1)}m incl. ${e.waste||0}% waste × ${cs}${RATES.flashings})`, fmt(result.flashCost))}
          {e.gutterRuns.length>0
            ? e.gutterRuns.map(g=>row(`Gutter run (${(g.length_m*wasteFactor).toFixed(2)}m incl. ${e.waste||0}% waste × ${cs}${g.rate||0})`, fmt(g.length_m*wasteFactor*(g.rate||0))))
            : e.guttering>0 && row(`Guttering (${(e.guttering*wasteFactor).toFixed(1)}m incl. ${e.waste||0}% waste × ${cs}${RATES.guttering})`, fmt(result.gutCost))}
          {e.downpipeItems.length>0
            ? e.downpipeItems.map((d,i)=>row(`Downpipe #${i+1} (${d.quantity||1} × ${cs}${d.rate||0}${d.bends>0?` + ${d.bends} bend${d.bends===1?"":"s"}`:""}${d.spreader?" + spreader":""})`, fmt(downpipeItemTotal(d, e.downpipeBendRate, e.spreaderRate))))
            : e.downpipes>0 && row(`Downpipes (${e.downpipes} × ${cs}${RATES.downpipe})`, fmt(result.downpipeCost))}
          {e.drainItems.length>0
            ? e.drainItems.map((d,i)=>row(`Drain #${i+1} (× ${cs}${d.rate||0})`, fmt(d.rate||0)))
            : e.drains>0 && row(`Drains (${e.drains} × ${cs}${RATES.drain})`, fmt(result.drainCost))}
          {e.penetrationItems.length>0
            ? e.penetrationItems.map((p,i)=>row(`Penetration #${i+1} (× ${cs}${p.rate||0})`, fmt(p.rate||0)))
            : e.penetrations>0 && row(`Penetrations (${e.penetrations} × ${cs}${RATES.penetration})`, fmt(result.penetrationCost))}
          {row(`Labour (${e.days} days × ${cs}${e.dayRate} × ${complexityFactorValue} ${complexityLevels.find(c=>c.key===e.complexity)?.label||""})`, fmt(result.labCost))}
          {row(`Margin (${e.margin}%)`, fmt(result.marginAmt))}

          <div style={{padding:"10px 0",borderTop:"1px solid rgba(255,255,255,0.07)"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:e.discountEnabled?10:0}}>
              <span style={{fontSize:13,color:"#94a3b8"}}>General Customer Discount</span>
              <div onClick={()=>setE(prev=>({...prev,discountEnabled:!prev.discountEnabled}))}
                style={{width:34,height:19,borderRadius:10,background:e.discountEnabled?"#10b981":"#475569",cursor:"pointer",position:"relative",flexShrink:0}}>
                <div style={{position:"absolute",top:2,left:e.discountEnabled?16:2,width:15,height:15,borderRadius:"50%",background:"#fff",transition:"all .15s"}}/>
              </div>
            </div>
            {e.discountEnabled && (
              <div style={{display:"flex",gap:8}}>
                <select value={e.discountType} onChange={ev=>setE(prev=>({...prev,discountType:ev.target.value}))}
                  style={{...s.input,background:"#1e293b",color:"#fff",borderColor:"#334155",width:110}}>
                  <option value="percent">%</option>
                  <option value="fixed">{cs} fixed</option>
                </select>
                <input type="number" value={e.discountValue} onChange={ev=>upd("discountValue")(ev.target.value)}
                  style={{...s.input,background:"#1e293b",color:"#fff",borderColor:"#334155",flex:1}}/>
              </div>
            )}
          </div>

          {result.discountAmt>0 && row("Subtotal before discount", fmt(result.preDiscountSell))}
          {result.discountAmt>0 && row(`Discount (${e.discountType==="fixed" ? cs+e.discountValue : e.discountValue+"%"})`, `− ${fmt(result.discountAmt)}`)}
          <div style={{borderTop:"1px solid rgba(255,255,255,0.15)",paddingTop:12,marginTop:4}}>
            {row("Sell Price (excl. GST)", fmt(result.sellPrice), true, true)}
            {row(`GST (${(result.gstRate*100).toFixed(0)}%)`, fmt(result.gst))}
            <div style={{display:"flex",justifyContent:"space-between",padding:"12px 0 0",alignItems:"center"}}>
              <span style={{color:"#fff",fontWeight:700,fontSize:15}}>Total inc. GST</span>
              <Money value={fmt(result.total)} size={24} color="#f59e0b"/>
            </div>
          </div>
        </div>
        <div style={{...s.card,marginTop:14}}>
          <div style={{fontWeight:600,fontSize:13,marginBottom:10}}>Material Summary</div>
          <div style={{fontSize:12,color:"#64748b",lineHeight:2}}>
            <div>Adjusted area: <strong style={{color:"#0f172a"}}>{result.adjArea.toFixed(1)} m²</strong></div>
            {e.sections.length>0
              ? e.sections.map(sec=><div key={sec.id}>{sec.name}: <strong style={{color:"#0f172a"}}>{sec.surface_m2!=null ? `${sec.surface_m2}m²` : "no pitch set"}{sec.rate?` @ ${cs}${sec.rate}/m²`:" — no material chosen yet"}</strong></div>)
              : <div>Material: <strong style={{color:"#0f172a"}}>{e.materialLabel} @ {cs}{e.materialRate}/m²</strong></div>}
            {e.flashingRuns.length>0
              ? e.flashingRuns.map(r=><div key={r.subtype}>{r.label}: <strong style={{color:"#0f172a"}}>{flashingQtyM(r).toFixed(2)}m{r.angleDeg?` (${r.length_m}m traced @ ${r.angleDeg}°)`:""}{r.rate?` @ ${cs}${r.rate}/m`:""}</strong></div>)
              : e.flashings>0 && <div>Flashings: <strong style={{color:"#0f172a"}}>{e.flashings}m @ {cs}{RATES.flashings}/m</strong></div>}
            {e.gutterRuns.length>0
              ? e.gutterRuns.map(g=><div key={g.id}>Guttering: <strong style={{color:"#0f172a"}}>{g.length_m}m{g.rate?` @ ${cs}${g.rate}/m`:" — no material chosen yet"}</strong></div>)
              : e.guttering>0 && <div>Guttering: <strong style={{color:"#0f172a"}}>{e.guttering}m @ {cs}{RATES.guttering}/m</strong></div>}
            {e.downpipeItems.length>0
              ? <div>Downpipes: <strong style={{color:"#0f172a"}}>{e.downpipeItems.length} placed{e.downpipeItems.some(d=>d.rate)?`, ${cs}${e.downpipeItems.reduce((a,d)=>a+(d.rate||0),0).toFixed(2)} total`:" — no material chosen yet"}</strong></div>
              : e.downpipes>0 && <div>Downpipes: <strong style={{color:"#0f172a"}}>{e.downpipes} @ {cs}{RATES.downpipe} each</strong></div>}
            {e.drainItems.length>0
              ? <div>Drains: <strong style={{color:"#0f172a"}}>{e.drainItems.length} placed{e.drainItems.some(d=>d.rate)?`, ${cs}${e.drainItems.reduce((a,d)=>a+(d.rate||0),0).toFixed(2)} total`:" — no material chosen yet"}</strong></div>
              : e.drains>0 && <div>Drains: <strong style={{color:"#0f172a"}}>{e.drains} @ {cs}{RATES.drain} each</strong></div>}
            {e.penetrationItems.length>0
              ? <div>Penetrations: <strong style={{color:"#0f172a"}}>{e.penetrationItems.length} placed{e.penetrationItems.some(p=>p.rate)?`, ${cs}${e.penetrationItems.reduce((a,p)=>a+(p.rate||0),0).toFixed(2)} total`:" — no material chosen yet"}</strong></div>
              : e.penetrations>0 && <div>Penetrations: <strong style={{color:"#0f172a"}}>{e.penetrations} @ {cs}{RATES.penetration} each</strong></div>}
            <div>Labour: <strong style={{color:"#0f172a"}}>{e.days} days @ {cs}{e.dayRate}/day</strong></div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── QUOTE VIEW ───────────────────────────
// Renders the on-screen quote node to a canvas and paginates it into an
// A4 PDF — real file download, not a browser print dialog.
async function downloadQuotePdf(node, filename) {
  const canvas = await html2canvas(node, { scale: 2, useCORS: true, backgroundColor: "#ffffff" })
  const imgData = canvas.toDataURL("image/png")

  const pdf = new jsPDF({ unit: "mm", format: "a4" })
  const pageW = pdf.internal.pageSize.getWidth()
  const pageH = pdf.internal.pageSize.getHeight()
  const imgH  = (canvas.height * pageW) / canvas.width

  let heightLeft = imgH
  let y = 0
  pdf.addImage(imgData, "PNG", 0, y, pageW, imgH)
  heightLeft -= pageH

  while (heightLeft > 0) {
    y = heightLeft - imgH
    pdf.addPage()
    pdf.addImage(imgData, "PNG", 0, y, pageW, imgH)
    heightLeft -= pageH
  }

  pdf.save(filename)
}

function QuotePrintView({ project, customer, company, setView }) {
  const contentRef = useRef(null)
  const [downloading, setDownloading] = useState(false)

  async function handleDownload() {
    if (!contentRef.current) return
    setDownloading(true)
    try {
      await downloadQuotePdf(contentRef.current, `Quote-${project.quoteNum || project.id}.pdf`)
    } catch (err) {
      console.error("PDF export failed:", err)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div>
      <div className="print-hide" style={{display:"flex",gap:10,marginBottom:20,flexWrap:"wrap"}}>
        <Btn onClick={()=>setView("project")}>← Back to Project</Btn>
        <Btn primary onClick={handleDownload}>{downloading ? "Generating…" : "⬇ Download PDF"}</Btn>
        <Btn onClick={()=>window.print()}>🖨 Print</Btn>
      </div>
      <div ref={contentRef} data-quote-content>
        <QuoteView project={project} customer={customer} company={company}/>
      </div>
    </div>
  )
}

function QuoteView({ project, customer, company, asbestosOverride }) {
  const { currency, formatMoney: fmt } = useCurrency()   // ← currency-aware fmt + name
  const cs = currency?.symbol || "$"
  const [snapshotUrl, setSnapshotUrl] = useState(null)
  const [hasAsbestosRisk, setHasAsbestosRisk] = useState(false)

  // ← asbestosOverride is passed by the New Project wizard's live "Quote &
  //   Save" preview (step 3), since that project hasn't been saved to the
  //   backend yet — there's no project.id to fetch saved geometry for, so
  //   it comes straight from the wizard's in-memory measurement state
  //   instead. Already-saved projects (ProjectDetail/print view) leave this
  //   undefined and fall back to the DB fetch below.
  useEffect(()=>{
    if(asbestosOverride !== undefined) return
    if(!project?.id) return
    let cancelled = false
    estimatesApi.getGeometry(project.id)
      .then(g => { if(!cancelled) { setSnapshotUrl(g?.snapshot_url || null); setHasAsbestosRisk(!!g?.asbestos) } })
      .catch(()=>{ if(!cancelled) { setSnapshotUrl(null); setHasAsbestosRisk(false) } })
    return () => { cancelled = true }
    // ← `project` (not project?.id) for the same reason as ProjectDetail's
    //   fetch: re-saving the same project must refresh the quote's roof-plan
    //   image, and only the object reference changes in that case.
  },[project, asbestosOverride])

  const showAsbestosWarning = asbestosOverride !== undefined ? !!asbestosOverride : hasAsbestosRisk

  if(!project||!customer) return <div style={{color:"#64748b",padding:20}}>No project selected.</div>
  const e = project.estimate
  if(!e) return <div style={{color:"#64748b",padding:20}}>No estimate available. Complete the estimate step first.</div>

  const qn  = project.quoteNum || "DRAFT"
  const qd  = project.quoteDate || today()
  const exp = new Date(new Date(qd.slice(0,10)+"T12:00:00").getTime()+30*86400000).toISOString().slice(0,10)

  // Same wastage % calcEst applied to flashing/gutter cost — recomputed
  // here so the shown qty × rate always equals the shown total.
  const wasteFactor = 1 + (e.waste||0)/100

  const flashingLines = e.flashingRuns?.length
    ? e.flashingRuns.map(r=>({ desc:r.materialLabel?`${r.label} — ${r.materialLabel}`:`${r.label} flashing`, qty:`${(flashingQtyM(r)*wasteFactor).toFixed(2)}m`, unit:`${cs}${r.rate||0}/m`, total:flashingQtyM(r)*wasteFactor*(r.rate||0), brand:extractBrand(r.materialLabel) }))
    : [{ desc:"Flashings — ridge/hip/valley", qty:`${(e.flashings*wasteFactor).toFixed(1)}m`, unit:`${cs}${RATES.flashings}/m`, total:e.flashCost }]

  // ← Each traced roof section gets its own line (brand/name + its own
  //   area × rate), same as flashing runs — replaces the single generic
  //   "materialLabel roofing" line, which never showed which brand/product
  //   was actually picked per section.
  const materialLines = e.sections?.length
    ? e.sections.filter(sec=>sec.surface_m2!=null).map(sec=>({ desc:`${sec.name}`, qty:`${(sec.surface_m2*wasteFactor).toFixed(2)} m²`, unit:`${cs}${sec.rate||0}/m²`, total:sec.surface_m2*wasteFactor*(sec.rate||0), brand:extractBrand(sec.materialLabel) }))
    : [{ desc:`${e.materialLabel} roofing`, qty:`${e.adjArea?.toFixed(1)} m²`, unit:`${cs}${e.materialRate}`, total:e.matCost }]

  // ← Same fix as flashing above: show the actual product picked
  //   (materialLabel, supplier included) instead of a generic "Guttering"/
  //   "Downpipe #1" line with no indication of what was actually quoted.
  const gutterLines = e.gutterRuns?.length
    ? e.gutterRuns.map(g=>({ desc:g.materialLabel?`Guttering — ${g.materialLabel}`:"Guttering", qty:`${(g.length_m*wasteFactor).toFixed(2)}m`, unit:`${cs}${g.rate||0}/m`, total:g.length_m*wasteFactor*(g.rate||0), brand:extractBrand(g.materialLabel) }))
    : [{ desc:"Guttering", qty:`${(e.guttering*wasteFactor).toFixed(1)}m`, unit:`${cs}${RATES.guttering}/m`, total:e.gutCost }]
  const downpipeLines = e.downpipeItems?.length
    ? e.downpipeItems.map((d,i)=>({ desc:d.materialLabel?`Downpipe #${i+1} — ${d.materialLabel}${d.bends>0?` (+${d.bends} bend${d.bends===1?"":"s"})`:""}${d.spreader?" (+spreader)":""}`:`Downpipe #${i+1}`, qty:`${d.quantity||1} × ${d.preferredLength||"—"}m`, unit:`${cs}${d.rate||0}`, total:downpipeItemTotal(d, e.downpipeBendRate, e.spreaderRate), brand:extractBrand(d.materialLabel) }))
    : [{ desc:"Downpipes", qty:`${e.downpipes||0} each`, unit:`${cs}${RATES.downpipe}/each`, total:e.downpipeCost||0 }]
  const drainLines = e.drainItems?.length
    ? e.drainItems.map((d,i)=>({ desc:d.materialLabel?`Drain #${i+1} — ${d.materialLabel}`:`Drain #${i+1}`, qty:"1 each", unit:`${cs}${d.rate||0}`, total:d.rate||0, brand:extractBrand(d.materialLabel) }))
    : [{ desc:"Drains", qty:`${e.drains||0} each`, unit:`${cs}${RATES.drain}/each`, total:e.drainCost||0 }]
  const penetrationLines = e.penetrationItems?.length
    ? e.penetrationItems.map((p,i)=>({ desc:p.materialLabel?`Penetration #${i+1} — ${p.materialLabel} — supply & seal`:`Penetration #${i+1} — supply & seal`, qty:"1 each", unit:`${cs}${p.rate||0}`, total:p.rate||0, brand:extractBrand(p.materialLabel) }))
    : [{ desc:"Penetrations", qty:`${e.penetrations||0} each`, unit:`${cs}${RATES.penetration}/each`, total:e.penetrationCost||0 }]

  const quoteLines = groupQuoteLinesByBrand([
    ...materialLines,
    ...flashingLines,
    ...gutterLines,
    ...downpipeLines,
    ...drainLines,
    ...penetrationLines,
    { desc:`Labour — installation (${e.days} days)`,        qty:"—",                            unit:"—",                     total:e.labCost   },
  ].filter(l=>l.total>0))

  return (
    <div style={{maxWidth:660,width:"100%",background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:32}} className="quote-view-responsive">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:28,paddingBottom:22,borderBottom:"2px solid #e2e8f0",flexWrap:"wrap",gap:12}}>
        <div style={{display:"flex",alignItems:"flex-start",gap:14}}>
          {company.logoUrl && <img src={`${API_ORIGIN}${company.logoUrl}`} alt="" style={{width:56,height:56,objectFit:"contain",flexShrink:0}}/>}
          <div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:24,fontWeight:800}}>{company.companyName}</div>
            <div style={{fontSize:12,color:"#64748b",marginTop:5,lineHeight:1.9}}>
              {company.companyAddress}<br/>{company.companyEmail} · {company.companyPhone}<br/>GST No: {company.companyGst}
            </div>
          </div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{display:"inline-block",background:"#f59e0b",color:"#000",fontSize:10,fontWeight:700,padding:"3px 12px",borderRadius:20,textTransform:"uppercase",letterSpacing:.5,marginBottom:6}}>Quote</div>
          <div style={{fontSize:13,fontWeight:700}}>{qn}</div>
          <div style={{fontSize:12,color:"#64748b",lineHeight:1.9}}>Issued: {fmtD(qd)}<br/>Expires: {fmtD(exp)}</div>
        </div>
      </div>

      <div style={{marginBottom:20}}>
        <div style={{fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#64748b",marginBottom:8}}>Prepared for</div>
        <div style={{fontWeight:600,fontSize:14}}>{customer.name}</div>
        <div style={{fontSize:12,color:"#64748b",lineHeight:1.9,marginTop:3}}>{customer.address}<br/>{customer.email} · {customer.phone}</div>
      </div>

      <div style={{marginBottom:20}}>
        <div style={{fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#64748b",marginBottom:8}}>Address / Scope</div>
        <div style={{fontSize:13,fontWeight:500}}>{project.address}</div>
        {project.notes && <div style={{fontSize:12,color:"#64748b",marginTop:6,lineHeight:1.7}}>{project.notes}</div>}
      </div>

      <div style={{marginBottom:20,overflowX:"auto"}}>
        <div style={{fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#64748b",marginBottom:10}}>Line Items</div>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:420}}>
          <thead>
            <tr>
              {["Description","Qty","Rate","Amount"].map(h=>(
                <th key={h} style={{textAlign:h==="Amount"||h==="Rate"?"right":"left",padding:"8px 10px",fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#64748b",borderBottom:"1px solid #e2e8f0"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {quoteLines.map((li,i)=>(
              li.isBrandHeader ? (
                <tr key={i}>
                  <td colSpan={4} style={{padding:"10px 10px 4px",borderBottom:"1px solid #f1f5f9",fontWeight:700}}>{li.brand}</td>
                </tr>
              ) : (
                <tr key={i}>
                  <td style={{padding:"10px",paddingLeft:li.indented?22:10,borderBottom:"1px solid #f1f5f9"}}>{li.desc}</td>
                  <td style={{padding:"10px",borderBottom:"1px solid #f1f5f9",whiteSpace:"nowrap"}}>{li.qty}</td>
                  <td style={{padding:"10px",borderBottom:"1px solid #f1f5f9",textAlign:"right"}}>{li.unit}</td>
                  <td style={{padding:"10px",borderBottom:"1px solid #f1f5f9",textAlign:"right",fontWeight:500}}>{fmt(li.total)}</td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      </div>

      <div style={{display:"flex",justifyContent:"flex-end"}}>
        <div style={{minWidth:240,width:"100%",maxWidth:280}}>
          {[
            ...(e.discountAmt>0 ? [["Subtotal before discount", fmt(e.sellPrice+e.discountAmt)]] : []),
            ...(e.discountAmt>0 ? [[`Discount (${e.discountType==="fixed" ? cs+e.discountValue : (e.discountValue||0)+"%"})`, `− ${fmt(e.discountAmt)}`]] : []),
            ["Subtotal (excl. GST)", fmt(e.sellPrice)],
            [`GST (${((e.gstRate ?? GST_RATE)*100).toFixed(0)}%)`, fmt(e.gst)],
          ].map(([l,v])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #f1f5f9",fontSize:13}}>
              <span style={{color:"#64748b"}}>{l}</span><span style={{fontWeight:500}}>{v}</span>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:14}}>
            <span style={{fontWeight:700,fontSize:15}}>Total inc. GST</span>
            <div style={{textAlign:"right"}}>
              <Money value={fmt(e.total)} size={26}/>
              {/* ← shows active currency name instead of hardcoded "New Zealand Dollars" */}
              <div style={{fontSize:11,color:"#64748b"}}>{currency.name}</div>
            </div>
          </div>
        </div>
      </div>

      <div style={{borderTop:"1px solid #e2e8f0",paddingTop:18,marginTop:18}}>
        <div style={{fontSize:11,color:"#94a3b8",lineHeight:2}}>
          {showAsbestosWarning && (
            /* <div style={{marginTop:18,paddingTop:14,borderTop:"1px solid #e2e8f0"}}> */
              <div style={{fontSize:11,color:"#64748b",lineHeight:1.7}}>⚠️ <strong style={{color:"#0f172a"}}>Asbestos Warning:</strong> Existing roofing materials must not be disturbed. Where asbestos-containing materials (ACMs) are known or suspected, an asbestos assessment is required before any roofing work commences. Asbestos testing, removal, and disposal are excluded from this quotation unless expressly included.</div>
            /*</div>*/
          )}
          <br/>
          <strong style={{color:"#64748b"}}>Terms:</strong> 50% deposit on acceptance. Balance on completion within 7 days of invoice.<br/>
          <strong style={{color:"#64748b"}}>Payment:</strong> Bank transfer to {company.companyName} — {company.companyBank}<br/>
          <strong style={{color:"#64748b"}}>Validity:</strong> This quote is valid for 30 days from date of issue. Subject to site inspection.
        </div>
      </div>

      {(company.estimatorName || company.estimatorTitle) && (
        <div style={{marginTop:24}}>
          <div style={{fontSize:13,color:"#0f172a",lineHeight:1.8}}>
            Ngā mihi,<br/>
            <strong>{company.estimatorName}</strong><br/>
            {company.estimatorTitle}<br/>
            {company.companyName}
          </div>
        </div>
      )}

      {company.badgesUrl && (
        <div style={{marginTop:16}}>
          <img src={`${API_ORIGIN}${company.badgesUrl}`} alt="" style={{width:"100%",height:"auto",display:"block"}}/>
        </div>
      )}

      {snapshotUrl && (
        <div style={{marginTop:20,paddingTop:18,borderTop:"1px solid #e2e8f0"}}>
          <div style={{fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#64748b",marginBottom:10}}>Roof Measurement Plan</div>
          <img src={`${API_ORIGIN}${snapshotUrl}`} alt="Roof measurement plan" style={{maxWidth:"100%",border:"1px solid #e2e8f0",borderRadius:8}}/>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────── NEW PROJECT WIZARD ───────────────────────────
function NewProjectWizard({ customers, projects, jobs, onSave, onCancel, existingProject, company }) {
  const { formatMoney: fmt } = useCurrency()   // ← currency-aware fmt

  const [step,    setStep]    = useState(0)
  const [saving,  setSaving]  = useState(false)
  const [form,    setForm]    = useState(existingProject || {
    customerId:"", address:"", roofType:"Long Run Steel", status:"New Lead", notes:"",
  })
  const [newCust,   setNewCust]   = useState({ name:"", email:"", phone:"", address:"" })
  const [isNewCust, setIsNewCust] = useState(false)
  const [area,      setArea]      = useState(existingProject?.area||null)
  const [estimate,  setEstimate]  = useState(existingProject?.estimate||null)
  const [geometryFull, setGeometryFull] = useState(null)
  const [geometryLoaded, setGeometryLoaded] = useState(!existingProject)
  const [geometrySnapshotDataUrl, setGeometrySnapshotDataUrl] = useState(null)
  // ← The clean, undrawn-on photo — separate from geometrySnapshotDataUrl
  //   (the flattened photo+drawing composite) — captured the same way, so
  //   reopening this project to edit later has a real photo to trace on top
  //   of instead of the previous drawing baked into the snapshot's pixels.
  const [originalPhotoDataUrl, setOriginalPhotoDataUrl] = useState(null)
  // ← Set instead of the above when the photo came from the job library —
  //   it's already a hosted asset, so its URL is stored as-is with no upload.
  const [originalPhotoUrl, setOriginalPhotoUrl] = useState(null)

  const measurementToolRef = useRef(null)

  const [selectedJobId,       setSelectedJobId]       = useState(existingProject?.jobId||"")
  const [jobPhotos,           setJobPhotos]           = useState([])
  const [selectedJobPhotos,   setSelectedJobPhotos]   = useState([])
  const [activeMeasurePhotoUrl, setActiveMeasurePhotoUrl] = useState(null)

  // ← When editing a saved project, load its previously-traced geometry
  //   (sections/flashings/points/scale/asbestos) so the Measure step
  //   reopens pre-populated instead of blank. Gated behind geometryLoaded
  //   so MeasurementTool doesn't mount — and lazily seed itself from an
  //   empty geometryFull — before this fetch resolves.
  useEffect(()=>{
    if(!existingProject) return
    let cancelled = false
    estimatesApi.getGeometry(existingProject.id)
      .then(g => { if(!cancelled) setGeometryFull(g) })
      .catch(()=>{})
      .finally(()=>{ if(!cancelled) setGeometryLoaded(true) })
    return () => { cancelled = true }
  }, [existingProject?.id])

  useEffect(()=>{
    if(!selectedJobId) { setJobPhotos([]); setSelectedJobPhotos([]); return }
    let cancelled = false
    jobPhotosApi.getForJob(selectedJobId)
      .then(rows => { if(!cancelled) setJobPhotos(rows) })
      .catch(()  => { if(!cancelled) setJobPhotos([]) })
    return () => { cancelled = true }
  }, [selectedJobId])

  const togglePhoto = id => setSelectedJobPhotos(prev =>
    prev.includes(id) ? prev.filter(p=>p!==id) : [...prev, id]
  )

  function pickMeasurePhoto(ph) {
    togglePhoto(ph.id)
    setActiveMeasurePhotoUrl(`${API_ORIGIN}${ph.url}`)
  }

  // ← Which measurement method is active on the Measure step: 'upload' (draw
  //   on an uploaded/blank photo), 'live' (open device camera + draw), or
  //   'ar' (WebXR AR session). Defaults to 'upload' since it's the most
  //   broadly supported method across devices/browsers.
  const [measureMethod, setMeasureMethod] = useState("upload")

  const STEPS  = ["Customer","Measure","Estimate","Quote & Save"]
  const isEdit = !!existingProject

  async function save() {
    setSaving(true)
    let cid = form.customerId
    let pendingNewCust = null
    if(isNewCust && newCust.name) {
      pendingNewCust = newCust
      cid = uid()
    }
    // ← geometrySnapshotDataUrl is captured in stepNext() when leaving the
    //   Measure step (MeasurementTool is unmounted by now, so its ref is no
    //   longer usable here). If it's null (e.g. user never revisited Measure
    //   this session), the backend preserves whatever snapshot was already
    //   saved rather than clearing it.
    const project = {
      ...form,
      id: existingProject?.id || uid(),
      customerId: cid,
      jobId: selectedJobId || null,
      jobPhotoIds: selectedJobPhotos,
      area: area||0,
      estimate,
      geometry: geometryFull ? { ...geometryFull, snapshotDataUrl: geometrySnapshotDataUrl, originalPhotoDataUrl, originalPhotoUrl } : null,
      quoteNum:  existingProject?.quoteNum  || (estimate ? nextQuoteNum(projects) : ""),
      quoteDate: existingProject?.quoteDate || (estimate ? today() : ""),
      createdAt: existingProject?.createdAt || today(),
    }
    await onSave(project, pendingNewCust)
    setSaving(false)
  }

  const upd = k => v => setForm(prev=>({...prev,[k]:v}))

  // ← Errors only surface after a failed Next/Skip attempt (not on first
  //   render), so the user isn't greeted with a wall of red on a blank form.
  const [showErrors, setShowErrors] = useState(false)

  const canNext = [
    (isNewCust
      ? newCust.name.trim() && newCust.phone.trim() && newCust.email.trim() && newCust.address.trim()
      : form.customerId
    ) && form.address.trim() && form.notes.trim(),
    true, true, true,
  ]

  // ← Captures the traced canvas as a PNG before leaving the Measure step,
  //   since MeasurementTool only renders while step===1 — by the final
  //   "Save Project" step it's already unmounted and measurementToolRef
  //   would be null, so the snapshot has to be grabbed here instead.
  const stepNext = () => {
    if(!canNext[step]) { setShowErrors(true); return }
    if(step===1 && measureMethod==="upload") {
      const snap = measurementToolRef.current?.getSnapshot?.()
      if(snap) setGeometrySnapshotDataUrl(snap)
      // ← A local file needs uploading (dataUrl); a job-library photo is
      //   already hosted, so its URL is stored directly (see getOriginalPhoto).
      const orig = measurementToolRef.current?.getOriginalPhoto?.()
      if(orig?.dataUrl) { setOriginalPhotoDataUrl(orig.dataUrl); setOriginalPhotoUrl(null) }
      else if(orig?.url) { setOriginalPhotoUrl(orig.url); setOriginalPhotoDataUrl(null) }
    }
    setStep(n=>n+1)
  }
  const stepBack = () => setStep(n=>n-1)

  // ← Shared handler passed to whichever measurement component is active;
  //   all three (MeasurementTool, LiveCameraMeasurements, ARCameraMeasurement)
  //   report geometry with the same total_surface_m2 field, so the wizard
  //   doesn't need to know which method produced it.
  const handleGeometryChange = g => { setArea(g?.total_surface_m2 || 0); setGeometryFull(g) }

  // ← EstimateEngine keeps its own copy of `sections` (seeded once from
  //   geometryFull on mount) so it can edit materialLabel/rate/name locally.
  //   Without this, picking a different brand in the Estimate step never
  //   made it back into geometryFull — so going back to the Measure step
  //   (which re-seeds MeasurementTool from geometryFull on remount) still
  //   showed the old brand name. Merge section edits back by id whenever
  //   the estimate changes, keeping both steps in sync either direction.
  const handleEstimateChange = result => {
    setEstimate(result)
    setGeometryFull(prev => {
      if(!prev) return prev
      let next = prev
      if(result?.sections?.length && prev.sections?.length){
        const edited = new Map(result.sections.map(s=>[s.id,s]))
        next = { ...next, sections: next.sections.map(s=>{
          const m = edited.get(s.id)
          // ← pitch/pitchFactor/surface_m2 synced back too, same reasoning
          //   as name/materialLabel/rate — otherwise a pitch edit made in
          //   the Estimate step would revert the moment the Measure step
          //   re-renders from geometryFull.
          return m ? { ...s, name:m.name, materialLabel:m.materialLabel, rate:m.rate,
            pitch:m.pitch, pitchFactor:m.pitchFactor, surface_m2:m.surface_m2 } : s
        })}
      }
      // ← Flashing brand is picked per subtype (Ridge Cap, Valley, etc.),
      //   not per traced line — apply the Estimate step's edit to every
      //   segment sharing that subtype, same as the popup does.
      if(result?.flashingRuns?.length && prev.accessories?.flashings?.length){
        const editedRuns = new Map(result.flashingRuns.map(r=>[r.subtype,r]))
        next = { ...next, accessories: { ...next.accessories, flashings: next.accessories.flashings.map(f=>{
          const m = editedRuns.get(f.subtype)
          return m ? { ...f, materialLabel:m.materialLabel, rate:m.rate } : f
        })}}
      }
      // ← Same fix, generalized: gutter runs and downpipe/drain/penetration
      //   points each carry their own materialLabel/rate too now, and each
      //   gets its own popup right after tracing — so editing any of them
      //   in the Estimate step needs to sync back by id the same way.
      ;[
        { resultKey:"gutterRuns",       geomKey:"gutters" },
        { resultKey:"downpipeItems",    geomKey:"downpipes" },
        { resultKey:"drainItems",       geomKey:"drains" },
        { resultKey:"penetrationItems", geomKey:"penetrations" },
      ].forEach(({resultKey,geomKey})=>{
        const edits = result?.[resultKey]
        if(edits?.length && next.accessories?.[geomKey]?.length){
          const edited = new Map(edits.map(it=>[it.id,it]))
          next = { ...next, accessories: { ...next.accessories, [geomKey]: next.accessories[geomKey].map(it=>{
            const m = edited.get(it.id)
            // ← Full-field merge (not just materialLabel/rate) so per-item
            //   edits with no equivalent on the point marker itself — e.g. a
            //   downpipe's bends/spreader — survive a round trip through the
            //   Estimate step instead of reverting on the next re-render.
            return m ? { ...it, ...m } : it
          })}}
        }
      })
      return next
    })
  }

  // ← Live camera only makes sense on a device with a built-in/rear camera
  //   the user is holding up to the roof — laptops/desktops have front-facing
  //   webcams at best, so the option is hidden there and only offered on
  //   phones/tablets (iOS reports iPad as "Macintosh" post-iPadOS 13, so touch
  //   support is checked as a fallback for that case).
  const isMobileOrTablet = useMemo(() => {
    const ua = navigator.userAgent
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return true
    return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1
  }, [])

  const MEASURE_METHODS = [
    { key:"upload", label:"Upload & draw", icon:"📷", desc:"Upload a photo (or draw on blank canvas), then trace roof sections manually." },
    ...(isMobileOrTablet ? [
      { key:"live",   label:"Live camera",   icon:"🎥", desc:"Open your device camera, freeze a frame, adjust it, then trace measurements." },
    ] : []),
    { key:"ar",     label:"AR camera",     icon:"📐", desc:"Coming soon — WebXR AR measuring is in development.", disabled:true },
  ]

  useEffect(()=>{
    if(measureMethod==="live" && !isMobileOrTablet) setMeasureMethod("upload")
  },[measureMethod, isMobileOrTablet])

  return (
    <div>
      <div className="wizard-steps-row" style={{display:"flex",alignItems:"center",gap:0,marginBottom:24}}>
        {STEPS.map((label,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",flex:i<STEPS.length-1?1:"auto",minWidth:i<STEPS.length-1?0:"auto"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}} onClick={()=>i<step&&setStep(i)}>
              <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,
                background:i===step?"#f59e0b":i<step?"#10b981":"#f1f5f9",
                color:i<=step?"#000":"#94a3b8",transition:"all .2s",flexShrink:0}}>{i<step?"✓":i+1}</div>
              <span className="wizard-step-label" style={{fontSize:12,fontWeight:i===step?600:400,color:i===step?"#0f172a":i<step?"#10b981":"#94a3b8",whiteSpace:"nowrap"}}>{label}</span>
            </div>
            {i<STEPS.length-1&&<div style={{flex:1,height:1,background:i<step?"#10b981":"#e2e8f0",margin:"0 10px",minWidth:12}}/>}
          </div>
        ))}
      </div>

      {step===0 && (
        <div>
          <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap"}}>
            <Btn onClick={()=>{ setIsNewCust(false); setShowErrors(false) }} style={{border:!isNewCust?"2px solid #f59e0b":"1px solid #e2e8f0",background:!isNewCust?"#fef3c7":""}}>Existing Customer</Btn>
            <Btn onClick={()=>{ setIsNewCust(true); setShowErrors(false) }}  style={{border:isNewCust?"2px solid #f59e0b":"1px solid #e2e8f0",background:isNewCust?"#fef3c7":""}}>+ New Customer</Btn>
          </div>
          {!isNewCust ? (
            <>
              <FG label="Select Customer *" error={showErrors && !form.customerId ? "Please select a customer" : null}>
                <select style={s.input} value={form.customerId} onChange={e=>{ upd("customerId")(e.target.value); setSelectedJobId(""); }}>
                  <option value="">— Choose customer —</option>
                  {customers.map(c=><option key={c.id} value={c.id}>{c.name} · {c.phone}</option>)}
                </select>
              </FG>
              {form.customerId && (
                <FG label="Job (optional)">
                  <select style={s.input} value={selectedJobId} onChange={e=>setSelectedJobId(e.target.value)}>
                    <option value="">— No job —</option>
                    {jobs.filter(j=>j.customerId===form.customerId).map(j=>
                      <option key={j.id} value={j.id}>{j.jobNumber}</option>
                    )}
                  </select>
                </FG>
              )}
            </>
          ):(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
              <FG label="Full Name *" error={showErrors && !newCust.name.trim() ? "This field is required" : null}>
                <input style={s.input} value={newCust.name}    onChange={e=>setNewCust(p=>({...p,name:e.target.value}))}    placeholder="Sarah Thompson"/></FG>
              <FG label="Phone *" error={showErrors && !newCust.phone.trim() ? "This field is required" : null}>
                <input style={s.input} value={newCust.phone}   onChange={e=>setNewCust(p=>({...p,phone:e.target.value}))}   placeholder="021 999 0000"/></FG>
              <FG label="Email *" error={showErrors && !newCust.email.trim() ? "This field is required" : null}>
                <input style={s.input} value={newCust.email}   onChange={e=>setNewCust(p=>({...p,email:e.target.value}))}   placeholder="sarah@email.com"/></FG>
              <FG label="Address *" error={showErrors && !newCust.address.trim() ? "This field is required" : null}>
                <input style={s.input} value={newCust.address} onChange={e=>setNewCust(p=>({...p,address:e.target.value}))} placeholder="123 Main St, Auckland"/></FG>
            </div>
          )}
          <div style={{height:1,background:"#e2e8f0",margin:"18px 0"}}/>
          <FG label="Job Address *" error={showErrors && !form.address.trim() ? "This field is required" : null}>
            <input style={s.input} value={form.address} onChange={e=>upd("address")(e.target.value)} placeholder="47 Ridgeline Ave, Titirangi, Auckland"/></FG>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
            <FG label="Roof Type">
              <select style={s.input} value={form.roofType} onChange={e=>upd("roofType")(e.target.value)}>
                {MATERIALS.map(m=><option key={m.label}>{m.label}</option>)}
              </select>
            </FG>
            <FG label="Status">
              <select style={s.input} value={form.status} onChange={e=>upd("status")(e.target.value)}>
                {STATUSES.map(st=><option key={st}>{st}</option>)}
              </select>
            </FG>
          </div>
          <FG label="Notes *" error={showErrors && !form.notes.trim() ? "This field is required" : null}>
            <textarea style={{...s.input,resize:"vertical"}} rows={3} value={form.notes} onChange={e=>upd("notes")(e.target.value)} placeholder="Site notes, access details, special requirements..."/></FG>
        </div>
      )}

      {step===1 && (
        <div>
          {selectedJobId && (
            <div style={{marginBottom:16}}>
              <FG label="Select a photo from the job library to measure on">
                {jobPhotos.length===0 ? (
                  <div style={{fontSize:12,color:"#94a3b8"}}>No photos in this job yet.</div>
                ) : (
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(80px,1fr))",gap:8}}>
                    {jobPhotos.map(ph=>{
                      const picked = selectedJobPhotos.includes(ph.id)
                      return (
                        <div key={ph.id} onClick={()=>pickMeasurePhoto(ph)}
                          style={{position:"relative",aspectRatio:"1",borderRadius:8,overflow:"hidden",cursor:"pointer",
                            border: picked ? "3px solid #f59e0b" : "1px solid #e2e8f0"}}>
                          <img src={`${API_ORIGIN}${ph.url}`} alt="Job" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                          {picked && <div style={{position:"absolute",top:4,right:4,width:18,height:18,borderRadius:"50%",background:"#f59e0b",color:"#000",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>✓</div>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </FG>
            </div>
          )}
          {/* ← Measurement method picker: switches between the three
                measurement tools without losing wizard state. Switching
                methods clears the previous method's in-progress drawing
                (each component owns its own internal state), so the area
                shown resets to whatever the newly active tool reports. */}
          <div style={{display:"grid",gridTemplateColumns:`repeat(${MEASURE_METHODS.length},1fr)`,gap:10,marginBottom:16}} className="grid2-responsive">
            {MEASURE_METHODS.map(m=>(
              <div key={m.key}
                onClick={()=>{ if(!m.disabled) setMeasureMethod(m.key) }}
                style={{
                  cursor: m.disabled ? "not-allowed" : "pointer",padding:"12px 14px",borderRadius:10,
                  border: measureMethod===m.key ? "2px solid #f59e0b" : "1px solid #e2e8f0",
                  background: measureMethod===m.key ? "#fef3c7" : "#fff",
                  opacity: m.disabled ? 0.55 : 1,
                  transition:"all .15s",
                  position:"relative",
                }}>
                {m.disabled && (
                  <span style={{position:"absolute",top:8,right:8,fontSize:9,fontWeight:700,color:"#92400e",background:"#fef3c7",border:"1px solid #f59e0b",borderRadius:999,padding:"2px 7px"}}>SOON</span>
                )}
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                  <span style={{fontSize:16}}>{m.icon}</span>
                  <span style={{fontWeight:600,fontSize:13}}>{m.label}</span>
                </div>
                <div style={{fontSize:11,color:"#64748b",lineHeight:1.5}}>{m.desc}</div>
              </div>
            ))}
          </div>

          {/* ← Older projects were saved before the clean original photo was
              kept separately from the flattened quote snapshot, so there's
              genuinely no photo left to restore for them. Say so plainly
              instead of silently showing a blank canvas (or, as before,
              showing the flattened snapshot — which painted the old drawing
              in as uneditable pixels). Traced shapes still restore fine and
              stay fully editable either way. */}
          {measureMethod==="upload" && geometryLoaded && !activeMeasurePhotoUrl
            && !geometryFull?.original_photo_url && geometryFull?.sections?.length>0 && (
            <div style={{padding:"9px 12px",marginBottom:12,background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,fontSize:11.5,color:"#92400e",lineHeight:1.55}}>
              The original photo wasn't saved for this project (it predates that being stored), so the
              canvas starts blank. Your traced measurements are all still here and fully editable —
              upload the photo again above if you want to trace against the image.
            </div>
          )}

          {measureMethod==="upload" && (
            geometryLoaded ? (
              <MeasurementTool ref={measurementToolRef} onGeometryChange={handleGeometryChange}
                // ← ONLY the clean original photo is ever used as the tracing
                //   background. `snapshot_url` must never be used here: it's
                //   the FLATTENED photo+drawing composite (for embedding in
                //   quotes), so loading it as a background paints the previous
                //   session's shapes in as pixels — they look identical to real
                //   traced shapes but can't be selected, edited or deleted,
                //   which made deleting a section look permanently broken.
                //   Each save also re-captured that baked image, compounding it.
                //   No photo (older projects, saved before originals were kept)
                //   correctly means a blank canvas + the notice below.
                photoUrl={activeMeasurePhotoUrl
                  || (geometryFull?.original_photo_url ? `${API_ORIGIN}${geometryFull.original_photo_url}` : null)}
                onPhotoChange={setActiveMeasurePhotoUrl}
                initialGeometry={geometryFull}
                company={company}/>
            ) : (
              <div style={{padding:"48px 20px",textAlign:"center",color:"#64748b",fontSize:13}}>Loading previous measurement…</div>
            )
          )}
          {measureMethod==="live" && (
            <LiveCameraMeasurements onGeometryChange={handleGeometryChange}/>
          )}
          {measureMethod==="ar" && (
            <div style={{padding:"48px 20px",textAlign:"center",border:"1px dashed #e2e8f0",borderRadius:10,color:"#64748b"}}>
              <div style={{fontSize:32,marginBottom:10}}>📐</div>
              <div style={{fontWeight:600,fontSize:14,marginBottom:4,color:"#0f172a"}}>AR Camera — Coming Soon</div>
              <div style={{fontSize:12}}>WebXR AR measuring is currently in development. Use Upload &amp; draw or Live camera for now.</div>
            </div>
          )}
        </div>
      )}

      {step===2 && <EstimateEngine initialArea={area||0} initialGeometry={geometryFull} initialEstimate={existingProject?.estimate} onEstimateChange={handleEstimateChange} company={company}/>}

      {step===3 && (
        <div className="wizard-review-grid">
          <div style={{flex:1,overflowY:"auto",maxHeight:"55vh",width:"100%"}}>
            <QuoteView
              project={{...form,area,estimate,quoteNum:nextQuoteNum(projects),quoteDate:today()}}
              customer={isNewCust ? newCust : customers.find(c=>c.id===form.customerId)}
              company={company}
              asbestosOverride={geometryFull?.asbestos}
            />
          </div>
          <div className="wizard-review-sidebar" style={{width:180,flexShrink:0}}>
            <div style={s.card}>
              <div style={{fontWeight:600,marginBottom:10}}>Review</div>
              {estimate && (
                <div style={{fontSize:12,color:"#64748b",lineHeight:2}}>
                  <div>Area: <strong>{area||0} m²</strong></div>
                  <div>Material: <strong>{estimate.materialLabel}</strong></div>
                  <div>Total: <strong style={{color:"#0f172a"}}>{fmt(estimate.total)}</strong></div>
                </div>
              )}
              {!estimate && <div style={{fontSize:12,color:"#f59e0b"}}>⚠ No estimate — quote will save without pricing.</div>}
            </div>
          </div>
        </div>
      )}

      <div style={{display:"flex",justifyContent:"space-between",marginTop:24,paddingTop:18,borderTop:"1px solid #e2e8f0",flexWrap:"wrap",gap:10}}>
        <Btn onClick={step===0?onCancel:stepBack}>{step===0?"Cancel":"← Back"}</Btn>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          {/* {step<STEPS.length-1 && (
            <Btn onClick={stepNext}>Skip →</Btn>
          )} */}
          {/* to be removed 08/04/2026  */}

          {step<STEPS.length-1
            ? <Btn primary onClick={stepNext}>Next →</Btn>
            : <Btn primary onClick={save}>{saving?"Saving…":(isEdit?"Update Project":"Save Project ✓")}</Btn>
          }
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── PIPELINE ───────────────────────────
function Pipeline({ projects, customers, setProjects, setView, setSelectedProject }) {
  const { formatMoney: fmt } = useCurrency()   // ← currency-aware fmt

  const getCustomer = id => customers.find(c=>c.id===id)
  const [draggingId,  setDraggingId]  = useState(null)
  const [dragOverCol, setDragOverCol] = useState(null)

  async function moveStatus(project, newStatus) {
    if(project.status === newStatus) return
    setProjects(prev=>prev.map(p=>p.id===project.id?{...p,status:newStatus}:p))
    try {
      await projectsApi.updateStatus(project.id, newStatus)
    } catch(err) {
      console.error("Failed to update status:", err)
      setProjects(prev=>prev.map(p=>p.id===project.id?{...p,status:project.status}:p))
    }
  }

  function onDragStart(e, project) {
    setDraggingId(project.id)
    e.dataTransfer.effectAllowed = "move"
    e.dataTransfer.setData("projectId", project.id)
    const ghost = document.createElement("div")
    ghost.style.cssText = ["position:fixed","top:-999px","left:-999px","background:#0f172a","color:#fff","font:600 12px/1 'DM Sans',sans-serif","padding:6px 12px","border-radius:8px","white-space:nowrap","pointer-events:none","z-index:9999","box-shadow:0 4px 12px rgba(0,0,0,0.3)"].join(";")
    const cust = customers.find(c=>c.id===project.customerId)
    ghost.textContent = "↔  Moving: " + (cust?.name || project.address || "project")
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, -12, -12)
    requestAnimationFrame(() => ghost.remove())
  }
  function onDragEnd() { setDraggingId(null); setDragOverCol(null) }

  function onColumnDragOver(e, status) { e.preventDefault(); e.dataTransfer.dropEffect="move"; setDragOverCol(status) }
  function onColumnDragLeave(e) { if(!e.currentTarget.contains(e.relatedTarget)) setDragOverCol(null) }
  function onColumnDrop(e, status) {
    e.preventDefault()
    const project = projects.find(p=>p.id===e.dataTransfer.getData("projectId"))
    if(project && project.status !== status) moveStatus(project, status)
    setDraggingId(null); setDragOverCol(null)
  }

  const draggingProject = projects.find(p=>p.id===draggingId)

  return (
    <>
      <style>{`
        .pipeline-card { transition: box-shadow .15s, opacity .15s, transform .15s; }
        .pipeline-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.10); }
        .pipeline-card[draggable="true"] { cursor: grab; }
        .pipeline-card[draggable="true"]:active { cursor: grabbing; }
        .pipeline-card.is-dragging { opacity: 0.42; transform: scale(0.97); box-shadow: none; }
        .pipeline-is-dragging, .pipeline-is-dragging * { cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='9' fill='%23111827' opacity='.85'/%3E%3Ctext x='10' y='14' text-anchor='middle' font-size='11' fill='white'%3E✥%3C/text%3E%3C/svg%3E") 10 10, grabbing !important; }
        .pipeline-col-drop { transition: background .15s, box-shadow .15s; }
        .pipeline-col-drop.drag-over { background: #f0f9ff !important; box-shadow: inset 0 0 0 2px #3b82f6; border-radius: 0 0 10px 10px; }
        .pipeline-drop-hint { display:none; text-align:center; padding:10px 8px; border:2px dashed #93c5fd; border-radius:8px; margin-bottom:8px; color:#3b82f6; font-size:11px; font-weight:600; background:rgba(59,130,246,0.04); pointer-events:none; }
        .pipeline-col-drop.drag-over .pipeline-drop-hint { display: block; }
      `}</style>

      <div className={draggingId ? "pipeline-is-dragging" : ""} style={{overflowX:"auto",paddingBottom:12}}>
        {draggingId && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"8px 14px",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,fontSize:12,color:"#92400e",fontWeight:500}}>
            <span style={{fontSize:15}}>↔</span>
            Drag <strong>{getCustomer(draggingProject?.customerId)?.name||"project"}</strong> to a column to move it
          </div>
        )}
        <div style={{display:"flex",gap:14,minWidth:"max-content"}}>
          {STATUSES.map(status=>{
            const cols   = projects.filter(p=>p.status===status)
            const st     = STATUS_STYLE[status]
            const colVal = cols.reduce((a,p)=>a+(p.estimate?.total||0),0)
            const isOver = dragOverCol===status
            return (
              <div key={status} style={{width:220}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderRadius:"10px 10px 0 0",background:isOver?STATUS_STYLE[status].dot:st.bg,color:isOver?"#fff":st.color,transition:"background .15s, color .15s"}}>
                  <span style={{fontWeight:700,fontSize:12}}>{status}</span>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:11,fontWeight:700}}>{cols.length}</div>
                    {colVal>0&&<div style={{fontSize:10,opacity:.8}}>{fmt(colVal)}</div>}
                  </div>
                </div>
                <div className={"pipeline-col-drop"+(isOver?" drag-over":"")}
                  style={{border:"1px solid #e2e8f0",borderTop:"none",borderRadius:"0 0 10px 10px",padding:8,minHeight:240,background:"#f8fafc"}}
                  onDragOver={e=>onColumnDragOver(e,status)} onDragLeave={onColumnDragLeave} onDrop={e=>onColumnDrop(e,status)}>
                  <div className="pipeline-drop-hint">Drop here → {status}</div>
                  {cols.map(p=>{
                    const cust = getCustomer(p.customerId)
                    const isDragging = draggingId===p.id
                    return (
                      <div key={p.id}
                        className={"pipeline-card"+(isDragging?" is-dragging":"")}
                        draggable onDragStart={e=>onDragStart(e,p)} onDragEnd={onDragEnd}
                        style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,padding:12,marginBottom:8,userSelect:"none"}}
                        onClick={()=>{ if(!draggingId){ setSelectedProject(p); setView("project") } }}>
                        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:2}}>
                          <div style={{fontWeight:600,fontSize:13,flex:1}}>{cust?.name||"—"}</div>
                          <span title="Drag to move" style={{fontSize:12,color:"#cbd5e1",marginLeft:4,flexShrink:0,cursor:"grab"}}>⠿</span>
                        </div>
                        <div style={{fontSize:11,color:"#64748b",marginBottom:6,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.address}</div>
                        {p.estimate && <div style={{fontWeight:700,fontSize:13,color:"#b45309"}}>{fmt(p.estimate.total)}</div>}
                        {!p.estimate && p.area>0 && <div style={{fontSize:11,color:"#64748b"}}>{p.area} m²</div>}
                        <div style={{marginTop:8}}>
                          <select value={status} onChange={e=>{e.stopPropagation();moveStatus(p,e.target.value)}}
                            onClick={e=>e.stopPropagation()}
                            style={{fontSize:10,padding:"2px 6px",border:"1px solid #e2e8f0",borderRadius:6,background:"#f8fafc",cursor:"pointer",width:"100%"}}>
                            {STATUSES.map(st=><option key={st}>{st}</option>)}
                          </select>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

// ─────────────────────────── PROJECTS LIST ───────────────────────────
function ProjectsList({ projects, customers, setProjects, setView, setSelectedProject }) {
  const { formatMoney: fmt } = useCurrency()   // currency format

  const [search,       setSearch]       = useState("")
  const [filterStatus, setFilterStatus] = useState("All")
  const [selected,     setSelected]     = useState([]) // selected project ids, for bulk delete
  const getCustomer = id => customers.find(c=>c.id===id)

  async function del(id) {
    if(!window.confirm("Delete this project? It can be restored from the database if needed.")) return
    try {
      await projectsApi.delete(id)
      setProjects(prev=>prev.filter(p=>p.id!==id))
      setSelected(prev=>prev.filter(pid=>pid!==id))
    } catch(err) { console.error("Failed to delete project:", err) }
  }

  async function delSelected() {
    if(!selected.length) return
    if(!window.confirm(`Delete ${selected.length} selected project${selected.length===1?"":"s"}? They can be restored from the database if needed.`)) return
    const ids = selected
    const results = await Promise.allSettled(ids.map(id=>projectsApi.delete(id)))
    const failedIds = ids.filter((id,i)=>results[i].status==="rejected")
    setProjects(prev=>prev.filter(p=>!ids.includes(p.id) || failedIds.includes(p.id)))
    setSelected(failedIds)
    if(failedIds.length) console.error("Failed to delete some projects:", failedIds)
  }

  const filtered = projects
    .filter(p=>filterStatus==="All"||p.status===filterStatus)
    .filter(p=>{
      const cust=getCustomer(p.customerId)
      const q=search.toLowerCase()
      return !q || (cust?.name||"").toLowerCase().includes(q) || p.address.toLowerCase().includes(q)
    })
    .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))

  const allFilteredSelected = filtered.length>0 && filtered.every(p=>selected.includes(p.id))
  const toggleSelectAll = () => {
    if(allFilteredSelected) setSelected(prev=>prev.filter(id=>!filtered.some(p=>p.id===id)))
    else setSelected(prev=>[...new Set([...prev, ...filtered.map(p=>p.id)])])
  }
  const toggleOne = id => setSelected(prev=>prev.includes(id) ? prev.filter(x=>x!==id) : [...prev,id])

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20,flexWrap:"wrap"}}>
        <input style={{...s.input,width:240}} placeholder="Search projects..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {["All",...STATUSES].map(st=>(
            <button key={st} onClick={()=>setFilterStatus(st)}
              style={{padding:"6px 12px",borderRadius:20,fontSize:11,fontWeight:500,cursor:"pointer",border:"none",
                background:filterStatus===st?(STATUS_STYLE[st]||{bg:"#0f172a"}).bg||"#0f172a":"#f1f5f9",
                color:filterStatus===st?(STATUS_STYLE[st]||{color:"#fff"}).color||"#fff":"#64748b"}}>
              {st} {st!=="All"&&`(${projects.filter(p=>p.status===st).length})`}
            </button>
          ))}
        </div>
        {selected.length>0 && (
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <span style={{fontSize:12,color:"#64748b"}}>{selected.length} selected</span>
            <Btn sm onClick={()=>setSelected([])}>Unselect All</Btn>
            <Btn sm danger onClick={delSelected}>🗑 Delete Selected ({selected.length})</Btn>
          </div>
        )}
        <span style={{marginLeft:"auto",fontSize:13,color:"#64748b"}}>{filtered.length} projects</span>
      </div>
      <div style={{...s.card,padding:0,overflow:"hidden"}}>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:640}}>
            <thead>
              <tr>
                <th style={{...s.th,width:36}}>
                  <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAll}
                    title={allFilteredSelected ? "Unselect all" : "Select all"} style={{cursor:"pointer"}}/>
                </th>
                {["Customer","Address","Roof Area","Value","Status","Date","",""].map((h,i)=><th key={i} style={s.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {filtered.map(p=>{
                const cust=getCustomer(p.customerId)
                return (
                  <tr key={p.id} style={{cursor:"pointer"}} onClick={()=>{ setSelectedProject(p); setView("project") }}>
                    <td style={s.td} onClick={e=>e.stopPropagation()}>
                      <input type="checkbox" checked={selected.includes(p.id)} onChange={()=>toggleOne(p.id)} style={{cursor:"pointer"}}/>
                    </td>
                    <td style={s.td}><div style={{fontWeight:500}}>{cust?.name||"—"}</div><div style={{fontSize:11,color:"#64748b"}}>{cust?.phone}</div></td>
                    <td style={{...s.td,maxWidth:200}}><div style={{fontSize:12,color:"#64748b",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.address}</div></td>
                    <td style={s.td}>{p.area>0 ? p.area+" m²" : <span style={{color:"#94a3b8"}}>—</span>}</td>
                    <td style={s.td}><span style={{fontWeight:600}}>{p.estimate?fmt(p.estimate.total):<span style={{color:"#94a3b8"}}>—</span>}</span></td>
                    <td style={s.td}><StatusBadge status={p.status}/></td>
                    <td style={{...s.td,color:"#64748b",fontSize:12}}>{fmtD(p.createdAt)}</td>
                    <td style={s.td}><span style={{color:"#3b82f6",fontSize:12}}>View →</span></td>
                    <td style={s.td} onClick={e=>e.stopPropagation()}>
                      <Btn sm danger onClick={()=>del(p.id)}>Delete</Btn>
                    </td>
                  </tr>
                )
              })}
              {filtered.length===0&&<tr><td colSpan={9} style={{...s.td,textAlign:"center",color:"#94a3b8",padding:32}}>No projects found</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── PROJECT DETAIL ───────────────────────────
// ─────────────────────────── LINKED JOB PHOTOS (read-only) ───────────────────────────
// Shows the photos from the job this project was created from — no upload
// dropzone here, since uploading happens on the Jobs page against the
// shared job library, not per-project.
function LinkedJobPhotos({ jobId }) {
  const [photos, setPhotos]   = useState([])
  const [loading, setLoading] = useState(true)
  const [lightbox, setLightbox] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    jobPhotosApi.getForJob(jobId)
      .then(rows => { if (!cancelled) setPhotos(rows) })
      .catch(()  => { if (!cancelled) setPhotos([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jobId])

  if (loading || photos.length===0) return null


  return (
    <div style={{...s.card, marginTop:14}}>
      <div style={{fontWeight:700,marginBottom:14}}>Photos <span style={{color:"#94a3b8",fontWeight:400}}>({photos.length})</span></div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))",gap:8}}>
        {photos.map(ph=>(
          <div key={ph.id} onClick={()=>setLightbox(`${API_ORIGIN}${ph.url}`)}
            style={{aspectRatio:"1",borderRadius:8,overflow:"hidden",border:"1px solid #e2e8f0",cursor:"pointer"}}>
            <img src={`${API_ORIGIN}${ph.url}`} alt="Job" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          </div>
        ))}
      </div>
      {lightbox && (
        <div onClick={()=>setLightbox(null)} style={{position:"fixed",inset:0,background:"rgba(15,23,42,.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,cursor:"zoom-out"}}>
          <img src={lightbox} alt="Job full size" style={{maxWidth:"90vw",maxHeight:"90vh",borderRadius:8}}/>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────── PROJECT PHOTOS ───────────────────────────
// Drag-and-drop gallery for a project's roof photos. Talks straight to the
// photos API rather than routing through project state, since photos are
// their own resource (own table, own upload lifecycle).
function ProjectPhotos({ projectId }) {
  const [photos, setPhotos]   = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver]   = useState(false)
  const [error, setError]         = useState("")
  const [lightbox, setLightbox]   = useState(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    photosApi.getForProject(projectId)
      .then(rows => { if (!cancelled) setPhotos(rows) })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId])

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/"))
    if (!files.length) return
    setUploading(true); setError("")
    try {
      const created = await photosApi.upload(projectId, files)
      setPhotos(prev => [...created, ...prev])
    } catch (err) {
      setError(err.message || "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  async function removePhoto(id) {
    const prev = photos
    setPhotos(p => p.filter(ph => ph.id !== id))
    try { await photosApi.delete(id) }
    catch (err) { setError(err.message); setPhotos(prev) }
  }


  return (
    <div style={{...s.card, marginTop:14}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{fontWeight:700}}>Photos {photos.length>0 && <span style={{color:"#94a3b8",fontWeight:400}}>({photos.length})</span>}</div>
        {uploading && <span style={{fontSize:11,color:"#f59e0b"}}>Uploading…</span>}
      </div>

      <div
        onClick={()=>fileInputRef.current?.click()}
        onDragOver={e=>{ e.preventDefault(); setDragOver(true) }}
        onDragLeave={()=>setDragOver(false)}
        onDrop={e=>{ e.preventDefault(); setDragOver(false); uploadFiles(e.dataTransfer.files) }}
        style={{
          border: dragOver ? "2px dashed #f59e0b" : "2px dashed #e2e8f0",
          background: dragOver ? "#fef3c7" : "#f8fafc",
          borderRadius:10, padding:"22px 14px", textAlign:"center",
          cursor:"pointer", transition:"all .15s", marginBottom: photos.length ? 14 : 0,
        }}>
        <div style={{fontSize:22,marginBottom:4}}>📷</div>
        <div style={{fontSize:12,fontWeight:600,color:"#0f172a"}}>Drag & drop roof photos here</div>
        <div style={{fontSize:11,color:"#64748b",marginTop:2}}>or click to browse — JPG, PNG, WEBP up to 10MB</div>
        <input
          ref={fileInputRef} type="file" accept="image/*" multiple
          style={{display:"none"}}
          onChange={e=>{ uploadFiles(e.target.files); e.target.value="" }}
        />
      </div>

      {error && <div style={{fontSize:12,color:"#991b1b",background:"#fee2e2",borderRadius:8,padding:"8px 12px",marginBottom:10}}>{error}</div>}

      {!loading && photos.length>0 && (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))",gap:8}}>
          {photos.map(ph=>(
            <div key={ph.id} style={{position:"relative",aspectRatio:"1",borderRadius:8,overflow:"hidden",border:"1px solid #e2e8f0"}}>
              <img
                src={`${API_ORIGIN}${ph.url}`} alt="Roof"
                onClick={()=>setLightbox(`${API_ORIGIN}${ph.url}`)}
                style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}}
              />
              <button
                onClick={()=>removePhoto(ph.id)}
                title="Remove photo"
                style={{position:"absolute",top:4,right:4,width:20,height:20,borderRadius:"50%",border:"none",background:"rgba(15,23,42,.75)",color:"#fff",fontSize:11,lineHeight:1,cursor:"pointer"}}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {lightbox && (
        <div onClick={()=>setLightbox(null)} style={{position:"fixed",inset:0,background:"rgba(15,23,42,.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,cursor:"zoom-out"}}>
          <img src={lightbox} alt="Roof full size" style={{maxWidth:"90vw",maxHeight:"90vh",borderRadius:8}}/>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────── QUOTE HISTORY ───────────────────────────
function QuoteHistory({ projectId }) {
  const { formatMoney } = useCurrency()
  const [quotes, setQuotes]   = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    quotesApi.getForProject(projectId)
      .then(rows => { if (!cancelled) setQuotes(rows) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId])

  if (loading || !quotes.length) return null

  return (
    <div style={{...s.card, marginTop:14}}>
      <div style={{fontWeight:700,marginBottom:12}}>Quote History</div>
      {quotes.map(q=>(
        <div key={q.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #f1f5f9",fontSize:12}}>
          <div>
            <div style={{fontWeight:600}}>{q.quoteNum}</div>
            <div style={{color:"#94a3b8"}}>{fmtD(q.quoteDate)}</div>
          </div>
          <div style={{fontWeight:600}}>{formatMoney(q.total)}</div>
        </div>
      ))}
    </div>
  )
}

function ProjectDetail({ project, customers, setProjects, setView, onEdit, company }) {
  const { formatMoney, currency } = useCurrency()   // ← currency-aware formatter
  const cs = currency?.symbol || "$"

  if(!project) return null
  const cust = customers.find(c=>c.id===project.customerId)
  const e    = project.estimate
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [copied,         setCopied]         = useState(false)
  const [geometrySnapshotUrl, setGeometrySnapshotUrl] = useState(null)
  const [hasAsbestosRisk,     setHasAsbestosRisk]     = useState(false)

  // ← Keyed on the whole `project` object, not `project.id`: saving an edit
  //   returns to the SAME project, so an id-only dependency never re-ran and
  //   the Measurement Plan / asbestos flag kept showing the pre-edit values
  //   until a full page reload. Saving calls setSelectedProject() with a
  //   fresh object, so the reference change is what signals "refetch now".
  useEffect(()=>{
    let cancelled = false
    estimatesApi.getGeometry(project.id)
      .then(g => { if(!cancelled) { setGeometrySnapshotUrl(g?.snapshot_url || null); setHasAsbestosRisk(!!g?.asbestos) } })
      .catch(()=>{ if(!cancelled) { setGeometrySnapshotUrl(null); setHasAsbestosRisk(false) } })
    return () => { cancelled = true }
  },[project])

  async function updateStatus(newStatus) {
    try {
      await projectsApi.updateStatus(project.id, newStatus)
      setProjects(prev=>prev.map(p=>p.id===project.id?{...p,status:newStatus}:p))
    } catch(err) { console.error("updateStatus failed:", err) }
  }

  async function del() {
    if(!window.confirm("Delete this project? It can be restored from the database if needed.")) return
    try {
      await projectsApi.delete(project.id)
      setProjects(prev=>prev.filter(p=>p.id!==project.id))
      setView("projects")
    } catch(err) { console.error("Failed to delete project:", err) }
  }

  function handlePrint() {
    setView("quote_print")
    setTimeout(() => window.print(), 400)
  }

  function buildEmailHTML() {
    const co = company || {}
    const e  = project.estimate
    const qn = project.quoteNum || "DRAFT"
    const qd = project.quoteDate || today()
    const exp = new Date(new Date(qd.slice(0,10)+"T12:00:00").getTime()+30*86400000).toISOString().slice(0,10)
    const fmtD_local = d => { if(!d) return "—"; const iso = String(d).includes("T") ? d : d.slice(0,10)+"T12:00:00"; return new Date(iso).toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"}) }
    // ← use currency-aware formatter instead of hardcoded "$"
    const fmt_local = formatMoney

    // Same wastage % calcEst applied to flashing/gutter cost — recomputed
    // here so the shown qty × rate always equals the shown total.
    const wasteFactor = 1 + (e?.waste||0)/100

    const flashingLines = e?.flashingRuns?.length
      ? e.flashingRuns.map(r=>({ desc:r.materialLabel?`${r.label} — ${r.materialLabel}`:`${r.label} flashing`, qty:`${(flashingQtyM(r)*wasteFactor).toFixed(2)}m`, unit:`${cs}${r.rate||0}/m`, total:flashingQtyM(r)*wasteFactor*(r.rate||0), brand:extractBrand(r.materialLabel) }))
      : [{ desc:"Flashings — ridge/hip/valley", qty:`${((e?.flashings||0)*wasteFactor).toFixed(1)}m`, unit:`${cs}${RATES.flashings}/m`, total:e?.flashCost||0 }]

    const materialLines = e?.sections?.length
      ? e.sections.filter(sec=>sec.surface_m2!=null).map(sec=>({ desc:`${sec.name}`, qty:`${(sec.surface_m2*wasteFactor).toFixed(2)} m²`, unit:`${cs}${sec.rate||0}/m²`, total:sec.surface_m2*wasteFactor*(sec.rate||0), brand:extractBrand(sec.materialLabel) }))
      : [{ desc:`${e?.materialLabel} roofing`, qty:`${e?.adjArea?.toFixed(1)} m²`, unit:`${cs}${e?.materialRate}/m²`, total:e?.matCost||0 }]

    const gutterLines = e?.gutterRuns?.length
      ? e.gutterRuns.map(g=>({ desc:g.materialLabel?`Guttering — ${g.materialLabel}`:"Guttering", qty:`${(g.length_m*wasteFactor).toFixed(2)}m`, unit:`${cs}${g.rate||0}/m`, total:g.length_m*wasteFactor*(g.rate||0), brand:extractBrand(g.materialLabel) }))
      : [{ desc:"Guttering", qty:`${((e?.guttering||0)*wasteFactor).toFixed(1)}m`, unit:`${cs}${RATES.guttering}/m`, total:e?.gutCost||0 }]
    const downpipeLines = e?.downpipeItems?.length
      ? e.downpipeItems.map((d,i)=>({ desc:d.materialLabel?`Downpipe #${i+1} — ${d.materialLabel}${d.bends>0?` (+${d.bends} bend${d.bends===1?"":"s"})`:""}${d.spreader?" (+spreader)":""}`:`Downpipe #${i+1}`, qty:`${d.quantity||1} × ${d.preferredLength||"—"}m`, unit:`${cs}${d.rate||0}`, total:downpipeItemTotal(d, e.downpipeBendRate, e.spreaderRate), brand:extractBrand(d.materialLabel) }))
      : [{ desc:"Downpipes", qty:`${e?.downpipes||0} each`, unit:`${cs}${RATES.downpipe}/each`, total:e?.downpipeCost||0 }]
    const drainLines = e?.drainItems?.length
      ? e.drainItems.map((d,i)=>({ desc:d.materialLabel?`Drain #${i+1} — ${d.materialLabel}`:`Drain #${i+1}`, qty:"1 each", unit:`${cs}${d.rate||0}`, total:d.rate||0, brand:extractBrand(d.materialLabel) }))
      : [{ desc:"Drains", qty:`${e?.drains||0} each`, unit:`${cs}${RATES.drain}/each`, total:e?.drainCost||0 }]
    const penetrationLines = e?.penetrationItems?.length
      ? e.penetrationItems.map((p,i)=>({ desc:p.materialLabel?`Penetration #${i+1} — ${p.materialLabel} — supply & seal`:`Penetration #${i+1} — supply & seal`, qty:"1 each", unit:`${cs}${p.rate||0}`, total:p.rate||0, brand:extractBrand(p.materialLabel) }))
      : [{ desc:"Penetrations", qty:`${e?.penetrations||0} each`, unit:`${cs}${RATES.penetration}/each`, total:e?.penetrationCost||0 }]

    const quoteLines = e ? groupQuoteLinesByBrand([
      ...materialLines,
      ...flashingLines,
      ...gutterLines,
      ...downpipeLines,
      ...drainLines,
      ...penetrationLines,
      { desc:`Labour — installation (${e.days} days)`,        qty:"—",                           unit:"—",                     total:e.labCost   },
    ].filter(l => l.total > 0)) : []

    const lineRowsHTML = quoteLines.map(li => li.isBrandHeader ? `
      <tr>
        <td colspan="4" style="padding:10px 12px 4px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:700;">${li.brand}</td>
      </tr>` : `
      <tr>
        <td style="padding:10px 12px;padding-left:${li.indented?"24px":"12px"};border-bottom:1px solid #f1f5f9;font-size:13px;">${li.desc}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">${li.qty}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:right;">${li.unit}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:right;font-weight:500;">${fmt_local(li.total)}</td>
      </tr>`).join("")

    // Email HTML gets pasted into external mail clients, so image src must
    // be absolute (relative /uploads/... paths won't resolve there).
    const logoHTML   = co.logoUrl   ? `<img src="${API_ORIGIN}${co.logoUrl}" alt="" style="width:48px;height:48px;object-fit:contain;margin-right:14px;"/>` : ""
    const badgesHTML = co.badgesUrl ? `<div style="margin-top:16px;"><img src="${API_ORIGIN}${co.badgesUrl}" alt="" style="width:100%;height:auto;display:block;"/></div>` : ""
    const signOffHTML = (co.estimatorName || co.estimatorTitle) ? `
      <div style="margin-top:24px;font-size:13px;color:#0f172a;line-height:1.8;">
        Ngā mihi,<br/>
        <strong>${co.estimatorName||""}</strong><br/>
        ${co.estimatorTitle||""}<br/>
        ${co.companyName||"DK Roofing"}
      </div>` : ""
    const snapshotHTML = geometrySnapshotUrl ? `
      <div style="margin-top:20px;padding-top:18px;border-top:1px solid #e2e8f0;">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:#94a3b8;margin-bottom:10px;">Roof Measurement Plan</div>
        <img src="${API_ORIGIN}${geometrySnapshotUrl}" alt="Roof measurement plan" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;"/>
      </div>` : ""

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
  <div style="background:#0f172a;padding:28px 32px;display:flex;justify-content:space-between;align-items:flex-start;">
    <div style="display:flex;align-items:flex-start;">
      ${logoHTML}
      <div>
        <div style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">${co.companyName||"DK Roofing"}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:6px;line-height:1.8;">
          ${co.companyAddress||""}<br/>${co.companyEmail||""} &nbsp;·&nbsp; ${co.companyPhone||""}<br/>GST No: ${co.companyGst||""}
        </div>
      </div>
    </div>
    <div style="text-align:right;">
      <div style="display:inline-block;background:#f59e0b;color:#000;font-size:10px;font-weight:700;padding:3px 12px;border-radius:20px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Quote</div>
      <div style="font-size:15px;font-weight:700;color:#ffffff;">${qn}</div>
      <div style="font-size:12px;color:#94a3b8;line-height:1.8;margin-top:4px;">Issued: ${fmtD_local(qd)}<br/>Expires: ${fmtD_local(exp)}</div>
    </div>
  </div>
  <div style="padding:32px;">
    <div style="margin-bottom:24px;">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:#94a3b8;margin-bottom:8px;">Prepared For</div>
      <div style="font-size:15px;font-weight:700;color:#0f172a;">${cust?.name||"—"}</div>
      <div style="font-size:13px;color:#64748b;line-height:1.8;margin-top:4px;">${cust?.address||""}<br/>${cust?.email||""} &nbsp;·&nbsp; ${cust?.phone||""}</div>
    </div>
    <div style="margin-bottom:24px;">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:#94a3b8;margin-bottom:8px;">Address / Scope</div>
      <div style="font-size:13px;font-weight:600;color:#0f172a;">${project.address}</div>
      ${project.notes?`<div style="font-size:12px;color:#64748b;margin-top:6px;line-height:1.7;padding:10px 14px;background:#f8fafc;border-radius:6px;border-left:3px solid #e2e8f0;">${project.notes}</div>`:""}
    </div>
    ${e?`
    <div style="margin-bottom:24px;">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:#94a3b8;margin-bottom:10px;">Line Items</div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <thead><tr style="background:#f8fafc;">
          <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:1px solid #e2e8f0;">Description</th>
          <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:1px solid #e2e8f0;">Qty</th>
          <th style="text-align:right;padding:10px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:1px solid #e2e8f0;">Rate</th>
          <th style="text-align:right;padding:10px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:1px solid #e2e8f0;">Amount</th>
        </tr></thead>
        <tbody>${lineRowsHTML}</tbody>
      </table>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:24px;">
      <div style="min-width:260px;">
        ${e.discountAmt>0 ? `<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;"><span style="color:#64748b;">Subtotal before discount</span><span style="font-weight:500;">${fmt_local(e.sellPrice+e.discountAmt)}</span></div>
        <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;"><span style="color:#64748b;">Discount (${e.discountType==="fixed" ? cs+e.discountValue : (e.discountValue||0)+"%"})</span><span style="font-weight:500;">− ${fmt_local(e.discountAmt)}</span></div>` : ``}
        <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;"><span style="color:#64748b;">Subtotal (excl. GST)</span><span style="font-weight:500;">${fmt_local(e.sellPrice)}</span></div>
        <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;"><span style="color:#64748b;">GST (${((e.gstRate ?? GST_RATE)*100).toFixed(0)}%)</span><span style="font-weight:500;">${fmt_local(e.gst)}</span></div>
        <div style="background:#0f172a;border-radius:8px;padding:14px 16px;margin-top:10px;display:flex;justify-content:space-between;align-items:center;">
          <span style="color:#fff;font-weight:700;font-size:14px;">Total inc. GST</span>
          <span style="color:#f59e0b;font-family:'DM Sans',Arial,sans-serif;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;">${fmt_local(e.total)}</span>
        </div>
      </div>
    </div>`:`
    <div style="padding:16px;background:#fef3c7;border-radius:8px;font-size:13px;color:#92400e;margin-bottom:24px;">⚠ Pricing to be confirmed — please contact us for a full estimate.</div>`}
    ${hasAsbestosRisk ? `
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid #e2e8f0;">
      <div style="font-size:11px;color:#64748b;line-height:1.7;">⚠️ <strong style="color:#0f172a;">Asbestos Warning:</strong> Existing roofing materials must not be disturbed. Where asbestos-containing materials (ACMs) are known or suspected, an asbestos assessment is required before any roofing work commences. Asbestos testing, removal, and disposal are excluded from this quotation unless expressly included.</div>
    </div>` : ""}
    <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
      <div style="font-size:11px;color:#94a3b8;line-height:2.1;">
        <strong style="color:#64748b;">Terms:</strong> 50% deposit on acceptance. Balance on completion within 7 days of invoice.<br/>
        <strong style="color:#64748b;">Payment:</strong> Bank transfer to ${co.companyName||"DK Roofing"} — ${co.companyBank||""}<br/>
        <strong style="color:#64748b;">Validity:</strong> This quote is valid for 30 days from date of issue. Subject to site inspection.
      </div>
    </div>
    ${signOffHTML}
    ${badgesHTML}
    ${snapshotHTML}
  </div>
  <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center;">
    <div style="font-size:11px;color:#94a3b8;">${co.companyName||"DK Roofing"} &nbsp;·&nbsp; ${co.companyPhone||""} &nbsp;·&nbsp; ${co.companyEmail||""}</div>
  </div>
</div></body></html>`
  }

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20,flexWrap:"wrap"}}>
        <Btn onClick={()=>setView("projects")}>← Projects</Btn>
        <div style={{flex:1}}/>
        <select value={project.status} onChange={ev=>updateStatus(ev.target.value)}
          style={{padding:"8px 12px",border:"1px solid #e2e8f0",borderRadius:8,fontSize:13,fontFamily:"inherit",cursor:"pointer",background:"#fff"}}>
          {STATUSES.map(st=><option key={st}>{st}</option>)}
        </select>
        <Btn primary onClick={onEdit}>✏ Edit Project</Btn>
        <Btn danger onClick={del}>Delete</Btn>
      </div>

      <div style={s.grid2} className="grid2-responsive">
        <div>
          <div style={s.card}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:4}}>{cust?.name||"—"}</div>
            <div style={{fontSize:13,color:"#64748b",lineHeight:1.9}}>{cust?.email}<br/>{cust?.phone}</div>
            <div style={{height:1,background:"#f1f5f9",margin:"14px 0"}}/>
            <div style={{fontSize:12,color:"#64748b",marginBottom:4}}>Job Address</div>
            <div style={{fontSize:13,fontWeight:500}}>{project.address}</div>
            {project.roofType&&<div style={{marginTop:8}}><span style={{fontSize:11,color:"#64748b"}}>Roof Type: </span><span style={{fontSize:12,fontWeight:500}}>{project.roofType}</span></div>}
            {project.area>0&&<div><span style={{fontSize:11,color:"#64748b"}}>Area: </span><span style={{fontSize:12,fontWeight:500}}>{project.area} m²</span></div>}
            {project.notes&&(
              <div style={{marginTop:14,padding:12,background:"#f8fafc",borderRadius:8,fontSize:12,color:"#64748b",lineHeight:1.7}}>📋 {project.notes}</div>
            )}
          </div>

          {project.jobId
            ? <LinkedJobPhotos jobId={project.jobId}/>
            : <ProjectPhotos projectId={project.id}/>}

          {geometrySnapshotUrl && (
            <div style={{...s.card,marginTop:14}}>
              <div style={{fontWeight:700,marginBottom:14}}>Measurement Plan</div>
              <img src={`${API_ORIGIN}${geometrySnapshotUrl}`}
                alt="Roof measurement plan" style={{maxWidth:"100%",border:"1px solid #e2e8f0",borderRadius:8}}/>
            </div>
          )}

          {e&&(
            <div style={{...s.card,marginTop:14}}>
              <div style={{fontWeight:700,marginBottom:14}}>Estimate Breakdown</div>
              {[
                ["Adjusted Area",               `${e.adjArea?.toFixed(1)} m²`],
                [`Material (${e.materialLabel})`, formatMoney(e.matCost)],
                ["Flashings",                    formatMoney(e.flashCost)],
                ["Guttering",                    formatMoney(e.gutCost)],
                ["Labour",                       formatMoney(e.labCost)],
                [`Margin (${e.margin}%)`,         formatMoney(e.marginAmt)],
                ...(e.discountAmt>0 ? [["Subtotal before discount", formatMoney(e.sellPrice+e.discountAmt)]] : []),
                ...(e.discountAmt>0 ? [[`Discount (${e.discountType==="fixed" ? cs+e.discountValue : (e.discountValue||0)+"%"})`, `− ${formatMoney(e.discountAmt)}`]] : []),
                ["Subtotal (excl. GST)",         formatMoney(e.sellPrice)],
                [`GST (${((e.gstRate ?? GST_RATE)*100).toFixed(0)}%)`, formatMoney(e.gst)],
              ].map(([l,v])=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #f1f5f9",fontSize:13}}>
                  <span style={{color:"#64748b"}}>{l}</span>
                  <span style={{fontWeight:500}}>{v}</span>
                </div>
              ))}
              <div style={{display:"flex",justifyContent:"space-between",paddingTop:14,alignItems:"center"}}>
                <span style={{fontWeight:700}}>Total inc. GST</span>
                <Money value={formatMoney(e.total)} size={22} color="#f59e0b"/>
              </div>
            </div>
          )}
        </div>

        <div>
          {project.quoteNum ? (
            <div style={{...s.card,marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div style={{fontWeight:700}}>Quote {project.quoteNum}</div>
                <StatusBadge status={project.status}/>
              </div>
              <div style={{fontSize:12,color:"#64748b",lineHeight:2,marginBottom:14}}>
                Issued: {fmtD(project.quoteDate)}<br/>
                Amount: <strong style={{color:"#0f172a"}}>{e?formatMoney(e.total):"—"}</strong>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <Btn full primary onClick={()=>setView("quote_print")}>📄 View Full Quote</Btn>
                <Btn full onClick={()=>setShowEmailModal(true)}>📧 Email to Client</Btn>
                <Btn full onClick={handlePrint}>🖨 Print</Btn>
              </div>
            </div>
          ):(
            <div style={{...s.card,marginBottom:14,border:"2px dashed #e2e8f0",textAlign:"center",padding:24}}>
              <div style={{fontSize:14,color:"#64748b",marginBottom:12}}>No quote generated yet</div>
              <Btn primary onClick={onEdit}>Generate Quote →</Btn>
            </div>
          )}

          <QuoteHistory projectId={project.id}/>

          <div style={{...s.card, marginTop:14}}>
            <div style={{fontWeight:700,marginBottom:14}}>Timeline</div>
            {[
              { label:"Project Created",    date:project.createdAt,                             color:"#94a3b8" },
              { label:"Estimate Completed", date:e?project.createdAt:null,                      color:"#8b5cf6" },
              { label:"Quote Sent",         date:project.quoteDate||null,                       color:"#f59e0b" },
              { label:"Won",                date:project.status==="Won"?project.quoteDate:null, color:"#10b981" },
            ].map(({ label,date,color })=>(
              <div key={label} style={{display:"flex",alignItems:"flex-start",gap:12,marginBottom:12,opacity:date?1:.4}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:color,marginTop:4,flexShrink:0}}/>
                <div>
                  <div style={{fontSize:12,fontWeight:500}}>{label}</div>
                  <div style={{fontSize:11,color:"#64748b"}}>{date?fmtD(date):"Pending"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showEmailModal && (
        <Modal title="Email Quote to Client" onClose={()=>{ setShowEmailModal(false); setCopied(false) }} width={460}>
          <div>
            {cust?.email ? (
              <div style={{marginBottom:16,padding:"10px 14px",background:"#f8fafc",borderRadius:8,fontSize:13,color:"#475569"}}>
                To: <strong style={{color:"#0f172a"}}>{cust.email}</strong>
              </div>
            ) : (
              <div style={{marginBottom:16,padding:"10px 14px",background:"#fef3c7",borderRadius:8,fontSize:12,color:"#92400e"}}>
                ⚠ No email on file. You can still copy the quote and paste it manually.
              </div>
            )}
            <div style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:10,padding:16,marginBottom:12}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:12}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:"#0f172a",color:"#f59e0b",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,flexShrink:0}}>1</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:600,fontSize:13,marginBottom:4}}>Copy the styled quote</div>
                  <div style={{fontSize:12,color:"#64748b",marginBottom:12,lineHeight:1.6}}>
                    Copies the full quote as rich HTML — tables, colours, totals. Paste it directly into Gmail or Outlook and it will look like the printed version.
                  </div>
                  <button
                    onClick={async ()=>{
                      const html = buildEmailHTML()
                      try {
                        await navigator.clipboard.write([
                          new ClipboardItem({
                            "text/html":  new Blob([html], {type:"text/html"}),
                            // ← use formatMoney for currency-aware plain-text summary
                            "text/plain": new Blob([`Quote ${project.quoteNum||""} for ${cust?.name||"client"} — Total: ${project.estimate ? formatMoney(project.estimate.total) : "TBC"}`], {type:"text/plain"})
                          })
                        ])
                        setCopied(true)
                      } catch {
                        const ta = document.createElement("textarea"); ta.value = html
                        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta)
                        setCopied(true)
                      }
                    }}
                    style={{width:"100%",padding:"10px 16px",borderRadius:8,border:"none",background:copied?"#10b981":"#f59e0b",color:copied?"#fff":"#000",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8,transition:"all .2s"}}
                  >
                    {copied ? "✓ Copied! Now open your email app →" : "📋 Copy Styled Quote to Clipboard"}
                  </button>
                </div>
              </div>
            </div>
            <div style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:10,padding:16,marginBottom:12,opacity:copied?1:0.5,transition:"opacity .3s"}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:12}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:copied?"#0f172a":"#e2e8f0",color:copied?"#f59e0b":"#94a3b8",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,flexShrink:0,transition:"all .2s"}}>2</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:600,fontSize:13,marginBottom:4}}>Open your email app & paste</div>
                  <div style={{fontSize:12,color:"#64748b",marginBottom:12,lineHeight:1.6}}>
                    Open a compose window, paste (<strong>Ctrl+V</strong> / <strong>⌘V</strong>) into the body — the full formatted quote will appear.
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {[
                      { id:"gmail",   label:"Gmail",     icon:"https://www.google.com/favicon.ico",  color:"#EA4335" },
                      { id:"outlook", label:"Outlook",   icon:"https://outlook.live.com/favicon.ico", color:"#0078D4" },
                      { id:"yahoo",   label:"Yahoo Mail",icon:"https://www.yahoo.com/favicon.ico",    color:"#6001D2" },
                    ].map(p=>{
                      const to      = encodeURIComponent(cust?.email||"")
                      const subject = encodeURIComponent(`Roofing Quote ${project.quoteNum||""} — ${project.address}`)
                      const urls    = {
                        gmail:   `https://mail.google.com/mail/?view=cm&to=${to}&su=${subject}`,
                        outlook: `https://outlook.live.com/mail/0/deeplink/compose?to=${to}&subject=${subject}`,
                        yahoo:   `https://compose.mail.yahoo.com/?to=${to}&subject=${subject}`,
                      }
                      return (
                        <button key={p.id} onClick={()=>window.open(urls[p.id],"_blank")}
                          style={{flex:1,minWidth:80,display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"8px 12px",border:"1px solid #e2e8f0",borderRadius:8,background:"#fff",cursor:"pointer",fontSize:12,fontWeight:500,color:"#0f172a",fontFamily:"inherit",transition:"all .15s"}}
                          onMouseEnter={e=>{e.currentTarget.style.borderColor=p.color;e.currentTarget.style.background="#f8fafc"}}
                          onMouseLeave={e=>{e.currentTarget.style.borderColor="#e2e8f0";e.currentTarget.style.background="#fff"}}
                        >
                          <img src={p.icon} width={14} height={14} style={{borderRadius:2}} onError={e=>e.target.style.display="none"} alt=""/>
                          {p.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
            <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.6,textAlign:"center"}}>
              💡 Gmail tip: make sure <strong>Rich formatting</strong> is enabled in compose (not plain text mode)
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─────────────────────────── CUSTOMERS ───────────────────────────
function Customers({ customers, setCustomers, projects }) {
  const { formatMoney: fmt } = useCurrency()   // ← currency-aware fmt

  const [search,   setSearch]   = useState("")
  const [editCust, setEditCust] = useState(null)
  const [showNew,  setShowNew]  = useState(false)
  const [saving,   setSaving]   = useState(false)
  const [form,     setForm]     = useState({ name:"", email:"", phone:"", address:"" })

  const filtered = customers.filter(c=>{
    const q=search.toLowerCase()
    return !q || c.name.toLowerCase().includes(q) || (c.email||"").toLowerCase().includes(q) || (c.phone||"").includes(q)
  })

  const upd = k => v => setForm(prev=>({...prev,[k]:v}))

  function openEdit(c){ setForm({name:c.name,email:c.email||"",phone:c.phone||"",address:c.address||""}); setEditCust(c); setShowNew(true) }
  function closeModal(){ setShowNew(false); setEditCust(null); setForm({name:"",email:"",phone:"",address:""}) }

  async function save() {
    if(!form.name.trim()) return
    setSaving(true)
    try {
      if(editCust) {
        const raw     = await customersApi.update(editCust.id, form)
        const updated = normalizeKeys(raw)
        setCustomers(prev=>prev.map(c=>c.id===editCust.id?{...c,...updated}:c))
      } else {
        const raw     = await customersApi.create(form)
        const created = normalizeKeys(raw)
        setCustomers(prev=>[...prev,created])
      }
      closeModal()
    } catch(err) {
      console.error("Failed to save customer:", err)
    } finally {
      setSaving(false)
    }
  }

  async function del(id) {
    if(!window.confirm("Delete this customer? Their projects will remain.")) return
    try {
      await customersApi.delete(id)
      setCustomers(prev=>prev.filter(c=>c.id!==id))
    } catch(err) { console.error("Failed to delete customer:", err) }
  }

  return (
    <div>
      <div style={{display:"flex",gap:12,marginBottom:20,flexWrap:"wrap"}}>
        <input style={{...s.input,width:260}} placeholder="Search customers..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <Btn primary onClick={()=>{ setForm({name:"",email:"",phone:"",address:""}); setEditCust(null); setShowNew(true) }}>+ New Customer</Btn>
      </div>
      <div style={{...s.card,padding:0,overflow:"hidden"}}>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:620}}>
            <thead>
              <tr>{["Name","Email","Phone","Address","Projects","Total Value",""].map(h=><th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {filtered.map(c=>{
                const cProjects = projects.filter(p=>p.customerId===c.id)
                const cVal = cProjects.reduce((a,p)=>a+(p.estimate?.total||0),0)
                return (
                  <tr key={c.id}>
                    <td style={s.td}>
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <div style={{width:32,height:32,borderRadius:"50%",background:"#dbeafe",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:"#1e40af",flexShrink:0}}>
                          {c.name.split(" ").map(w=>w[0]).slice(0,2).join("")}
                        </div>
                        <span style={{fontWeight:500}}>{c.name}</span>
                      </div>
                    </td>
                    <td style={{...s.td,color:"#3b82f6"}}>{c.email||"—"}</td>
                    <td style={s.td}>{c.phone||"—"}</td>
                    <td style={{...s.td,fontSize:12,color:"#64748b",maxWidth:160}}><div style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{c.address||"—"}</div></td>
                    <td style={s.td}>{cProjects.length}</td>
                    <td style={{...s.td,fontWeight:600}}>{cVal>0?fmt(cVal):"—"}</td>
                    <td style={s.td}>
                      <div style={{display:"flex",gap:6}}>
                        <Btn sm onClick={()=>openEdit(c)}>Edit</Btn>
                        <Btn sm danger onClick={()=>del(c.id)}>Delete</Btn>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {filtered.length===0&&<tr><td colSpan={7} style={{...s.td,textAlign:"center",color:"#94a3b8",padding:32}}>No customers found</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {showNew&&(
        <Modal title={editCust?"Edit Customer":"New Customer"} onClose={closeModal}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
            <FG label="Full Name *"><input style={s.input} value={form.name}    onChange={e=>upd("name")(e.target.value)}    placeholder="Sarah Thompson"/></FG>
            <FG label="Phone *">   <input style={s.input} value={form.phone}   onChange={e=>upd("phone")(e.target.value)}   placeholder="021 999 0011"/></FG>
            <FG label="Email">     <input style={s.input} value={form.email}   onChange={e=>upd("email")(e.target.value)}   placeholder="sarah@email.com"/></FG>
            <FG label="Address">   <input style={s.input} value={form.address} onChange={e=>upd("address")(e.target.value)} placeholder="47 Main St, Auckland"/></FG>
          </div>
          <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:20}}>
            <Btn onClick={closeModal}>Cancel</Btn>
            <Btn primary onClick={save} style={{opacity:form.name.trim()?1:.5}}>
              {saving?"Saving…":editCust?"Save Changes":"Create Customer"}
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─────────────────────────── JOB PHOTOS ───────────────────────────
function JobPhotos({ jobId }) {
  const [photos, setPhotos]   = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver]   = useState(false)
  const [error, setError]         = useState("")
  const [lightbox, setLightbox]   = useState(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    jobPhotosApi.getForJob(jobId)
      .then(rows => { if (!cancelled) setPhotos(rows) })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jobId])

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/"))
    if (!files.length) return
    setUploading(true); setError("")
    try {
      const created = await jobPhotosApi.upload(jobId, files)
      setPhotos(prev => [...created, ...prev])
    } catch (err) {
      setError(err.message || "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  async function removePhoto(id) {
    const prev = photos
    setPhotos(p => p.filter(ph => ph.id !== id))
    try { await jobPhotosApi.delete(id) }
    catch (err) { setError(err.message); setPhotos(prev) }
  }


  return (
    <div style={{...s.card, marginTop:14}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{fontWeight:700}}>Photos {photos.length>0 && <span style={{color:"#94a3b8",fontWeight:400}}>({photos.length})</span>}</div>
        {uploading && <span style={{fontSize:11,color:"#f59e0b"}}>Uploading…</span>}
      </div>

      <div
        onClick={()=>fileInputRef.current?.click()}
        onDragOver={e=>{ e.preventDefault(); setDragOver(true) }}
        onDragLeave={()=>setDragOver(false)}
        onDrop={e=>{ e.preventDefault(); setDragOver(false); uploadFiles(e.dataTransfer.files) }}
        style={{
          border: dragOver ? "2px dashed #f59e0b" : "2px dashed #e2e8f0",
          background: dragOver ? "#fef3c7" : "#f8fafc",
          borderRadius:10, padding:"22px 14px", textAlign:"center",
          cursor:"pointer", transition:"all .15s", marginBottom: photos.length ? 14 : 0,
        }}>
        <div style={{fontSize:22,marginBottom:4}}>📷</div>
        <div style={{fontSize:12,fontWeight:600,color:"#0f172a"}}>Drag & drop job photos here</div>
        <div style={{fontSize:11,color:"#64748b",marginTop:2}}>or click to browse — JPG, PNG, WEBP up to 10MB</div>
        <input
          ref={fileInputRef} type="file" accept="image/*" multiple
          style={{display:"none"}}
          onChange={e=>{ uploadFiles(e.target.files); e.target.value="" }}
        />
      </div>

      {error && <div style={{fontSize:12,color:"#991b1b",background:"#fee2e2",borderRadius:8,padding:"8px 12px",marginBottom:10}}>{error}</div>}

      {!loading && photos.length>0 && (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))",gap:8}}>
          {photos.map(ph=>(
            <div key={ph.id} style={{position:"relative",aspectRatio:"1",borderRadius:8,overflow:"hidden",border:"1px solid #e2e8f0"}}>
              <img
                src={`${API_ORIGIN}${ph.url}`} alt="Job"
                onClick={()=>setLightbox(`${API_ORIGIN}${ph.url}`)}
                style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}}
              />
              <button
                onClick={()=>removePhoto(ph.id)}
                title="Remove photo"
                style={{position:"absolute",top:4,right:4,width:20,height:20,borderRadius:"50%",border:"none",background:"rgba(15,23,42,.75)",color:"#fff",fontSize:11,lineHeight:1,cursor:"pointer"}}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {lightbox && (
        <div onClick={()=>setLightbox(null)} style={{position:"fixed",inset:0,background:"rgba(15,23,42,.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,cursor:"zoom-out"}}>
          <img src={lightbox} alt="Job full size" style={{maxWidth:"90vw",maxHeight:"90vh",borderRadius:8}}/>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────── JOBS ───────────────────────────
function Jobs({ jobs, setJobs, customers }) {
  const [search,     setSearch]     = useState("")
  const [editJob,     setEditJob]   = useState(null)
  const [showNew,     setShowNew]   = useState(false)
  const [saving,      setSaving]    = useState(false)
  const [expandedId,  setExpandedId]= useState(null)
  const [form,        setForm]      = useState({ customerId:"", jobNumber:"", notes:"" })

  const custName = id => customers.find(c=>c.id===id)?.name || "—"

  const filtered = jobs.filter(j=>{
    const q = search.toLowerCase()
    return !q || j.jobNumber.toLowerCase().includes(q) || custName(j.customerId).toLowerCase().includes(q)
  })

  const upd = k => v => setForm(prev=>({...prev,[k]:v}))

  function openEdit(j){ setForm({customerId:j.customerId, jobNumber:j.jobNumber, notes:j.notes||""}); setEditJob(j); setShowNew(true) }
  function closeModal(){ setShowNew(false); setEditJob(null); setForm({customerId:"",jobNumber:"",notes:""}) }

  async function save() {
    if(!form.customerId || !form.jobNumber.trim()) return
    setSaving(true)
    try {
      if(editJob) {
        const updated = await jobsApi.update(editJob.id, form)
        setJobs(prev=>prev.map(j=>j.id===editJob.id?updated:j))
      } else {
        const created = await jobsApi.create(form)
        setJobs(prev=>[created, ...prev])
      }
      closeModal()
    } catch(err) {
      console.error("Failed to save job:", err)
    } finally {
      setSaving(false)
    }
  }

  async function del(id) {
    if(!window.confirm("Delete this job? Its photos will be removed too.")) return
    try {
      await jobsApi.delete(id)
      setJobs(prev=>prev.filter(j=>j.id!==id))
      if(expandedId===id) setExpandedId(null)
    } catch(err) { console.error("Failed to delete job:", err) }
  }

  return (
    <div>
      <div style={{display:"flex",gap:12,marginBottom:20,flexWrap:"wrap"}}>
        <input style={{...s.input,width:260}} placeholder="Search jobs..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <Btn primary onClick={()=>{ setForm({customerId:"",jobNumber:"",notes:""}); setEditJob(null); setShowNew(true) }}>+ New Job</Btn>
      </div>
      <div style={{...s.card,padding:0,overflow:"hidden"}}>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:560}}>
            <thead>
              <tr>{["Customer","Job Number","Notes","Created",""].map(h=><th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {filtered.map(j=>(
                <Fragment key={j.id}>
                  <tr>
                    <td style={s.td}><span style={{fontWeight:500}}>{custName(j.customerId)}</span></td>
                    <td style={{...s.td,fontWeight:600}}>{j.jobNumber}</td>
                    <td style={{...s.td,fontSize:12,color:"#64748b",maxWidth:200}}><div style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{j.notes||"—"}</div></td>
                    <td style={{...s.td,fontSize:12,color:"#64748b"}}>{j.createdAt ? new Date(j.createdAt).toLocaleDateString() : "—"}</td>
                    <td style={s.td} onClick={e=>e.stopPropagation()}>
                      <div style={{display:"flex",gap:6}}>
                        <Btn sm primary={expandedId===j.id} onClick={()=>setExpandedId(prev=>prev===j.id?null:j.id)}>
                          📷 Photos
                        </Btn>
                        <Btn sm onClick={()=>openEdit(j)}>Edit</Btn>
                        <Btn sm danger onClick={()=>del(j.id)}>Delete</Btn>
                      </div>
                    </td>
                  </tr>
                  {expandedId===j.id && (
                    <tr key={`${j.id}-photos`}>
                      <td colSpan={5} style={{...s.td,background:"#f8fafc"}}>
                        <JobPhotos jobId={j.id}/>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {filtered.length===0&&<tr><td colSpan={5} style={{...s.td,textAlign:"center",color:"#94a3b8",padding:32}}>No jobs found</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {showNew&&(
        <Modal title={editJob?"Edit Job":"New Job"} onClose={closeModal}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
            <FG label="Customer *">
              <select style={s.input} value={form.customerId} onChange={e=>upd("customerId")(e.target.value)} disabled={!!editJob}>
                <option value="">— Choose customer —</option>
                {customers.map(c=><option key={c.id} value={c.id}>{c.name} · {c.phone}</option>)}
              </select>
            </FG>
            <FG label="Job Number *"><input style={s.input} value={form.jobNumber} onChange={e=>upd("jobNumber")(e.target.value)} placeholder="JOB-1023"/></FG>
          </div>
          <FG label="Notes"><textarea style={{...s.input,resize:"vertical"}} rows={3} value={form.notes} onChange={e=>upd("notes")(e.target.value)} placeholder="Optional notes about this job..."/></FG>
          <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:20}}>
            <Btn onClick={closeModal}>Cancel</Btn>
            <Btn primary onClick={save} style={{opacity:(form.customerId&&form.jobNumber.trim())?1:.5}}>
              {saving?"Saving…":editJob?"Save Changes":"Create Job"}
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─────────────────────────── USERS ───────────────────────────
function Users({ currentUser }) {
  const [users,      setUsers]      = useState([])
  const [org,        setOrg]        = useState(null) // { seatLimit, activeUserCount, planKey, status }
  const [loading,    setLoading]    = useState(true)
  const [showModal,  setShowModal]  = useState(false)
  const [editUser,   setEditUser]   = useState(null)
  const [saving,     setSaving]     = useState(false)
  const [togglingId, setTogglingId] = useState(null)
  const [form,       setForm]       = useState({ name:"", email:"", password:"" })
  const [formErr,    setFormErr]    = useState("")

  // ← Only owner/admin manage the team — a plain "member" sees the roster
  //   read-only, matching the roles Phase 1/2 introduced on the backend.
  //   Looked up from the freshly-fetched roster (`users`), not
  //   currentUser.role — that's a claim baked into the login token at sign-in
  //   time, so it goes stale the moment a role changes server-side (e.g. an
  //   owner promotes someone) until that person logs out and back in. The
  //   roster is fetched fresh on every visit to this page, so using it here
  //   makes a role change take effect immediately instead of silently
  //   hiding the controls until a re-login.
  const me = users.find(u => u.id === currentUser?.id)
  const canManage = me?.role === "owner" || me?.role === "admin"

  useEffect(()=>{ loadUsers(); loadOrg() },[])

  async function loadUsers() {
    setLoading(true)
    try {
      const raw = await usersApi.getAll()
      setUsers(raw.map(normalizeKeys))
    } catch(err) { console.error("Failed to load users:", err) }
    finally      { setLoading(false) }
  }

  async function loadOrg() {
    try { setOrg(await organizationApi.get()) }
    catch(err) { console.error("Failed to load organization:", err) }
  }

  const atSeatLimit = org && org.activeUserCount >= org.seatLimit

  function openNew()  { setForm({name:"",email:"",password:""}); setFormErr(""); setEditUser(null); setShowModal(true) }
  function openEdit(u){ setForm({name:u.name,email:u.email,password:""}); setFormErr(""); setEditUser(u); setShowModal(true) }
  function closeModal(){ setShowModal(false); setEditUser(null); setFormErr("") }

  // Both invite and reactivate can come back with this — same 403 shape,
  // same message, since the backend enforces the identical seat check for
  // either action.
  function seatLimitMessage(err) {
    if (err?.body?.error === "seat_limit_exceeded") {
      return `Seat limit reached (${err.body.currentCount}/${err.body.seatLimit}). Upgrade your plan to add more people.`
    }
    return null
  }

  async function save() {
    if (!form.name.trim() || !form.email.trim()) { setFormErr("Name and email are required."); return }
    if (!editUser && !form.password.trim())       { setFormErr("Password is required for new users."); return }
    setSaving(true); setFormErr("")
    try {
      if (editUser) {
        const raw = await usersApi.update(editUser.id, form)
        setUsers(prev => prev.map(u => u.id===editUser.id ? normalizeKeys(raw) : u))
      } else {
        const raw = await usersApi.create(form)
        setUsers(prev => [...prev, normalizeKeys(raw)])
        loadOrg()
      }
      closeModal()
    } catch(err) { setFormErr(seatLimitMessage(err) || err.message || "Save failed.") }
    finally      { setSaving(false) }
  }

  async function toggleActive(u) {
    if (u.id === currentUser?.id) return
    setTogglingId(u.id)
    try {
      const raw = await usersApi.setActive(u.id, !u.isActive)
      setUsers(prev => prev.map(x => x.id===u.id ? normalizeKeys(raw) : x))
      loadOrg()
    } catch(err) {
      const msg = seatLimitMessage(err)
      if (msg) alert(msg) // reactivation blocked by the seat limit — no inline form to show this in
      console.error("Toggle failed:", err)
    }
    finally      { setTogglingId(null) }
  }

  const upd = k => e => setForm(prev=>({...prev,[k]:e.target.value}))

  return (
    <div style={{width:"100%"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div>
          {org && <div style={{fontSize:11,color:"#94a3b8",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.03em",marginBottom:2}}>{org.name}</div>}
          <div style={{fontSize:13,color:"#64748b"}}>Manage who has access to aTopRoof CRM.</div>
          {org && (
            <div style={{fontSize:12,color:atSeatLimit?"#b91c1c":"#94a3b8",marginTop:4,fontWeight:atSeatLimit?600:400}}>
              {org.activeUserCount} / {org.seatLimit} seats used
              {atSeatLimit && " — upgrade your plan to add more people"}
            </div>
          )}
        </div>
        {canManage && (
          <Btn primary onClick={()=>{ if(!atSeatLimit) openNew() }} style={{opacity:atSeatLimit?0.5:1,cursor:atSeatLimit?"not-allowed":"pointer"}}>
            + Add User
          </Btn>
        )}
      </div>

      <div style={{...s.card,padding:0,overflow:"hidden"}}>
        {loading ? (
          <div style={{padding:40,textAlign:"center",color:"#94a3b8",fontSize:13}}>Loading users…</div>
        ) : (
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",minWidth:560}}>
              <thead>
                <tr>{["User","Email","Role","Status","Joined",canManage?"":null].filter(h=>h!==null).map(h=><th key={h} style={s.th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {users.map(u => {
                  const isMe   = u.id === currentUser?.id
                  const active = u.isActive !== false
                  return (
                    <tr key={u.id}>
                      <td style={s.td}>
                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                          <div style={{width:34,height:34,borderRadius:"50%",flexShrink:0,background:active?"linear-gradient(135deg,#f59e0b,#f97316)":"#e2e8f0",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:active?"#000":"#94a3b8"}}>
                            {u.name?.split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase()}
                          </div>
                          <div>
                            <div style={{fontWeight:600,fontSize:13}}>
                              {u.name}
                              {isMe && <span style={{marginLeft:6,fontSize:10,background:"#dbeafe",color:"#1e40af",padding:"1px 7px",borderRadius:10,fontWeight:600}}>You</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={{...s.td,color:"#3b82f6",fontSize:12}}>{u.email}</td>
                      <td style={{...s.td,fontSize:12,color:"#64748b",textTransform:"capitalize"}}>{u.role || "member"}</td>
                      <td style={s.td}>
                        <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:600,background:active?"#d1fae5":"#fee2e2",color:active?"#065f46":"#991b1b"}}>
                          <span style={{width:6,height:6,borderRadius:"50%",background:active?"#10b981":"#ef4444"}}/>
                          {active ? "Active" : "Disabled"}
                        </span>
                      </td>
                      <td style={{...s.td,fontSize:12,color:"#64748b"}}>{fmtD(u.createdAt)}</td>
                      {canManage && (
                        <td style={s.td}>
                          <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                            <Btn sm onClick={()=>openEdit(u)}>Edit</Btn>
                            {!isMe && (
                              <button onClick={()=>toggleActive(u)} disabled={togglingId===u.id}
                                style={{padding:"6px 12px",borderRadius:8,fontSize:12,fontWeight:500,cursor:togglingId===u.id?"not-allowed":"pointer",border:"1px solid",fontFamily:"inherit",transition:"all .15s",opacity:togglingId===u.id?0.6:1,background:active?"#fee2e2":"#d1fae5",color:active?"#b91c1c":"#065f46",borderColor:active?"#fca5a5":"#6ee7b7"}}>
                                {togglingId===u.id ? "…" : active ? "Disable" : "Enable"}
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  )
                })}
                {users.length===0&&<tr><td colSpan={canManage?6:5} style={{...s.td,textAlign:"center",color:"#94a3b8",padding:32}}>No users found</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{...s.card,marginTop:14,background:"#fffbeb",border:"1px solid #fde68a"}}>
        <div style={{fontSize:12,color:"#92400e",lineHeight:1.8}}>
          <strong>Note:</strong> You cannot disable your own account. Disabled users cannot log in but their data is preserved. Password changes take effect on next login.
        </div>
      </div>

      {showModal && (
        <Modal title={editUser ? "Edit User" : "Add New User"} onClose={closeModal} width={440}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
            <FG label="Full Name *"><input style={s.input} value={form.name}  onChange={upd("name")}  placeholder="Jane Smith"/></FG>
            <FG label="Email *">    <input style={s.input} type="email" value={form.email} onChange={upd("email")} placeholder="jane@company.com"/></FG>
          </div>
          <FG label={editUser ? "New Password (leave blank to keep current)" : "Password *"}>
            <input style={s.input} type="password" value={form.password} onChange={upd("password")} placeholder={editUser?"••••••••  (unchanged)":"Min 6 characters"}/>
          </FG>
          {formErr && (
            <div style={{background:"#fee2e2",border:"1px solid #fca5a5",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#b91c1c",marginBottom:4}}>{formErr}</div>
          )}
          <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:20}}>
            <Btn onClick={closeModal}>Cancel</Btn>
            <Btn primary onClick={save} style={{opacity:saving?0.6:1}}>
              {saving ? "Saving…" : editUser ? "Save Changes" : "Create User"}
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─────────────────────────── MY PROFILE ───────────────────────────
// Self-service name/email/password — available to every user regardless of
// role, unlike the Team page's Edit button (owner/admin, for editing OTHER
// people). Backend enforces this same self-vs-others distinction
// independently (backend/routes/users.js) — this UI isn't the only guard.
function MyProfileModal({ user, onClose, onSaved }) {
  const [form,    setForm]    = useState({ name: user?.name||"", email: user?.email||"", password: "" })
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState("")
  const [saved,   setSaved]   = useState(false)

  const upd = k => e => setForm(prev=>({...prev,[k]:e.target.value}))

  async function save() {
    if (!form.name.trim() || !form.email.trim()) { setError("Name and email are required."); return }
    setSaving(true); setError("")
    try {
      const raw = await usersApi.update(user.id, form)
      const updated = normalizeKeys(raw)
      onSaved({ name: updated.name, email: updated.email })
      setSaved(true)
      setForm(prev=>({...prev, password:""}))
      setTimeout(()=>setSaved(false), 2000)
    } catch(err) { setError(err.message || "Save failed.") }
    finally      { setSaving(false) }
  }

  return (
    <Modal title="My Profile" onClose={onClose} width={440}>
      <div style={{fontSize:12,color:"#94a3b8",marginBottom:16}}>
        Update your own name, email, or password. Role and organization membership are managed by your workspace owner.
      </div>
      <FG label="Full Name *"><input style={s.input} value={form.name}  onChange={upd("name")}/></FG>
      <FG label="Email *">    <input style={s.input} type="email" value={form.email} onChange={upd("email")}/></FG>
      <FG label="New Password (leave blank to keep current)">
        <input style={s.input} type="password" value={form.password} onChange={upd("password")} placeholder="Min 6 characters"/>
      </FG>
      {error && (
        <div style={{background:"#fee2e2",border:"1px solid #fca5a5",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#b91c1c",marginBottom:4}}>{error}</div>
      )}
      <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:20,alignItems:"center"}}>
        {saved && <span style={{fontSize:13,color:"#10b981"}}>✓ Saved</span>}
        <Btn onClick={onClose}>Close</Btn>
        <Btn primary onClick={save} style={{opacity:saving?0.6:1}}>{saving ? "Saving…" : "Save Changes"}</Btn>
      </div>
    </Modal>
  )
}

// ─────────────────────────── SETTINGS ───────────────────────────
function Settings({ settings, onSave }) {
  const { currency, regions, region, updateRegion } = useCurrency()
  const cs = currency?.symbol || "$"
  const [form,  setForm]  = useState(settings)
  const [saved, setSaved] = useState(false)
  const [uploadingLogo,   setUploadingLogo]   = useState(false)
  const [uploadingBadges, setUploadingBadges] = useState(false)
  const [uploadError,     setUploadError]     = useState("")

  const upd    = k => e => setForm(prev=>({...prev,[k]:e.target.value}))
  const updNum = k => e => setForm(prev=>({...prev,[k]:parseFloat(e.target.value)||0}))

  function save() {
    onSave(form)
    setSaved(true)
    setTimeout(()=>setSaved(false), 2500)
  }

  async function uploadImage(kind, file) {
    if (!file) return
    const setUploading = kind==="logo" ? setUploadingLogo : setUploadingBadges
    const urlKey = kind==="logo" ? "logoUrl" : "badgesUrl"
    setUploading(true); setUploadError("")
    try {
      const result = kind==="logo"
        ? await companyProfileApi.uploadLogo(file)
        : await companyProfileApi.uploadBadges(file)
      setForm(prev=>({...prev, [urlKey]: result[urlKey]}))
      onSave({ [urlKey]: result[urlKey] })
    } catch (err) {
      setUploadError(err.message || "Upload failed")
    } finally {
      setUploading(false)
    }
  }


  return (
    <div style={{maxWidth:600}}>
      <div style={{...s.card,marginBottom:16}}>
        <div style={{fontWeight:700,marginBottom:4}}>Quotation Branding</div>
        <div style={{fontSize:12,color:"#94a3b8",marginBottom:16}}>This is your own branding — every quote you generate uses these, separately from other users' accounts.</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}} className="grid2-responsive">
          <div>
            <label style={s.label}>Company Logo</label>
            <div style={{border:"1px dashed #e2e8f0",borderRadius:8,padding:12,textAlign:"center",background:"#f8fafc"}}>
              {form.logoUrl
                ? <img src={`${API_ORIGIN}${form.logoUrl}`} alt="Logo" style={{maxHeight:60,maxWidth:"100%",objectFit:"contain",marginBottom:8}}/>
                : <div style={{fontSize:11,color:"#94a3b8",marginBottom:8}}>No logo uploaded</div>}
              <input type="file" accept="image/*" id="logo-upload" style={{display:"none"}}
                onChange={e=>{ uploadImage("logo", e.target.files[0]); e.target.value="" }}/>
              <Btn sm onClick={()=>document.getElementById("logo-upload").click()}>
                {uploadingLogo ? "Uploading…" : form.logoUrl ? "Replace Logo" : "Upload Logo"}
              </Btn>
            </div>
          </div>
          <div>
            <label style={s.label}>Accreditation / Badges Strip</label>
            <div style={{border:"1px dashed #e2e8f0",borderRadius:8,padding:12,textAlign:"center",background:"#f8fafc"}}>
              {form.badgesUrl
                ? <img src={`${API_ORIGIN}${form.badgesUrl}`} alt="Badges" style={{maxHeight:60,maxWidth:"100%",objectFit:"contain",marginBottom:8}}/>
                : <div style={{fontSize:11,color:"#94a3b8",marginBottom:8}}>Optional — e.g. LBP, industry association, awards</div>}
              <input type="file" accept="image/*" id="badges-upload" style={{display:"none"}}
                onChange={e=>{ uploadImage("badges", e.target.files[0]); e.target.value="" }}/>
              <Btn sm onClick={()=>document.getElementById("badges-upload").click()}>
                {uploadingBadges ? "Uploading…" : form.badgesUrl ? "Replace Badges" : "Upload Badges"}
              </Btn>
            </div>
          </div>
        </div>
        {uploadError && <div style={{marginTop:10,fontSize:12,color:"#991b1b",background:"#fee2e2",borderRadius:8,padding:"8px 12px"}}>{uploadError}</div>}
        <div style={{height:1,background:"#f1f5f9",margin:"16px 0"}}/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
          <FG label="Estimator Name"><input style={s.input} value={form.estimatorName}  onChange={upd("estimatorName")} placeholder="Jimson Betonio"/></FG>
          <FG label="Estimator Title"><input style={s.input} value={form.estimatorTitle} onChange={upd("estimatorTitle")} placeholder="Estimator"/></FG>
        </div>
        <div style={{fontSize:11,color:"#94a3b8"}}>Printed as the sign-off block at the bottom of every quote (e.g. "Ngā mihi, / {form.estimatorName||"Your Name"} / {form.estimatorTitle||"Title"} / {form.companyName}").</div>
      </div>
      <div style={{...s.card,marginBottom:16}}>
        <div style={{fontWeight:700,marginBottom:16}}>Company Profile</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
          <FG label="Company Name">  <input style={s.input} value={form.companyName}    onChange={upd("companyName")}/></FG>
          <FG label="GST Number">    <input style={s.input} value={form.companyGst}     onChange={upd("companyGst")}/></FG>
          <FG label="Phone">         <input style={s.input} value={form.companyPhone}   onChange={upd("companyPhone")}/></FG>
          <FG label="Email">         <input style={s.input} value={form.companyEmail}   onChange={upd("companyEmail")}/></FG>
          <FG label="Address">       <input style={s.input} value={form.companyAddress} onChange={upd("companyAddress")}/></FG>
          <FG label="Bank Account">  <input style={s.input} value={form.companyBank}    onChange={upd("companyBank")}/></FG>
        </div>
      </div>
      <div style={{...s.card,marginBottom:16}}>
        <div style={{fontWeight:700,marginBottom:16}}>Default Pricing</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
          <FG label={`Default Day Rate (${cs})`}><input style={s.input} type="number" value={form.dayRate}  onChange={updNum("dayRate")}/></FG>
          <FG label="Default Margin %">   <input style={s.input} type="number" value={form.margin}   onChange={updNum("margin")}/></FG>
          <FG label="Business Region (currency + GST/VAT)">
            <select style={s.input} value={region?.countryCode || ""} onChange={e=>updateRegion(e.target.value)}>
              {regions.map(r=>(
                <option key={r.countryCode} value={r.countryCode}>{r.countryName} — {r.currencyCode} — GST {(r.gstRate*100).toFixed(0)}%</option>
              ))}
            </select>
          </FG>
          <FG label="Default Wastage %">  <input style={s.input} type="number" value={form.wastage}  onChange={updNum("wastage")}/></FG>
          <FG label="Downpipe Stock Lengths (m, comma-separated)">
            <input style={s.input} value={form.downpipeStockLengths} onChange={upd("downpipeStockLengths")} placeholder="1.8,2.4"/>
          </FG>
          <FG label={`Downpipe Bend/Elbow Rate (${cs} each)`}>
            <input style={s.input} type="number" value={form.downpipeBendRate} onChange={updNum("downpipeBendRate")}/>
          </FG>
          <FG label={`Downpipe Spreader Rate (${cs})`}>
            <input style={s.input} type="number" value={form.spreaderRate} onChange={updNum("spreaderRate")}/>
          </FG>
        </div>
      </div>
      <div style={{...s.card,marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
          <div style={{fontWeight:700}}>General Customer Discount</div>
          <div onClick={()=>setForm(prev=>({...prev,discountEnabled:!prev.discountEnabled}))}
            style={{width:38,height:21,borderRadius:10,background:form.discountEnabled?"#10b981":"#cbd5e1",cursor:"pointer",position:"relative",transition:"all .2s",flexShrink:0}}>
            <div style={{position:"absolute",top:2.5,left:form.discountEnabled?17:2.5,width:16,height:16,borderRadius:"50%",background:"#fff",transition:"all .2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/>
          </div>
        </div>
        <div style={{fontSize:12,color:"#94a3b8",marginBottom:16}}>Applied automatically to every new quote's subtotal, like a running promo — turn it on/off anytime. Each project can still change or turn off its own amount individually.</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
          <FG label="Discount Type">
            <select style={s.input} value={form.discountType} onChange={upd("discountType")}>
              <option value="percent">Percentage (%)</option>
              <option value="fixed">Fixed amount ({cs})</option>
            </select>
          </FG>
          <FG label={form.discountType==="fixed" ? `Discount Amount (${cs})` : "Discount Percentage (%)"}>
            <input style={s.input} type="number" value={form.discountValue} onChange={updNum("discountValue")}/>
          </FG>
        </div>
      </div>
      <div style={{...s.card,marginBottom:16}}>
        <div style={{fontWeight:700,marginBottom:14}}>Accessory Rates</div>
        {[
          ["Flashings",    `${cs}${RATES.flashings}/m`],
          ["Guttering",    `${cs}${RATES.guttering}/m`],
          ["Downpipes",    `${cs}${RATES.downpipe}/each`],
          ["Drains",       `${cs}${RATES.drain}/each`],
          ["Penetrations", `${cs}${RATES.penetration}/each`],
          ["Underlayment", `${cs}${RATES.underlayment}/m²`],
        ].map(([l,v])=>(
          <div key={l} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid #f1f5f9",fontSize:13}}>
            <span>{l}</span><span style={{fontWeight:500,color:"#64748b"}}>{v}</span>
          </div>
        ))}
        <div style={{fontSize:11,color:"#94a3b8",marginTop:10}}>Accessory rates are set globally in the application constants.</div>
      </div>
      <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
        {saved && <span style={{fontSize:13,color:"#10b981",alignSelf:"center"}}>✓ Saved</span>}
        <Btn primary onClick={save}>Save Changes</Btn>
      </div>
    </div>
  )
}

// ─────────────────────────── JOB COMPLEXITY SETTINGS ───────────────────────
// Was a hardcoded COMPLEXITY_LEVELS constant — now a global, editable list
// (same for every user quoting, not per-user like company profile) stored
// via complexityLevelsApi, backed by the app_settings key/value table.
function JobComplexitySettings() {
  const [levels, setLevels] = useState(null) // null = still loading
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [error,  setError]  = useState("")

  useEffect(()=>{ complexityLevelsApi.getAll().then(setLevels).catch(()=>setLevels([])) },[])

  const updateField = (i,field) => e => setLevels(prev=>prev.map((l,li)=>li===i?{...l,[field]:e.target.value}:l))

  function addLevel() {
    setLevels(prev=>[...prev, { key:`level_${uid()}`, label:"New Level", factor:1, desc:"" }])
  }
  function removeLevel(i) {
    setLevels(prev=>prev.filter((_,li)=>li!==i))
  }

  async function save() {
    setError(""); setSaving(true)
    try {
      const cleaned = levels.map(l=>({ ...l, factor:parseFloat(l.factor)||1 }))
      const result = await complexityLevelsApi.save(cleaned)
      setLevels(result)
      setSaved(true); setTimeout(()=>setSaved(false), 2500)
    } catch(err) {
      setError(err.message || "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  if(levels===null) return <div style={{color:"#64748b",padding:20}}>Loading…</div>

  return (
    <div style={{maxWidth:700}}>
      <div style={{...s.card,marginBottom:16}}>
        <div style={{fontWeight:700,marginBottom:4}}>Job Complexity Multipliers</div>
        <div style={{fontSize:12,color:"#94a3b8",marginBottom:16}}>
          These are the labour-cost multipliers offered on every estimate's "Job Complexity"
          selector — global, not per-user. Changing a factor here applies to any estimate
          still being worked on using that level; quotes already sent aren't retroactively changed.
        </div>
        {levels.map((l,i)=>(
          <div key={l.key} style={{border:"1px solid #e2e8f0",borderRadius:8,padding:12,marginBottom:10}}>
            <div style={{display:"grid",gridTemplateColumns:"1.3fr 0.7fr auto",gap:10,marginBottom:8,alignItems:"end"}} className="grid2-responsive">
              <FG label="Label"><input style={s.input} value={l.label} onChange={updateField(i,"label")}/></FG>
              <FG label="Multiplier (×)"><input style={s.input} type="number" step="0.01" min="0.1" value={l.factor} onChange={updateField(i,"factor")}/></FG>
              <Btn danger sm onClick={()=>removeLevel(i)}>Remove</Btn>
            </div>
            <FG label="Description (shown as a tooltip on the estimate)">
              <input style={s.input} value={l.desc||""} onChange={updateField(i,"desc")}/>
            </FG>
            <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>Key: {l.key} (fixed once created — existing estimates reference it)</div>
          </div>
        ))}
        <Btn onClick={addLevel}>+ Add Level</Btn>
      </div>
      {error && <div style={{marginBottom:12,fontSize:12,color:"#991b1b",background:"#fee2e2",borderRadius:8,padding:"8px 12px"}}>{error}</div>}
      <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
        {saved && <span style={{fontSize:13,color:"#10b981",alignSelf:"center"}}>✓ Saved</span>}
        <Btn primary onClick={save}>{saving?"Saving…":"Save Changes"}</Btn>
      </div>
    </div>
  )
}

// ─────────────────────────── BILLING & PLAN ───────────────────────────
// Mirrors backend/config/plans.js — display labels only, kept in sync
// manually (same pattern as src/SignupPage.jsx's PLAN_OPTIONS).
const PLAN_LABELS = { starter: "Starter", pro: "Pro", legacy: "Legacy Workspace", manual: "Manually Provisioned" }

const ORG_STATUS_STYLE = {
  trialing: { bg:"#dbeafe", color:"#1e40af", label:"Trialing" },
  active:   { bg:"#d1fae5", color:"#065f46", label:"Active" },
  past_due: { bg:"#fee2e2", color:"#991b1b", label:"Payment issue" },
  canceled: { bg:"#f1f5f9", color:"#475569", label:"Canceled" },
}

// Small brand badges for the payment methods list — approximations of the
// Visa/Mastercard marks (no icon library in this project), falling back to
// a plain uppercase label for any other card brand Stripe returns.
function CardBrandBadge({ brand }) {
  const b = (brand || "").toLowerCase()
  const box = {width:56,height:36,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}
  if (b === "visa") {
    return <div style={{...box,background:"#dbeafe"}}><span style={{fontStyle:"italic",fontWeight:800,fontSize:14,color:"#1d4ed8",letterSpacing:0.5}}>VISA</span></div>
  }
  if (b === "mastercard") {
    return (
      <div style={{...box,background:"#fee2e2",gap:0}}>
        <div style={{width:18,height:18,borderRadius:"50%",background:"#eb001b"}} />
        <div style={{width:18,height:18,borderRadius:"50%",background:"#f79e1b",marginLeft:-8,opacity:0.9}} />
      </div>
    )
  }
  return <div style={{...box,background:"#f1f5f9"}}><span style={{fontWeight:700,fontSize:10,color:"#475569",textTransform:"uppercase"}}>{b || "card"}</span></div>
}

// Cached across modal opens so we don't re-run loadStripe() (and its
// script injection) every time — Stripe's own guidance is to call it once
// per publishable key, not per component mount.
let _stripePromise = null
function getStripePromise(publishableKey) {
  if (!_stripePromise) _stripePromise = loadStripe(publishableKey)
  return _stripePromise
}

const STRIPE_ELEMENT_STYLE = {
  base: { fontSize: "14px", fontFamily: "inherit", color: "#0f172a", "::placeholder": { color: "#94a3b8" } },
}
// Shared wrapper so a Stripe Element (an iframe) sits inside a box that
// looks like every other text input in this app (s.input's border/radius/
// padding), since the element itself can't take those styles directly.
const stripeElementBoxStyle = { ...s.input, display: "flex", alignItems: "center" }

// The actual card form — must render inside <Elements> so useStripe()/
// useElements() below can see the Stripe instance and the mounted
// CardNumberElement/CardExpiryElement/CardCvcElement. Card number, expiry,
// and CVV are entered directly into Stripe-hosted iframes; none of that
// ever reaches our backend — only the resulting PaymentMethod id does.
function AddCardForm({ clientSecret, onClose, onAdded }) {
  const stripe   = useStripe()
  const elements = useElements()
  const [brand,      setBrand]      = useState("unknown")
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState("")

  async function handleSubmit(ev) {
    ev.preventDefault()
    if (!stripe || !elements || submitting) return
    setSubmitting(true); setError("")
    try {
      const { error: stripeError, setupIntent } = await stripe.confirmCardSetup(clientSecret, {
        payment_method: { card: elements.getElement(CardNumberElement) },
      })
      if (stripeError) { setError(stripeError.message); setSubmitting(false); return }
      await onAdded(setupIntent.payment_method)
    } catch (err) {
      setError(err.message || "Couldn't save card")
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={{display:"flex",alignItems:"flex-end",gap:12,marginBottom:14}}>
        <CardBrandBadge brand={brand==="unknown"?"":brand} />
        <div style={{flex:1}}>
          <div style={s.label}>Card Number</div>
          <div style={stripeElementBoxStyle}>
            <CardNumberElement
              options={{ style: STRIPE_ELEMENT_STYLE, showIcon: true }}
              onChange={ev=>setBrand(ev.brand || "unknown")}
            />
          </div>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
        <div>
          <div style={s.label}>Expiry Date</div>
          <div style={stripeElementBoxStyle}><CardExpiryElement options={{ style: STRIPE_ELEMENT_STYLE }} /></div>
        </div>
        <div>
          <div style={s.label}>CVV</div>
          <div style={stripeElementBoxStyle}><CardCvcElement options={{ style: STRIPE_ELEMENT_STYLE }} /></div>
        </div>
      </div>
      {error && <div style={{marginBottom:14,fontSize:12,color:"#991b1b",background:"#fee2e2",borderRadius:8,padding:"8px 12px"}}>{error}</div>}
      <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
        <Btn type="button" onClick={onClose}>Cancel</Btn>
        <Btn primary type="submit" style={{opacity:(!stripe||submitting)?0.6:1}}>{submitting ? "Saving…" : "Save Card"}</Btn>
      </div>
    </form>
  )
}

// Simple leading-digit brand detection (same ranges Stripe itself uses) —
// only for showing the right badge/label in the dummy form. Never a
// substitute for real validation (Luhn check, issuer lookup), since no
// real charge or storage of the actual number happens here anyway.
function detectCardBrand(digits) {
  if (/^4/.test(digits)) return "visa"
  if (/^5[1-5]/.test(digits) || /^2(2[2-9]|[3-6]\d|7[01]|720)/.test(digits)) return "mastercard"
  if (/^3[47]/.test(digits)) return "amex"
  if (/^6(?:011|5)/.test(digits)) return "discover"
  return "unknown"
}

// Placeholder card form used only while Stripe isn't configured yet (no
// STRIPE_SECRET_KEY/STRIPE_PUBLISHABLE_KEY in the backend's .env) — lets
// the Billing & Plan UI be built/tested end-to-end before real Stripe keys
// exist. Same fields as the real Stripe Elements form (card number,
// expiry, CVV), but plain inputs instead of Stripe's iframes. The CVV is
// validated for shape only and never sent anywhere — only brand/last4/
// expiry (never the full number) reach the backend, same rule as the real
// flow, so this placeholder can't turn into an accidental card-data leak
// once someone pastes a real card into it during testing.
function DummyCardForm({ onClose, onAdded }) {
  const [cardNumber, setCardNumber] = useState("")
  const [expiry,      setExpiry]     = useState("")
  const [cvv,          setCvv]       = useState("")
  const [submitting,  setSubmitting] = useState(false)
  const [error,        setError]     = useState("")

  const digits = cardNumber.replace(/\D/g, "")
  const brand  = digits.length >= 2 ? detectCardBrand(digits) : "unknown"

  async function handleSubmit(ev) {
    ev.preventDefault()
    if (digits.length < 12 || digits.length > 19) { setError("Enter a valid card number."); return }
    const [mm, yy] = expiry.split("/").map(s=>s?.trim())
    const month = parseInt(mm, 10)
    let year = parseInt(yy, 10)
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
      setError("Enter a valid expiry date (MM/YY)."); return
    }
    if (year < 100) year += 2000
    if (!/^\d{3,4}$/.test(cvv)) { setError("Enter a valid CVV."); return }

    setSubmitting(true); setError("")
    try {
      const { id } = await billingApi.createDummyPaymentMethod({
        brand, last4: digits.slice(-4), expMonth: month, expYear: year,
      })
      await onAdded(id)
    } catch (err) {
      setError(err.message || "Couldn't save card")
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={{fontSize:11,color:"#92400e",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,padding:"8px 12px",marginBottom:14,lineHeight:1.5}}>
        Test mode — Stripe isn't connected yet. This card isn't real and won't be charged; only its brand, last 4 digits, and expiry are saved.
      </div>
      <div style={{display:"flex",alignItems:"flex-end",gap:12,marginBottom:14}}>
        <CardBrandBadge brand={brand==="unknown"?"":brand} />
        <div style={{flex:1}}>
          <div style={s.label}>Card Number</div>
          <input style={s.input} inputMode="numeric" placeholder="4242 4242 4242 4242"
            value={cardNumber} onChange={e=>setCardNumber(e.target.value)} maxLength={23}/>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
        <div>
          <div style={s.label}>Expiry Date</div>
          <input style={s.input} placeholder="MM/YY" value={expiry} onChange={e=>setExpiry(e.target.value)} maxLength={7}/>
        </div>
        <div>
          <div style={s.label}>CVV</div>
          <input style={s.input} inputMode="numeric" placeholder="123" value={cvv} onChange={e=>setCvv(e.target.value)} maxLength={4}/>
        </div>
      </div>
      {error && <div style={{marginBottom:14,fontSize:12,color:"#991b1b",background:"#fee2e2",borderRadius:8,padding:"8px 12px"}}>{error}</div>}
      <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
        <Btn type="button" onClick={onClose}>Cancel</Btn>
        <Btn primary type="submit" style={{opacity:submitting?0.6:1}}>{submitting ? "Saving…" : "Save Card"}</Btn>
      </div>
    </form>
  )
}

function AddPaymentMethodModal({ onClose, onAdded }) {
  const [mode,          setMode]          = useState(null) // "stripe" | "dummy"
  const [stripePromise, setStripePromise] = useState(null)
  const [clientSecret,  setClientSecret]  = useState(null)
  const [error,         setError]         = useState("")
  const [loading,       setLoading]       = useState(true)

  useEffect(()=>{
    let cancelled = false
    Promise.all([billingApi.getPublishableKey(), billingApi.createSetupIntent()])
      .then(([{ publishableKey }, setupIntentRes])=>{
        if (cancelled) return
        if (!publishableKey || setupIntentRes.dummy) {
          setMode("dummy")
          setLoading(false)
          return
        }
        setStripePromise(getStripePromise(publishableKey))
        setClientSecret(setupIntentRes.clientSecret)
        setMode("stripe")
        setLoading(false)
      })
      .catch(err=>{ if (!cancelled) { setError(err.message || "Couldn't start card setup"); setLoading(false) } })
    return ()=>{ cancelled = true }
  },[])

  return (
    <Modal title="Add Payment Method" onClose={onClose} width={420}>
      {loading && <div style={{color:"#94a3b8",padding:"20px 0"}}>Loading…</div>}
      {!loading && error && <div style={{fontSize:12,color:"#991b1b",background:"#fee2e2",borderRadius:8,padding:"10px 14px"}}>{error}</div>}
      {!loading && !error && mode==="dummy" && <DummyCardForm onClose={onClose} onAdded={onAdded} />}
      {!loading && !error && mode==="stripe" && stripePromise && clientSecret && (
        <Elements stripe={stripePromise}>
          <AddCardForm clientSecret={clientSecret} onClose={onClose} onAdded={onAdded} />
        </Elements>
      )}
    </Modal>
  )
}

function BillingSettings({ user }) {
  const [org,         setOrg]         = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [redirecting, setRedirecting] = useState(false)
  const [error,       setError]       = useState("")

  const [paymentMethods,        setPaymentMethods]        = useState([])
  const [defaultPaymentMethodId,setDefaultPaymentMethodId] = useState(null)
  const [pmLoading,             setPmLoading]              = useState(true)
  const [showAddCard,           setShowAddCard]            = useState(false)
  const [pmActionId,            setPmActionId]             = useState(null) // id currently being set-default/removed, for per-row disabling

  useEffect(()=>{
    organizationApi.get().then(setOrg).catch(err=>setError(err.message||"Couldn't load billing info")).finally(()=>setLoading(false))
  },[])

  function loadPaymentMethods() {
    if (org?.myRole !== "owner" && org?.myRole !== "admin") { setPmLoading(false); return }
    setPmLoading(true)
    return billingApi.getPaymentMethods()
      .then(({ paymentMethods, defaultPaymentMethodId }) => {
        setPaymentMethods(paymentMethods || [])
        setDefaultPaymentMethodId(defaultPaymentMethodId || null)
      })
      .catch(()=>{})
      .finally(()=>setPmLoading(false))
  }
  useEffect(()=>{ loadPaymentMethods() },[org?.myRole])

  async function openBillingPortal() {
    setRedirecting(true); setError("")
    try {
      const { url } = await billingApi.getPortalUrl()
      window.location.href = url
    } catch (err) {
      setError(err.message || "Couldn't open billing portal")
      setRedirecting(false)
    }
  }

  // Called by AddPaymentMethodModal once Stripe has confirmed the card and
  // handed back its PaymentMethod id — never a raw card number.
  async function handleCardAdded(paymentMethodId) {
    try {
      // First card on the org becomes primary automatically — otherwise
      // there'd be a card on file that's still unusable for billing until
      // the owner remembers to flip it on separately.
      if (paymentMethods.length === 0) {
        await billingApi.setDefaultPaymentMethod(paymentMethodId)
      }
    } catch { /* card is still saved even if setting it default failed */ }
    setShowAddCard(false)
    await loadPaymentMethods()
  }

  async function handleSetPrimary(id) {
    setPmActionId(id); setError("")
    try { await billingApi.setDefaultPaymentMethod(id); await loadPaymentMethods() }
    catch (err) { setError(err.message || "Couldn't set primary card") }
    finally { setPmActionId(null) }
  }

  async function handleRemove(id) {
    if (!window.confirm("Remove this card?")) return
    setPmActionId(id); setError("")
    try { await billingApi.deletePaymentMethod(id); await loadPaymentMethods() }
    catch (err) { setError(err.message || "Couldn't remove card") }
    finally { setPmActionId(null) }
  }

  if (loading) return <div style={{color:"#64748b",padding:20}}>Loading…</div>
  if (!org) return <div style={{color:"#64748b",padding:20}}>{error || "Couldn't load billing info."}</div>

  const statusStyle = ORG_STATUS_STYLE[org.status] || ORG_STATUS_STYLE.trialing
  // Owner and admin can both manage billing/payment methods — same tier as
  // team management (isManager in routes/users.js), not owner-only.
  const canManageBilling = org.myRole === "owner" || org.myRole === "admin"

  return (
    <div style={{maxWidth:600}}>
      <div style={{...s.card,marginBottom:16}}>
        <div style={{fontWeight:700,marginBottom:4}}>{org.name}</div>
        <div style={{fontSize:12,color:"#94a3b8",marginBottom:16}}>Your organization's subscription and seat usage.</div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}} className="grid2-responsive">
          <div>
            <div style={s.label}>Plan</div>
            <div style={{fontSize:15,fontWeight:600}}>{PLAN_LABELS[org.planKey] || org.planKey || "—"}</div>
          </div>
          <div>
            <div style={s.label}>Status</div>
            <span style={{display:"inline-flex",alignItems:"center",padding:"3px 10px",borderRadius:20,fontSize:12,fontWeight:600,background:statusStyle.bg,color:statusStyle.color}}>
              {statusStyle.label}
            </span>
          </div>
          <div>
            <div style={s.label}>Seats used</div>
            <div style={{fontSize:15,fontWeight:600}}>{org.activeUserCount} / {org.seatLimit}</div>
          </div>
        </div>
      </div>

      <div style={{...s.card,marginBottom:16}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16}}>
          <div>
            <div style={{fontWeight:700,marginBottom:4}}>Payment Methods</div>
            <div style={{fontSize:12,color:"#94a3b8"}}>Add multiple payment methods you have</div>
          </div>
          {canManageBilling && (
            <button onClick={()=>setShowAddCard(true)}
              style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",color:"#7c3aed",fontWeight:600,fontSize:13,cursor:"pointer",padding:0}}>
              <span style={{fontSize:16,lineHeight:1}}>+</span> Add Payment Method
            </button>
          )}
        </div>

        {!canManageBilling ? (
          <div style={{fontSize:12,color:"#92400e",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,padding:"10px 14px"}}>
            Only your workspace owner or admin can manage billing and payment methods.
          </div>
        ) : pmLoading ? (
          <div style={{color:"#94a3b8",fontSize:13,padding:"10px 0"}}>Loading…</div>
        ) : paymentMethods.length === 0 ? (
          <div style={{color:"#94a3b8",fontSize:13,padding:"10px 0"}}>No payment methods on file yet.</div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {paymentMethods.map(pm => {
              const isPrimary = pm.id === defaultPaymentMethodId
              return (
                <div key={pm.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",border:"1px solid #e2e8f0",borderRadius:10,padding:"12px 16px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:14}}>
                    <CardBrandBadge brand={pm.brand} />
                    <div>
                      <div style={{fontSize:14,fontWeight:600,color:"#0f172a",textTransform:"capitalize"}}>
                        {pm.brand} xxxx-xxxx-xxxx-{pm.last4}
                      </div>
                      {pm.expMonth && pm.expYear && (
                        <div style={{fontSize:12,color:"#94a3b8",marginTop:2}}>
                          Expires {String(pm.expMonth).padStart(2,"0")}/{pm.expYear}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:14}}>
                    {isPrimary ? (
                      <span style={{background:"#7c3aed",color:"#fff",fontSize:11,fontWeight:700,letterSpacing:0.5,padding:"5px 12px",borderRadius:6}}>PRIMARY</span>
                    ) : (
                      <button onClick={()=>handleSetPrimary(pm.id)} disabled={pmActionId===pm.id}
                        style={{background:"none",border:"none",color:"#7c3aed",fontSize:13,fontWeight:600,cursor:pmActionId===pm.id?"default":"pointer",opacity:pmActionId===pm.id?0.6:1,padding:0}}>
                        Set as Primary
                      </button>
                    )}
                    <button onClick={()=>handleRemove(pm.id)} disabled={pmActionId===pm.id} title="Remove card"
                      style={{background:"none",border:"none",color:"#94a3b8",fontSize:16,cursor:pmActionId===pm.id?"default":"pointer",opacity:pmActionId===pm.id?0.6:1,padding:0}}>
                      🗑
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {error && <div style={{marginTop:14,fontSize:12,color:"#991b1b",background:"#fee2e2",borderRadius:8,padding:"8px 12px"}}>{error}</div>}
        <div style={{marginTop:14,fontSize:11,color:"#94a3b8"}}>
          Card details are entered directly into Stripe's secure form — they never pass through our servers.
        </div>
      </div>

      {canManageBilling && (
        <div style={{...s.card,marginBottom:16}}>
          <div style={{fontWeight:700,marginBottom:6}}>Invoices & plan changes</div>
          <div style={{fontSize:12,color:"#94a3b8",marginBottom:14,lineHeight:1.6}}>
            View past invoices or change your subscription plan through Stripe's billing portal.
          </div>
          <Btn onClick={openBillingPortal} style={{opacity:redirecting?0.6:1}}>
            {redirecting ? "Opening…" : "Open Billing Portal"}
          </Btn>
        </div>
      )}

      {showAddCard && (
        <AddPaymentMethodModal onClose={()=>setShowAddCard(false)} onAdded={handleCardAdded} />
      )}
    </div>
  )
}

// ─────────────────────────── PLATFORM ADMIN ───────────────────────────
// Cross-organization, read-only — only visible/reachable if user.isPlatformAdmin
// (both here and server-side via requirePlatformAdmin). Every other page in
// this app is scoped to the caller's own org; this is the deliberate
// exception, for you as the SaaS operator, not for a regular org owner/admin.
// Create a brand-new organization — name + seat limit only. No users yet;
// the flow is deliberately two steps (create the org, then click into it
// to add its team) rather than one combined form, so an org can exist
// with the right seat limit before anyone is added to it.
function CreateOrgModal({ onClose, onCreated }) {
  const [form,    setForm]    = useState({ name:"", seatLimit:"5" })
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState("")
  const upd = k => e => setForm(prev=>({...prev,[k]:e.target.value}))

  async function save() {
    if (!form.name.trim()) { setError("Organization name is required."); return }
    const seats = parseInt(form.seatLimit, 10)
    if (!Number.isInteger(seats) || seats < 1) { setError("Seat limit must be a positive number."); return }
    setSaving(true); setError("")
    try {
      const org = await platformAdminApi.createOrganization({ name: form.name.trim(), seatLimit: seats })
      onCreated(org)
    } catch(err) { setError(err.message || "Couldn't create organization.") }
    finally      { setSaving(false) }
  }

  return (
    <Modal title="New Organization" onClose={onClose} width={420}>
      <FG label="Organization Name *"><input style={s.input} value={form.name} onChange={upd("name")} placeholder="RK Roofing"/></FG>
      <FG label="Seat Limit (max users) *"><input style={s.input} type="number" min="1" value={form.seatLimit} onChange={upd("seatLimit")}/></FG>
      {error && <div style={{background:"#fee2e2",border:"1px solid #fca5a5",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#b91c1c",marginBottom:4}}>{error}</div>}
      <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:16}}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn primary onClick={save} style={{opacity:saving?0.6:1}}>{saving?"Creating…":"Create Organization"}</Btn>
      </div>
    </Modal>
  )
}

// Rename / change seat limit / change status on an existing organization.
function EditOrgModal({ org, onClose, onSaved }) {
  const [form,    setForm]    = useState({ name:org.name, seatLimit:String(org.seatLimit), status:org.status })
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState("")
  const upd = k => e => setForm(prev=>({...prev,[k]:e.target.value}))

  async function save() {
    const seats = parseInt(form.seatLimit, 10)
    if (!Number.isInteger(seats) || seats < 1) { setError("Seat limit must be a positive number."); return }
    setSaving(true); setError("")
    try {
      const updated = await platformAdminApi.updateOrganization(org.id, { name: form.name.trim(), seatLimit: seats, status: form.status })
      onSaved(updated)
    } catch(err) { setError(err.message || "Couldn't update organization.") }
    finally      { setSaving(false) }
  }

  return (
    <Modal title="Edit Organization" onClose={onClose} width={420}>
      <FG label="Organization Name *"><input style={s.input} value={form.name} onChange={upd("name")}/></FG>
      <FG label="Seat Limit (max users) *"><input style={s.input} type="number" min="1" value={form.seatLimit} onChange={upd("seatLimit")}/></FG>
      <FG label="Status">
        <select style={s.input} value={form.status} onChange={upd("status")}>
          {["trialing","active","past_due","canceled"].map(st=><option key={st} value={st}>{ORG_STATUS_STYLE[st]?.label || st}</option>)}
        </select>
      </FG>
      {error && <div style={{background:"#fee2e2",border:"1px solid #fca5a5",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#b91c1c",marginBottom:4}}>{error}</div>}
      <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:16}}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn primary onClick={save} style={{opacity:saving?0.6:1}}>{saving?"Saving…":"Save Changes"}</Btn>
      </div>
    </Modal>
  )
}

// Add a user directly inside a specific organization. Role is limited to
// Admin/Member here — this console stands up a manually-provisioned org's
// team; it doesn't hand out Stripe-billing "owner" access outside the
// self-serve signup flow.
function AddOrgUserModal({ orgId, onClose, onCreated }) {
  const [form,    setForm]    = useState({ name:"", email:"", password:"", role:"member" })
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState("")
  const upd = k => e => setForm(prev=>({...prev,[k]:e.target.value}))

  async function save() {
    if (!form.name.trim() || !form.email.trim() || !form.password.trim()) {
      setError("Name, email and password are required."); return
    }
    setSaving(true); setError("")
    try {
      const user = await platformAdminApi.createOrganizationUser(orgId, form)
      onCreated(user)
    } catch(err) {
      setError(err.body?.error==="seat_limit_exceeded"
        ? `Seat limit reached (${err.body.currentCount}/${err.body.seatLimit}) — raise the org's seat limit first.`
        : err.message || "Couldn't create user.")
    }
    finally { setSaving(false) }
  }

  return (
    <Modal title="Add User" onClose={onClose} width={440}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
        <FG label="Full Name *"><input style={s.input} value={form.name} onChange={upd("name")} placeholder="Jane Smith"/></FG>
        <FG label="Email *"><input style={s.input} type="email" value={form.email} onChange={upd("email")} placeholder="jane@company.com"/></FG>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
        <FG label="Password *"><input style={s.input} type="password" value={form.password} onChange={upd("password")} placeholder="Min 6 characters"/></FG>
        <FG label="Role">
          <select style={s.input} value={form.role} onChange={upd("role")}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </FG>
      </div>
      {error && <div style={{background:"#fee2e2",border:"1px solid #fca5a5",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#b91c1c",marginBottom:4}}>{error}</div>}
      <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:16}}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn primary onClick={save} style={{opacity:saving?0.6:1}}>{saving?"Creating…":"Create User"}</Btn>
      </div>
    </Modal>
  )
}

// Edit a user inside any org — name/email/role/active, plus an optional
// password reset (blank = unchanged). Role allows the full owner/admin/
// member range since this edits users that may already exist outside the
// manually-provisioned flow (e.g. Stripe-signup orgs' real owners).
function EditOrgUserModal({ orgId, targetUser, onClose, onSaved }) {
  const [form,   setForm]   = useState({ name:targetUser.name, email:targetUser.email, role:targetUser.role, password:"" })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState("")
  const upd = k => e => setForm(prev=>({...prev,[k]:e.target.value}))

  async function save() {
    if (!form.name.trim() || !form.email.trim()) { setError("Name and email are required."); return }
    setSaving(true); setError("")
    try {
      const payload = { name:form.name, email:form.email, role:form.role }
      if (form.password.trim()) payload.password = form.password
      const user = await platformAdminApi.updateOrganizationUser(orgId, targetUser.id, payload)
      onSaved(user)
    } catch(err) { setError(err.message || "Couldn't save user.") }
    finally      { setSaving(false) }
  }

  return (
    <Modal title="Edit User" onClose={onClose} width={440}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
        <FG label="Full Name *"><input style={s.input} value={form.name} onChange={upd("name")}/></FG>
        <FG label="Email *"><input style={s.input} type="email" value={form.email} onChange={upd("email")}/></FG>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="grid2-responsive">
        <FG label="New Password (leave blank to keep current)"><input style={s.input} type="password" value={form.password} onChange={upd("password")} placeholder="••••••••"/></FG>
        <FG label="Role">
          <select style={s.input} value={form.role} onChange={upd("role")}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
        </FG>
      </div>
      {error && <div style={{background:"#fee2e2",border:"1px solid #fca5a5",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#b91c1c",marginBottom:4}}>{error}</div>}
      <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:16}}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn primary onClick={save} style={{opacity:saving?0.6:1}}>{saving?"Saving…":"Save Changes"}</Btn>
      </div>
    </Modal>
  )
}

function PlatformAdminPanel() {
  const [orgs,       setOrgs]       = useState([])
  const [loading,    setLoading]    = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [orgUsers,   setOrgUsers]   = useState({}) // { [orgId]: users[] }
  const [usersLoading, setUsersLoading] = useState(false)

  const [showCreateOrg, setShowCreateOrg] = useState(false)
  const [editingOrg,    setEditingOrg]    = useState(null) // org row being edited
  const [addUserOrgId,  setAddUserOrgId]  = useState(null) // org id we're adding a user into
  const [editingUser,   setEditingUser]   = useState(null) // { orgId, user }

  useEffect(()=>{ loadOrgs() },[])

  async function loadOrgs() {
    setLoading(true)
    try { setOrgs(await platformAdminApi.getOrganizations()) }
    catch(err) { console.error("Failed to load organizations:", err) }
    finally    { setLoading(false) }
  }

  async function loadOrgUsers(orgId) {
    setUsersLoading(true)
    try {
      const rows = await platformAdminApi.getOrganizationUsers(orgId)
      setOrgUsers(prev => ({ ...prev, [orgId]: rows.map(normalizeKeys) }))
    } catch(err) { console.error("Failed to load org users:", err) }
    finally      { setUsersLoading(false) }
  }

  async function toggleExpand(orgId) {
    if (expandedId === orgId) { setExpandedId(null); return }
    setExpandedId(orgId)
    if (!orgUsers[orgId]) await loadOrgUsers(orgId)
  }

  if (loading) return <div style={{color:"#64748b",padding:20}}>Loading…</div>

  return (
    <div style={{width:"100%"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:16,flexWrap:"wrap"}}>
        <div style={{fontSize:13,color:"#64748b"}}>
          Every organization on the platform — visible to you as a platform admin only. Click a row to see its team.
        </div>
        <Btn primary onClick={()=>setShowCreateOrg(true)}>+ New Organization</Btn>
      </div>
      <div style={{...s.card,padding:0,overflow:"hidden"}}>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:680}}>
            <thead>
              <tr>{["Organization","Plan","Status","Seats","Created",""].map(h=><th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {orgs.map(org => {
                const statusStyle = ORG_STATUS_STYLE[org.status] || ORG_STATUS_STYLE.trialing
                const expanded = expandedId === org.id
                return (
                  <Fragment key={org.id}>
                    <tr>
                      <td style={{...s.td,fontWeight:600,cursor:"pointer"}} onClick={()=>toggleExpand(org.id)}>{expanded?"▾":"▸"} {org.name}</td>
                      <td style={{...s.td,fontSize:12,color:"#64748b"}}>{PLAN_LABELS[org.planKey] || org.planKey || "—"}</td>
                      <td style={s.td}>
                        <span style={{display:"inline-flex",alignItems:"center",padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:600,background:statusStyle.bg,color:statusStyle.color}}>
                          {statusStyle.label}
                        </span>
                      </td>
                      <td style={{...s.td,fontSize:12,color:"#64748b"}}>{org.activeUserCount} / {org.seatLimit}</td>
                      <td style={{...s.td,fontSize:12,color:"#64748b"}}>{fmtD(org.createdAt)}</td>
                      <td style={s.td}><Btn sm onClick={()=>setEditingOrg(org)}>Edit</Btn></td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={6} style={{padding:"0 16px 16px 40px",borderBottom:"1px solid #f1f5f9"}}>
                          <div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}>
                            <Btn sm onClick={()=>setAddUserOrgId(org.id)}>+ Add User</Btn>
                          </div>
                          {usersLoading && !orgUsers[org.id] ? (
                            <div style={{color:"#94a3b8",fontSize:12,padding:10}}>Loading team…</div>
                          ) : (
                            <table style={{width:"100%",borderCollapse:"collapse"}}>
                              <thead>
                                <tr>{["User","Email","Role","Status",""].map(h=><th key={h} style={{...s.th,fontSize:10}}>{h}</th>)}</tr>
                              </thead>
                              <tbody>
                                {(orgUsers[org.id]||[]).map(u=>(
                                  <tr key={u.id}>
                                    <td style={{...s.td,fontSize:12}}>{u.name}{u.isPlatformAdmin && <span style={{marginLeft:6,fontSize:9,background:"#ede9fe",color:"#5b21b6",padding:"1px 6px",borderRadius:8,fontWeight:600}}>PLATFORM ADMIN</span>}</td>
                                    <td style={{...s.td,fontSize:12,color:"#3b82f6"}}>{u.email}</td>
                                    <td style={{...s.td,fontSize:12,color:"#64748b",textTransform:"capitalize"}}>{u.role}</td>
                                    <td style={{...s.td,fontSize:12,color:u.isActive!==false?"#065f46":"#991b1b"}}>{u.isActive!==false?"Active":"Disabled"}</td>
                                    <td style={s.td}><Btn sm onClick={()=>setEditingUser({orgId:org.id, user:u})}>Edit</Btn></td>
                                  </tr>
                                ))}
                                {(orgUsers[org.id]||[]).length===0 && <tr><td colSpan={5} style={{...s.td,textAlign:"center",color:"#94a3b8"}}>No users yet</td></tr>}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {orgs.length===0 && <tr><td colSpan={6} style={{...s.td,textAlign:"center",color:"#94a3b8",padding:32}}>No organizations found</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {showCreateOrg && (
        <CreateOrgModal
          onClose={()=>setShowCreateOrg(false)}
          onCreated={(org)=>{ setOrgs(prev=>[org, ...prev]); setShowCreateOrg(false) }}
        />
      )}

      {editingOrg && (
        <EditOrgModal
          org={editingOrg}
          onClose={()=>setEditingOrg(null)}
          onSaved={(updated)=>{ setOrgs(prev=>prev.map(o=>o.id===updated.id?{...o,...updated}:o)); setEditingOrg(null) }}
        />
      )}

      {addUserOrgId && (
        <AddOrgUserModal
          orgId={addUserOrgId}
          onClose={()=>setAddUserOrgId(null)}
          onCreated={(user)=>{
            setOrgUsers(prev => ({ ...prev, [addUserOrgId]: [...(prev[addUserOrgId]||[]), normalizeKeys(user)] }))
            setOrgs(prev => prev.map(o => o.id===addUserOrgId ? { ...o, activeUserCount: o.activeUserCount+1 } : o))
            setAddUserOrgId(null)
          }}
        />
      )}

      {editingUser && (
        <EditOrgUserModal
          orgId={editingUser.orgId}
          targetUser={editingUser.user}
          onClose={()=>setEditingUser(null)}
          onSaved={(updated)=>{
            const orgId = editingUser.orgId
            setOrgUsers(prev => ({ ...prev, [orgId]: (prev[orgId]||[]).map(u=>u.id===updated.id?normalizeKeys(updated):u) }))
            setEditingUser(null)
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────── APP ───────────────────────────
export default function App() {
  const [view,            setView]           = useState("dashboard")
  const [projects,        setProjects]       = useState([])
  const [customers,       setCustomers]      = useState([])
  const [jobs,            setJobs]           = useState([])
  const [selectedProject, setSelectedProject]= useState(null)
  const [loaded,          setLoaded]         = useState(false)
  const [toast,           setToast]          = useState(null)
  const [showWizard,      setShowWizard]     = useState(false)
  const [editingProject,  setEditingProject] = useState(null)
  const [mobileNavOpen,   setMobileNavOpen]  = useState(false)
  const [authView,        setAuthView]       = useState("login") // "login" | "signup" — only relevant while logged out
  const [showProfileModal, setShowProfileModal] = useState(false)

  const { user, login, logout, updateUser } = useAuth()

  // ← Quotation branding is now per-user, stored server-side in
  //   company_profiles (was previously a single browser-localStorage blob
  //   shared by whoever used that browser — not real per-account SaaS
  //   settings). DEFAULT_SETTINGS is just the pre-fetch placeholder.
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)

  useEffect(()=>{
    if (!user) {
      setLoaded(false)
      setProjects([])
      setCustomers([])
      setJobs([])
      return
    }
    // ← Each resource is fetched independently (not a single Promise.all) so
    //   one failing request — e.g. a slow company-profile fetch — can't wipe
    //   out successfully-loaded real data for the others. Failures no longer
    //   silently substitute fake seed_customers/seed_projects (non-UUID ids
    //   like "c1") into live state, since any write against that fake data
    //   fails server-side with a confusing "invalid input syntax for uuid"
    //   error — a failed load now surfaces a toast instead.
    async function loadData() {
      const results = await Promise.allSettled([
        projectsApi.getAll(),
        customersApi.getAll(),
        jobsApi.getAll(),
        companyProfileApi.get(),
      ])
      const [projectsResult, customersResult, jobsResult, profileResult] = results

      const loadedProjects = projectsResult.status === "fulfilled" ? projectsResult.value.map(normalizeProject) : []
      if (projectsResult.status === "fulfilled") setProjects(loadedProjects)
      if (customersResult.status === "fulfilled") setCustomers(customersResult.value.map(normalizeKeys))
      if (jobsResult.status === "fulfilled") setJobs(jobsResult.value)
      if (profileResult.status === "fulfilled") setSettings({...DEFAULT_SETTINGS,...profileResult.value})

      const failed = results.some(r => r.status === "rejected")
      if (failed) {
        results.forEach(r => { if (r.status === "rejected") console.error("Failed to load data:", r.reason) })
        setToast("Couldn't load some data — check your connection and refresh")
      }

      // ← Landing spot after the reload triggered by saving an Edit Project —
      //   see handleSaveProject. Consumed once, then cleared, so a manual
      //   browser refresh afterward doesn't keep jumping back here.
      const reopenId = sessionStorage.getItem("reopenProjectId")
      if(reopenId) {
        sessionStorage.removeItem("reopenProjectId")
        const reopenToast = sessionStorage.getItem("reopenToast")
        sessionStorage.removeItem("reopenToast")
        const proj = loadedProjects.find(p=>p.id===reopenId)
        if(proj) { setSelectedProject(proj); setView("project") }
        if(reopenToast) setToast(reopenToast)
      }

      setLoaded(true)
    }
    loadData()
  },[user])

  // Early returns AFTER all hooks
  if (!user) {
    return authView === "signup"
      ? <SignupPage onBackToLogin={() => setAuthView("login")} onLogin={login} />
      : <LoginPage onLogin={login} onShowSignup={() => setAuthView("signup")} />
  }

  async function saveSettings(updates) {
    const merged = {...settings,...updates}
    setSettings(merged)
    try { await companyProfileApi.update(merged) } catch(err) { console.error("Failed to save company profile:", err) }
  }

  const PAGE_TITLES = {
    dashboard:"Dashboard", pipeline:"Pipeline",
    projects:"Projects",   project:"Project Detail",
    customers:"Customers", quote_print:"Quote",
    jobs:"Jobs",
    users:"Team",          settings:"Settings",
    complexity:"Job Complexity", billing:"Billing & Plan",
    "platform-admin":"All Organizations",
  }

  function handleNav(key) {
    if(key==="new") { setEditingProject(null); setShowWizard(true); setMobileNavOpen(false); return }
    setView(key)
    if(key!=="project") setSelectedProject(null)
    setMobileNavOpen(false)
  }

  async function handleSaveProject(project, pendingNewCust) {
    try {
      const isEdit = projects.some(p=>p.id===project.id)
      let savedProject

      if(isEdit) {
        const raw    = await projectsApi.update(project.id, project)
        savedProject = { ...project, ...normalizeProject(raw), estimate: project.estimate }
        setProjects(prev=>prev.map(p=>p.id===savedProject.id?savedProject:p))
      } else {
        const raw    = await projectsApi.create(project)
        savedProject = { ...project, ...normalizeProject(raw), estimate: project.estimate }
        setProjects(prev=>[...prev,savedProject])
      }

      if(pendingNewCust) {
        const rawCust = await customersApi.create(pendingNewCust)
        const newCust = normalizeKeys(rawCust)
        savedProject  = { ...savedProject, customerId: newCust.id }
        setProjects(prev=>prev.map(p=>p.id===savedProject.id?savedProject:p))
        setCustomers(prev=>[...prev, newCust])
      }

      // Persist a quote snapshot whenever the save produced a numbered quote —
      // this is what backs the quote-history list on the project page.
      if (savedProject.quoteNum && savedProject.estimate) {
        quotesApi.save(savedProject.id, {
          quoteNum:  savedProject.quoteNum,
          quoteDate: savedProject.quoteDate || today(),
          total:     savedProject.estimate.total || 0,
          snapshot:  { project: savedProject, estimate: savedProject.estimate },
        }).catch(err => console.error("Quote history save failed:", err))
      }

      // Persist the traced measurement geometry + canvas snapshot (used to
      // embed the roof plan image in the generated quote) now that we know
      // the real backend-assigned project id. Awaited (not fire-and-forget)
      // and given its own honest success/failure toast — this used to be a
      // swallowed .catch(console.error) that let the wizard close and show
      // "Project updated!" even when this specific save failed, making
      // measurement edits (e.g. a deleted section) silently never persist
      // while looking successful.
      let geometrySaveFailed = false
      if (project.geometry) {
        try {
          await estimatesApi.saveGeometry(savedProject.id, project.geometry)
        } catch(err) {
          console.error("Geometry save failed:", err)
          geometrySaveFailed = true
        }
      }

      const toastMsg = geometrySaveFailed
        ? "Project saved, but the measurement/roof plan failed to save — please reopen and try saving again."
        : (isEdit?"Project updated!":"Project created!")

      if(isEdit) {
        // ← A full reload instead of relying on in-memory state to reflect
        //   the save — the project list/detail/measurement plan all refetch
        //   from scratch on load, guaranteeing what's shown afterward is
        //   exactly what the server has, not whatever the client's own
        //   patched-together state happens to believe. Reopen target + toast
        //   are stashed across the reload since there's no URL routing here
        //   to carry them (view/selectedProject are plain in-memory state).
        sessionStorage.setItem("reopenProjectId", savedProject.id)
        sessionStorage.setItem("reopenToast", toastMsg)
        window.location.reload()
        return
      }

      setShowWizard(false)
      setEditingProject(null)
      setSelectedProject(savedProject)
      setView("project")
      setToast(toastMsg)
    } catch(err) {
      console.error("Save failed:", err)
      setToast(err.status ? `Error saving project: ${err.message}` : "Error saving project. Is the backend running?")
    }
  }

  function openEdit(project) { setEditingProject(project); setShowWizard(true) }

  const currentProject = selectedProject
    ? (projects.find(p=>p.id===selectedProject.id) || selectedProject)
    : null

  if(!loaded) return (
    <div className="flex h-screen items-center justify-center font-sans bg-slate-50">
      <div className="text-center">
        <img src="/aTopRoof.png" alt="aTopRoof" className="w-[220px] mb-3"/>
        <div className="text-slate-500 mt-2 text-[13px]">Loading your workspace…</div>
      </div>
    </div>
  )

  // ─── Everything below is wrapped in CurrencyProvider/TaxProvider so all
  //     child components can call useCurrency()/useTax() safely. ─────────
  return (
    <CurrencyProvider user={user}>
    <TaxProvider>
      <div className="app-shell flex h-screen overflow-hidden font-sans text-[14px] text-slate-900 bg-slate-50">
        <div data-sidebar className={"app-sidebar w-[220px] min-w-[220px] bg-navy flex flex-col h-full"+(mobileNavOpen?" nav-open":"")}>
          <button
            className="mobile-menu-btn items-center justify-center w-9 h-9 border-none bg-white/10 rounded-lg text-white text-lg cursor-pointer shrink-0 mr-2.5"
            onClick={()=>setMobileNavOpen(o=>!o)}
          >
            {mobileNavOpen ? "✕" : "☰"}
          </button>
          <div className="app-sidebar-logo px-5 pt-5 pb-4 border-b border-white/10">
            <img src="/aTopRoof.png" alt="aTopRoof" className="w-full max-w-[164px] block bg-white rounded-[10px] px-3 py-2 shadow-md"/>
            <div className="text-[10px] text-accent tracking-widest uppercase mt-2 font-semibold">Elevate Your Roofing Business</div>
          </div>
          <nav className="app-sidebar-nav flex-1 px-2.5 py-3 flex flex-col gap-0.5 overflow-y-auto">
            {[
              { key:"dashboard",  label:"Dashboard",   icon:"⬛" },
              { key:"new",        label:"New Project", icon:"📸", primary:true },
              null,
              { key:"pipeline",   label:"Pipeline",    icon:"▦", badge:projects.filter(p=>p.status==="Quote Sent").length||null },
              { key:"projects",   label:"Projects",    icon:"📁" },
              { key:"customers",  label:"Customers",   icon:"👤" },
              { key:"jobs",       label:"Jobs",        icon:"🧰" },
              null,
              { key:"users",      label:"Team",        icon:"🔑" },
              { key:"settings",   label:"Settings",    icon:"⚙" },
              { key:"complexity", label:"Job Complexity", icon:"📊" },
              { key:"billing",    label:"Billing & Plan", icon:"💳" },
              // ← Only for you as the SaaS operator — spread-in rather than a
              //   plain conditional entry so a non-platform-admin doesn't get
              //   a stray divider where a `null` placeholder would otherwise
              //   render (every real `null` in this array means "draw a
              //   divider line here", which isn't what "not shown" means).
              ...(user?.isPlatformAdmin ? [{ key:"platform-admin", label:"All Organizations", icon:"🌐" }] : []),
            ].map((item,i)=> item===null
              ? <div key={i} className="h-px bg-white/[.06] my-2"/>
              : (
                <div key={item.key}
                  onClick={()=>handleNav(item.key)}
                  className={`flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg cursor-pointer text-slate-300 text-[13px] font-medium transition-colors select-none hover:bg-white/5
                    ${view===item.key ? "!bg-accent/15 !text-accent" : ""}
                    ${item.primary ? "mt-1 bg-accent/10 text-accent border border-accent/20" : ""}`}
                >
                  <span className="text-sm">{item.icon}</span>
                  <span>{item.label}</span>
                  {item.badge && <span className="ml-auto bg-accent text-slate-900 text-[10px] font-bold px-1.5 py-px rounded-full">{item.badge}</span>}
                </div>
              )
            )}
          </nav>
          <div className="app-sidebar-user flex items-center justify-between gap-2 mt-3 mx-2 mb-2 px-2.5 py-2 rounded-lg bg-white/[.04]">
            <button onClick={()=>setShowProfileModal(true)} title="My Profile"
              className="flex items-center gap-2 min-w-0 bg-transparent border-none cursor-pointer text-left p-0">
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-accent to-orange-500 flex items-center justify-center text-[11px] font-bold text-slate-900 shrink-0">
                {user?.name?.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-xs text-white font-medium whitespace-nowrap overflow-hidden text-ellipsis">{user?.name}</div>
                <div className="text-[10px] text-slate-500">My Profile</div>
              </div>
            </button>
            <button onClick={logout} title="Sign out" className="bg-transparent border-none cursor-pointer text-slate-500 hover:text-slate-300 text-base p-1 leading-none shrink-0">⏻</button>
          </div>
        </div>
        <div className="flex-1 flex flex-col overflow-hidden">
          <div data-topbar className="app-topbar flex items-center justify-between px-6 py-3.5 border-b border-slate-200 bg-white shrink-0">
            <div className="app-topbar-title font-display text-lg font-extrabold">
              {view==="project"&&currentProject
                ? (customers.find(c=>c.id===currentProject.customerId)?.name||"Project Detail")
                : PAGE_TITLES[view]||view}
            </div>
            <div className="flex gap-2.5 items-center flex-wrap">
              {view==="project"&&currentProject&&<StatusBadge status={currentProject.status}/>}
              {view==="projects"&&<span className="text-[13px] text-slate-500">{projects.length} total</span>}
              <Btn onClick={()=>{ setEditingProject(null); setShowWizard(true) }} primary>
                📸 New Project
              </Btn>
            </div>
          </div>

          <BillingBanner user={user} />

          <div data-main-content className="app-content flex-1 overflow-y-auto p-6">
            {view==="dashboard"&&(
              <Dashboard
                projects={projects} customers={customers}
                setView={setView} setSelectedProject={setSelectedProject}
                onNewProject={()=>{ setEditingProject(null); setShowWizard(true) }}
              />
            )}
            {view==="projects"&&<ProjectsList projects={projects} customers={customers} setProjects={setProjects} setView={setView} setSelectedProject={setSelectedProject}/>}
            {view==="project"&&currentProject&&(
              <ProjectDetail
                project={currentProject} customers={customers}
                projects={projects} setProjects={setProjects}
                setView={setView} onEdit={()=>openEdit(currentProject)}
                company={settings}
              />
            )}
            {view==="quote_print"&&currentProject&&(
              <QuotePrintView project={currentProject} customer={customers.find(c=>c.id===currentProject.customerId)} company={settings} setView={setView}/>
            )}
            {view==="pipeline"&&<Pipeline projects={projects} customers={customers} setProjects={setProjects} setView={setView} setSelectedProject={setSelectedProject}/>}
            {view==="customers"&&<Customers customers={customers} setCustomers={setCustomers} projects={projects}/>}
            {view==="jobs"&&<Jobs jobs={jobs} setJobs={setJobs} customers={customers}/>}
            {view==="users"&&<Users currentUser={user}/>}
            {view==="settings"&&<Settings settings={settings} onSave={saveSettings}/>}
            {view==="complexity"&&<JobComplexitySettings/>}
            {view==="billing"&&<BillingSettings user={user}/>}
            {view==="platform-admin"&&user?.isPlatformAdmin&&<PlatformAdminPanel/>}
          </div>
        </div>
      </div>

      {showWizard&&(
        <Modal title={editingProject?"Edit Project":"New Project"} onClose={()=>{ setShowWizard(false); setEditingProject(null) }} width={1400}>
          <NewProjectWizard
            customers={customers} projects={projects} jobs={jobs}
            existingProject={editingProject}
            onSave={handleSaveProject}
            onCancel={()=>{ setShowWizard(false); setEditingProject(null) }}
            company={settings}
          />
        </Modal>
      )}

      {toast&&<Toast msg={toast} onDone={()=>setToast(null)}/>}

      {showProfileModal && (
        <MyProfileModal
          user={user}
          onClose={()=>setShowProfileModal(false)}
          onSaved={(partial)=>{ updateUser(partial); setShowProfileModal(false) }}
        />
      )}
    </TaxProvider>
    </CurrencyProvider>
  )
}
