import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts"
import { customersApi, projectsApi } from "./api"
import { useAuth } from "./AuthContext"
import LoginPage   from "./LoginPage"

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

// FIX: named constants instead of magic numbers
const RATES = { flashings: 28, guttering: 45, downpipe: 35, underlayment: 8 }
const GST_RATE = 0.15

// FIX: default settings with fallback values
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
}

// ─────────────────────────── HELPERS ───────────────────────────
const uid    = () => Math.random().toString(36).slice(2,10)
const fmt    = n  => "$"+Math.round(n).toLocaleString()
// FIX: fmtD now handles both "2024-12-15" (date string) and full ISO timestamps from DB
const fmtD   = d  => {
  if(!d) return "—"
  const str = String(d)
  // If it's already a full ISO timestamp, use it directly; otherwise append noon to avoid TZ shift
  const iso = str.includes("T") ? str : str.slice(0,10)+"T12:00:00"
  return new Date(iso).toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"})
}
const today  = () => new Date().toISOString().slice(0,10)

// FIX: snake_case → camelCase normalizers for API responses
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

// FIX: use RATES and GST_RATE instead of magic numbers
function calcEst(e) {
  if(!e) return null
  const adjArea    = e.area * e.pitch * (1 + (e.waste||0)/100)
  const matCost    = adjArea * e.materialRate
  const flashCost  = (e.flashings||0) * RATES.flashings
  const gutCost    = (e.guttering||0) * RATES.guttering
  const labCost    = (e.dayRate||850) * (e.days||0)
  const sub        = matCost + flashCost + gutCost + labCost
  const marginAmt  = sub * ((e.margin||0)/100)
  const sellPrice  = sub + marginAmt
  const gst        = sellPrice * GST_RATE
  const total      = sellPrice + gst
  return { ...e, adjArea, matCost, flashCost, gutCost, labCost, marginAmt, sellPrice, gst, total }
}

function nextQuoteNum(projects) {
  const nums = projects.filter(p=>p.quoteNum).map(p=>parseInt(p.quoteNum.replace("QT-","")||"0"))
  return "QT-"+String((nums.length ? Math.max(...nums) : 40)+1).padStart(3,"0")
}

// ─────────────────────────── SEED DATA (fallback when backend is offline) ───────────────────────────
const seed_customers = [
  { id:"c1",name:"Sarah Thompson",   email:"sarah.t@gmail.com",      phone:"021 999 0011", address:"47 Ridgeline Ave, Titirangi, Auckland" },
  { id:"c2",name:"Mike Thorn",       email:"m.thorn@hotmail.com",    phone:"021 444 2233", address:"14 Henderson Valley Rd, Henderson"     },
  { id:"c3",name:"Raj Patel",        email:"rpatel@patel.co.nz",     phone:"09 555 7788",  address:"22 Remuera Rd, Remuera, Auckland"      },
  { id:"c4",name:"James Clark",      email:"james@clark.net",        phone:"021 234 5678", address:"51 Clark St, Ponsonby, Auckland"       },
  { id:"c5",name:"Riverdale Builders",email:"info@riverdale.co.nz",  phone:"09 800 1100",  address:"5 Trade Lane, Mt Wellington, Auckland" },
]
const e1 = calcEst({area:215,pitch:1.15,waste:10,materialRate:55,materialLabel:"Long Run Steel",flashings:24,guttering:32,dayRate:850,days:3.5,margin:20})
const e2 = calcEst({area:165,pitch:1.1, waste:10,materialRate:55,materialLabel:"Long Run Steel",flashings:18,guttering:24,dayRate:850,days:2.5,margin:20})
const e3 = calcEst({area:142,pitch:1.15,waste:12,materialRate:65,materialLabel:"Metal Tiles",   flashings:16,guttering:20,dayRate:850,days:2,  margin:25})
const e4 = calcEst({area:187,pitch:1.25,waste:15,materialRate:55,materialLabel:"Long Run Steel",flashings:28,guttering:36,dayRate:850,days:4,  margin:20})
const e6 = calcEst({area:198,pitch:1.15,waste:10,materialRate:65,materialLabel:"Metal Tiles",   flashings:22,guttering:28,dayRate:850,days:3,  margin:22})
const e7 = calcEst({area:130,pitch:1.0, waste:10,materialRate:35,materialLabel:"Corrugated Iron",flashings:14,guttering:18,dayRate:850,days:2, margin:18})
const seed_projects = [
  { id:"p1",customerId:"c1",address:"47 Ridgeline Ave, Titirangi, Auckland",status:"Quote Sent",area:215,roofType:"Long Run Steel",notes:"Remove existing iron. Access via side gate.",quoteNum:"QT-041",quoteDate:"2024-12-15",createdAt:"2024-12-14",estimate:e1 },
  { id:"p2",customerId:"c2",address:"14 Henderson Valley Rd, Henderson",    status:"Won",       area:165,roofType:"Long Run Steel",notes:"Full reroof including underlayment.",         quoteNum:"QT-039",quoteDate:"2024-12-08",createdAt:"2024-12-06",estimate:e2 },
  { id:"p3",customerId:"c3",address:"22 Remuera Rd, Remuera, Auckland",     status:"Quote Sent",area:142,roofType:"Metal Tiles",   notes:"Metal tiles to match character home.",        quoteNum:"QT-042",quoteDate:"2024-12-14",createdAt:"2024-12-12",estimate:e3 },
  { id:"p4",customerId:"c4",address:"51 Clark St, Ponsonby, Auckland",      status:"Estimating",area:187,roofType:"Long Run Steel",notes:"Complex hip roof. Measure carefully.",         quoteNum:"",      quoteDate:"",          createdAt:"2024-12-13",estimate:e4 },
  { id:"p5",customerId:"c5",address:"5 Trade Lane, Mt Wellington, Auckland",status:"New Lead",  area:0,  roofType:"",             notes:"Large commercial building. Needs site visit.", quoteNum:"",      quoteDate:"",          createdAt:"2024-12-13",estimate:null },
  { id:"p6",customerId:"c2",address:"8 Second Ave, Remuera, Auckland",      status:"Won",       area:198,roofType:"Metal Tiles",   notes:"",                                            quoteNum:"QT-036",quoteDate:"2024-11-28",createdAt:"2024-11-25",estimate:e6 },
  { id:"p7",customerId:"c1",address:"3 Beach Rd, Pt Chevalier, Auckland",   status:"Lost",      area:130,roofType:"Corrugated Iron",notes:"Client went with another contractor.",        quoteNum:"QT-037",quoteDate:"2024-12-01",createdAt:"2024-11-28",estimate:e7 },
]

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
  const base = { display:"inline-flex", alignItems:"center", gap:6, padding:sm?"6px 12px":"8px 16px", borderRadius:8, fontSize:13, fontWeight:500, cursor:"pointer", border:"none", transition:"all .15s", fontFamily:"inherit", ...style }
  if(primary) return <button style={{...base, background:"#f59e0b", color:"#000"}} onClick={onClick}>{children}</button>
  if(danger)  return <button style={{...base, background:"#fee2e2", color:"#b91c1c", border:"1px solid #fca5a5"}} onClick={onClick}>{children}</button>
  return <button style={{...base, background:"transparent", color:"#64748b", border:"1px solid #e2e8f0", ...(full&&{width:"100%",justifyContent:"center"})}} onClick={onClick}>{children}</button>
}

function StatusBadge({ status }) {
  const st = STATUS_STYLE[status]||STATUS_STYLE["New Lead"]
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:600,background:st.bg,color:st.color}}>
    <span style={{width:6,height:6,borderRadius:"50%",background:st.dot}}/>
    {status}
  </span>
}

function Modal({ title, onClose, children, width=560 }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"flex-start",justifyContent:"center",zIndex:1000,overflowY:"auto",padding:"40px 20px"}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:"#fff",borderRadius:14,width:"100%",maxWidth:width,boxShadow:"0 20px 60px rgba(0,0,0,0.2)"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"18px 22px",borderBottom:"1px solid #e2e8f0"}}>
          <span style={{fontWeight:700,fontSize:16}}>{title}</span>
          <button onClick={onClose} style={{border:"none",background:"none",cursor:"pointer",fontSize:20,color:"#64748b",lineHeight:1}}>×</button>
        </div>
        <div style={{padding:22}}>{children}</div>
      </div>
    </div>
  )
}

// FIX: added onDone to dependency array
function Toast({ msg, onDone }) {
  useEffect(()=>{ const t = setTimeout(onDone, 3000); return ()=>clearTimeout(t) },[onDone])
  return <div style={{position:"fixed",bottom:24,right:24,background:"#0f172a",color:"#fff",padding:"12px 20px",borderRadius:10,fontSize:13,fontWeight:500,zIndex:9999,display:"flex",alignItems:"center",gap:8}}>
    <span style={{color:"#10b981",fontSize:16}}>✓</span> {msg}
  </div>
}

function FG({ label, children, half }) {
  return <div style={{marginBottom:14,...(half&&{gridColumn:"span 1"})}}>
    <label style={s.label}>{label}</label>
    {children}
  </div>
}

// ─────────────────────────── SIDEBAR ───────────────────────────
function Sidebar({ view, onNav, projects, user, onLogout }) {
  const won     = projects.filter(p=>p.status==="Won")
  const revenue = won.reduce((a,p)=>a+(p.estimate?.total||0),0)
  const pending = projects.filter(p=>p.status==="Quote Sent").length

  const items = [
    { key:"dashboard",  label:"Dashboard",   icon:"⬛" },
    { key:"new",        label:"New Project", icon:"📸", primary:true },
    null,
    { key:"pipeline",   label:"Pipeline",    icon:"▦", badge:pending||null },
    { key:"projects",   label:"Projects",    icon:"📁" },
    { key:"customers",  label:"Customers",   icon:"👤" },
    null,
    { key:"settings",   label:"Settings",    icon:"⚙" },
  ]

  return (
    <div style={s.sidebar}>
      <div style={s.logo}>
        <img src="/aTopRoof.png" alt="aTopRoof" style={{width:"100%",maxWidth:164,display:"block",filter:"brightness(1.05)"}}/>
        <div style={{fontSize:10,color:"#f59e0b",letterSpacing:1,textTransform:"uppercase",marginTop:8,fontWeight:600}}>Elevate Your Roofing Business</div>
      </div>
      <nav style={s.nav}>
        {items.map((item,i)=> item===null
          ? <div key={i} style={{height:1,background:"rgba(255,255,255,0.06)",margin:"8px 0"}}/>
          : (
            <div key={item.key}
              onClick={()=>onNav(item.key)}
              style={{...s.navItem,
                ...(view===item.key ? {background:"rgba(245,158,11,0.15)",color:"#f59e0b"} : {}),
                ...(item.primary ? {marginTop:4,background:"rgba(245,158,11,0.1)",color:"#f59e0b",border:"1px solid rgba(245,158,11,0.2)"} : {})
              }}
            >
              <span style={{fontSize:14}}>{item.icon}</span>
              <span>{item.label}</span>
              {item.badge && <span style={{marginLeft:"auto",background:"#f59e0b",color:"#000",fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:20}}>{item.badge}</span>}
            </div>
          )
        )}
      </nav>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginTop:12,padding:"8px 10px",borderRadius:8,background:"rgba(255,255,255,0.04)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0}}>
          <div style={{width:28,height:28,borderRadius:"50%",background:"linear-gradient(135deg,#f59e0b,#f97316)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:"#000",flexShrink:0}}>
            {user?.name?.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()}
          </div>
          <div style={{minWidth:0}}>
            <div style={{fontSize:12,color:"#fff",fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{user?.name}</div>
            <div style={{fontSize:10,color:"#475569"}}>aTopRoof CRM</div>
          </div>
        </div>
        <button onClick={onLogout} title="Sign out" style={{
          background:"none", border:"none", cursor:"pointer",
          color:"#475569", fontSize:16, padding:4, lineHeight:1, flexShrink:0,
        }}>⏻</button>
      </div>
    </div>
  )
}

// ─────────────────────────── DASHBOARD ───────────────────────────
function Dashboard({ projects, customers, setView, setSelectedProject, onNewProject }) {
  const stats = useMemo(()=>{
    const won    = projects.filter(p=>p.status==="Won")
    const sent   = projects.filter(p=>p.status==="Quote Sent")
    const leads  = projects.filter(p=>p.status==="New Lead")
    const revenue = won.reduce((a,p)=>a+(p.estimate?.total||0),0)
    const pipeline= sent.reduce((a,p)=>a+(p.estimate?.total||0),0)
    return { leads:leads.length, sent:sent.length, won:won.length, revenue, pipeline, total:projects.length }
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
      <div style={s.grid4}>
        {[
          { label:"Total Projects",  val:stats.total,        sub:`${stats.leads} new leads`,                           bg:"#dbeafe", color:"#1e40af" },
          { label:"Quotes Sent",     val:stats.sent,         sub:fmt(stats.pipeline)+" in pipeline",                   bg:"#fef3c7", color:"#92400e" },
          { label:"Jobs Won",        val:stats.won,          sub:`${stats.total?Math.round(stats.won/stats.total*100):0}% conversion`, bg:"#d1fae5", color:"#065f46" },
          { label:"Revenue (Won)",   val:fmt(stats.revenue), sub:"All time total",                                     bg:"#ede9fe", color:"#5b21b6" },
        ].map(c=>(
          <div key={c.label} style={s.card}>
            <div style={{fontSize:11,color:"#64748b",textTransform:"uppercase",letterSpacing:.5,marginBottom:8}}>{c.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:26,fontWeight:800}}>{c.val}</div>
            <div style={{display:"inline-flex",alignItems:"center",marginTop:6,fontSize:11,padding:"2px 8px",borderRadius:12,background:c.bg,color:c.color}}>{c.sub}</div>
          </div>
        ))}
      </div>

      <div style={s.grid2r}>
        <div>
          <div style={s.card}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
              <span style={{fontWeight:700,fontSize:14}}>Recent Projects</span>
              <Btn sm onClick={()=>setView("projects")}>View all</Btn>
            </div>
            {recent.map(p=>{
              const cust = customers.find(c=>c.id===p.customerId)
              const st = STATUS_STYLE[p.status]
              return (
                <div key={p.id} onClick={()=>openProject(p)} style={{display:"flex",alignItems:"center",gap:14,padding:"11px 0",borderBottom:"1px solid #f1f5f9",cursor:"pointer"}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:st.dot,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:500,fontSize:13,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{cust?.name||"—"}</div>
                    <div style={{fontSize:11,color:"#64748b",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.address}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <StatusBadge status={p.status}/>
                    <div style={{fontSize:11,color:"#64748b",marginTop:3}}>{p.estimate ? fmt(p.estimate.total) : "No estimate"}</div>
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{...s.card, marginTop:16}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:16}}>Pipeline by Stage</div>
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

        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div style={s.card}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:14}}>Pipeline Summary</div>
            {STATUSES.map(st=>(
              <div key={st} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid #f1f5f9"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"#475569"}}>
                  <span style={{width:8,height:8,borderRadius:"50%",background:STATUS_STYLE[st].dot,display:"inline-block"}}/>
                  {st}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:12,color:"#64748b"}}>{projects.filter(p=>p.status===st).length} jobs</span>
                  <span style={{fontWeight:700,fontSize:13}}>{fmt(projects.filter(p=>p.status===st).reduce((a,p)=>a+(p.estimate?.total||0),0))}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={s.card}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>Quick Actions</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {/* FIX: open wizard instead of navigating to nonexistent "new" view */}
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

// ─────────────────────────── MODULE 1: ROOF MEASUREMENT TOOL ───────────────────────────
const SEC_COLORS = ["#3b82f6","#10b981","#8b5cf6","#f59e0b","#ef4444","#06b6d4","#f97316","#84cc16","#ec4899","#14b8a6"]
const PEN_TYPES  = ["skylight","pipe","flue","vent","other"]
const PEN_COLORS = { skylight:"#f59e0b", pipe:"#94a3b8", flue:"#ef4444", vent:"#10b981", other:"#8b5cf6" }

function parsePitch(str) {
  if(!str||str==="") return 1.0
  const m = String(str).match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/)
  if(m) return Math.sqrt(parseFloat(m[1])**2+parseFloat(m[2])**2)/parseFloat(m[2])
  const d = parseFloat(str)
  if(!isNaN(d) && d<=5)  return d
  if(!isNaN(d) && d<90)  return 1/Math.cos(d*Math.PI/180)
  return 1.15
}
function polyAreaPx(pts) {
  let sum=0; const n=pts.length
  for(let i=0;i<n;i++){const j=(i+1)%n;sum+=pts[i].x*pts[j].y-pts[j].x*pts[i].y}
  return Math.abs(sum/2)
}
function linelenPx(pts) {
  let l=0
  for(let i=0;i<pts.length-1;i++) l+=Math.sqrt((pts[i+1].x-pts[i].x)**2+(pts[i+1].y-pts[i].y)**2)
  return l
}

// FIX: renamed prop to onGeometryChange (was broken — component internally used onGeometryChange but caller passed onAreaChange)
function MeasurementTool({ onGeometryChange }) {
  const canvasRef   = useRef(null)
  const imgRef      = useRef(null)
  const [imgSrc,    setImgSrc]    = useState(null)
  const [sections,  setSections]  = useState([])
  const [lineItems, setLineItems] = useState([])
  const [ptItems,   setPtItems]   = useState([])
  const [scaleLine, setScaleLine] = useState(null)
  const [knownM,    setKnownM]    = useState(10)
  const [asbestos,  setAsbestos]  = useState(false)
  const [activeTool,setActiveTool]= useState("section")
  const [penSub,    setPenSub]    = useState("pipe")
  const [drawPts,   setDrawPts]   = useState([])
  const [hoverPt,   setHoverPt]   = useState(null)

  const mPerPx = useMemo(()=>{
    if(!scaleLine?.p1||!scaleLine?.p2) return null
    const px=Math.sqrt((scaleLine.p2.x-scaleLine.p1.x)**2+(scaleLine.p2.y-scaleLine.p1.y)**2)
    return px>0 ? scaleLine.knownM/px : null
  },[scaleLine])

  const geometry = useMemo(()=>{
    const sf = mPerPx || 0.05
    const processedSections = sections.map((sec)=>{
      const fpPx = sec.closed ? polyAreaPx(sec.pts) : 0
      const fp   = fpPx*sf*sf
      const fac  = parsePitch(sec.pitch||"1.15")
      return {
        id:sec.id, name:sec.name, pitch:sec.pitch,
        shape_points:sec.pts,
        footprint_m2: parseFloat(fp.toFixed(2)),
        surface_m2:   parseFloat((fp*fac).toFixed(2)),
        pitchFactor:  parseFloat(fac.toFixed(3)),
        edges:[]
      }
    })
    const flashings = lineItems.filter(l=>l.type==="flashing").map(l=>({...l,length_m:parseFloat((linelenPx(l.pts)*sf).toFixed(2))}))
    const gutters   = lineItems.filter(l=>l.type==="gutter").map(l=>({...l,length_m:parseFloat((linelenPx(l.pts)*sf).toFixed(2))}))
    const downpipes = ptItems.filter(p=>p.type==="downpipe")
    const drains    = ptItems.filter(p=>p.type==="drain")
    const pens      = ptItems.filter(p=>p.type==="penetration")
    return {
      sections: processedSections,
      accessories:{ flashings, gutters, downpipes, drains, penetrations:pens },
      asbestos,
      scale_m_per_px: parseFloat(sf.toFixed(6)),
      total_footprint_m2: parseFloat(processedSections.reduce((a,sec)=>a+sec.footprint_m2,0).toFixed(2)),
      total_surface_m2:   parseFloat(processedSections.reduce((a,sec)=>a+sec.surface_m2,0).toFixed(2)),
      total_flashing_m:   parseFloat(flashings.reduce((a,f)=>a+f.length_m,0).toFixed(2)),
      total_gutter_m:     parseFloat(gutters.reduce((a,g)=>a+g.length_m,0).toFixed(2)),
    }
  },[sections,lineItems,ptItems,asbestos,mPerPx])

  // FIX: added onGeometryChange to deps
  useEffect(()=>{ onGeometryChange?.(geometry) },[geometry, onGeometryChange])

  const drawCanvas = useCallback(()=>{
    const cv=canvasRef.current; if(!cv)return
    const ctx=cv.getContext("2d"); const W=cv.width,H=cv.height
    ctx.clearRect(0,0,W,H)

    if(imgRef.current){ ctx.drawImage(imgRef.current,0,0,W,H) }
    else{
      ctx.fillStyle="#1e293b"; ctx.fillRect(0,0,W,H)
      ctx.strokeStyle="rgba(255,255,255,0.04)"; ctx.lineWidth=1
      for(let x=0;x<W;x+=20){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke()}
      for(let y=0;y<H;y+=20){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke()}
      ctx.fillStyle="rgba(255,255,255,0.09)"; ctx.font="12px DM Sans"; ctx.textAlign="center"
      ctx.fillText("Upload a roof photo or aerial image above",W/2,H/2-10)
      ctx.fillText("then click to trace sections, flashings & accessories",W/2,H/2+10)
    }

    sections.forEach((sec,idx)=>{
      if(!sec.pts.length) return
      const col=sec.color
      ctx.strokeStyle=col; ctx.lineWidth=2
      ctx.setLineDash(sec.closed?[]:[6,3])
      ctx.beginPath(); ctx.moveTo(sec.pts[0].x,sec.pts[0].y)
      sec.pts.forEach(p=>ctx.lineTo(p.x,p.y))
      if(sec.closed) ctx.closePath()
      ctx.stroke()
      if(sec.closed){ctx.fillStyle=col+"2a";ctx.fill()}
      ctx.setLineDash([])
      sec.pts.forEach((p,i)=>{
        ctx.fillStyle=i===0?col:"#fff"; ctx.beginPath(); ctx.arc(p.x,p.y,i===0?5:3,0,Math.PI*2); ctx.fill()
        ctx.strokeStyle=col; ctx.lineWidth=1.5; ctx.beginPath(); ctx.arc(p.x,p.y,i===0?5:3,0,Math.PI*2); ctx.stroke()
      })
      if(sec.closed){
        const cx=sec.pts.reduce((a,p)=>a+p.x,0)/sec.pts.length
        const cy=sec.pts.reduce((a,p)=>a+p.y,0)/sec.pts.length
        ctx.fillStyle="rgba(0,0,0,0.6)"; ctx.beginPath()
        ctx.roundRect&&ctx.roundRect(cx-36,cy-14,72,28,4); ctx.fill()
        ctx.fillStyle="#fff"; ctx.font="bold 11px DM Sans"; ctx.textAlign="center"
        ctx.fillText(sec.name||`Sec ${idx+1}`,cx,cy-2)
        const gs=geometry.sections[idx]
        if(gs?.surface_m2){ctx.font="9px DM Sans";ctx.fillStyle=col;ctx.fillText(gs.surface_m2+" m²",cx,cy+12)}
      }
    })

    if(activeTool==="section"&&drawPts.length>0){
      const col=SEC_COLORS[sections.length%SEC_COLORS.length]
      ctx.strokeStyle=col; ctx.lineWidth=2; ctx.setLineDash([6,3])
      ctx.beginPath(); ctx.moveTo(drawPts[0].x,drawPts[0].y)
      drawPts.forEach(p=>ctx.lineTo(p.x,p.y))
      if(hoverPt) ctx.lineTo(hoverPt.x,hoverPt.y)
      ctx.stroke(); ctx.setLineDash([])
      drawPts.forEach((p,i)=>{
        ctx.fillStyle=i===0?col:"#fff"; ctx.beginPath(); ctx.arc(p.x,p.y,i===0?6:3.5,0,Math.PI*2); ctx.fill()
        if(i===0){ctx.strokeStyle="#fff88f";ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(p.x,p.y,10,0,Math.PI*2);ctx.stroke()}
      })
    }

    lineItems.forEach(li=>{
      ctx.strokeStyle=li.type==="flashing"?"#f59e0b":"#06b6d4"
      ctx.lineWidth=2.5; ctx.setLineDash(li.type==="flashing"?[8,4]:[4,2])
      ctx.beginPath(); li.pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y)); ctx.stroke()
      ctx.setLineDash([])
      li.pts.forEach(p=>{ctx.fillStyle=li.type==="flashing"?"#f59e0b":"#06b6d4";ctx.beginPath();ctx.arc(p.x,p.y,3,0,Math.PI*2);ctx.fill()})
    })

    if((activeTool==="flashing"||activeTool==="gutter")&&drawPts.length>0){
      const col=activeTool==="flashing"?"#f59e0b":"#06b6d4"
      ctx.strokeStyle=col; ctx.lineWidth=2.5; ctx.setLineDash(activeTool==="flashing"?[8,4]:[4,2])
      ctx.beginPath(); ctx.moveTo(drawPts[0].x,drawPts[0].y)
      drawPts.forEach(p=>ctx.lineTo(p.x,p.y))
      if(hoverPt) ctx.lineTo(hoverPt.x,hoverPt.y)
      ctx.stroke(); ctx.setLineDash([])
    }

    ptItems.forEach(pi=>{
      if(pi.type==="downpipe"){
        ctx.fillStyle="#0ea5e9"; ctx.strokeStyle="#0284c7"; ctx.lineWidth=1.5
        ctx.beginPath(); ctx.arc(pi.x,pi.y,8,0,Math.PI*2); ctx.fill(); ctx.stroke()
        ctx.fillStyle="#fff"; ctx.font="bold 7px DM Sans"; ctx.textAlign="center"; ctx.fillText("DP",pi.x,pi.y+3)
      } else if(pi.type==="drain"){
        ctx.fillStyle="#6366f1"; ctx.strokeStyle="#4f46e5"; ctx.lineWidth=1.5
        ctx.beginPath(); ctx.arc(pi.x,pi.y,8,0,Math.PI*2); ctx.fill(); ctx.stroke()
        ctx.fillStyle="#fff"; ctx.font="bold 7px DM Sans"; ctx.textAlign="center"; ctx.fillText("DR",pi.x,pi.y+3)
      } else if(pi.type==="penetration"){
        const col=PEN_COLORS[pi.subtype]||"#8b5cf6"
        ctx.fillStyle=col; ctx.strokeStyle="#fff"; ctx.lineWidth=1.5
        ctx.beginPath(); const r=7
        ctx.moveTo(pi.x,pi.y-r);ctx.lineTo(pi.x+r,pi.y);ctx.lineTo(pi.x,pi.y+r);ctx.lineTo(pi.x-r,pi.y)
        ctx.closePath(); ctx.fill(); ctx.stroke()
        ctx.fillStyle="#fff"; ctx.font="bold 7px DM Sans"; ctx.textAlign="center"
        ctx.fillText(pi.subtype[0].toUpperCase(),pi.x,pi.y+2.5)
      }
    })

    if(scaleLine?.p1){
      ctx.strokeStyle="#10b981"; ctx.lineWidth=2.5; ctx.setLineDash([])
      ctx.beginPath(); ctx.moveTo(scaleLine.p1.x,scaleLine.p1.y)
      const p2=scaleLine.p2||(activeTool==="scale"?hoverPt:null)
      if(p2) ctx.lineTo(p2.x,p2.y)
      ctx.stroke()
      const tick=p=>{ctx.beginPath();ctx.moveTo(p.x,p.y-8);ctx.lineTo(p.x,p.y+8);ctx.stroke()}
      tick(scaleLine.p1)
      if(scaleLine.p2){
        tick(scaleLine.p2)
        const mx=(scaleLine.p1.x+scaleLine.p2.x)/2,my=(scaleLine.p1.y+scaleLine.p2.y)/2
        ctx.fillStyle="#10b981"
        try{ctx.beginPath();ctx.roundRect(mx-22,my-10,44,16,4);ctx.fill()}catch{ctx.fillRect(mx-22,my-10,44,16)}
        ctx.fillStyle="#fff"; ctx.font="bold 10px DM Sans"; ctx.textAlign="center"
        ctx.fillText(scaleLine.knownM+"m",mx,my+1)
      }
    }

    if(hoverPt&&["downpipe","drain","penetration"].includes(activeTool)){
      ctx.strokeStyle="rgba(255,255,255,0.35)"; ctx.lineWidth=1; ctx.setLineDash([4,2])
      ctx.beginPath();ctx.moveTo(hoverPt.x-14,hoverPt.y);ctx.lineTo(hoverPt.x+14,hoverPt.y);ctx.stroke()
      ctx.beginPath();ctx.moveTo(hoverPt.x,hoverPt.y-14);ctx.lineTo(hoverPt.x,hoverPt.y+14);ctx.stroke()
      ctx.setLineDash([])
    }
  },[sections,lineItems,ptItems,activeTool,drawPts,hoverPt,scaleLine,geometry,imgSrc])

  useEffect(()=>{ drawCanvas() },[drawCanvas])

  const getPt = e=>{ const r=canvasRef.current.getBoundingClientRect(); return{x:e.clientX-r.left,y:e.clientY-r.top} }
  function handleMouseMove(e){ setHoverPt(getPt(e)) }
  function handleMouseLeave(){ setHoverPt(null) }

  function handleClick(e){
    const pt=getPt(e)
    if(activeTool==="section"){
      if(drawPts.length>=3){
        const fp=drawPts[0], d=Math.hypot(pt.x-fp.x,pt.y-fp.y)
        if(d<15){
          setSections(prev=>[...prev,{id:uid(),name:`Section ${prev.length+1}`,pts:drawPts,closed:true,pitch:"1.15",color:SEC_COLORS[prev.length%SEC_COLORS.length]}])
          setDrawPts([]); return
        }
      }
      setDrawPts(prev=>[...prev,pt])
    }
    else if(activeTool==="flashing"||activeTool==="gutter"){
      setDrawPts(prev=>[...prev,pt])
    }
    else if(activeTool==="downpipe")   { setPtItems(prev=>[...prev,{id:uid(),type:"downpipe",  x:pt.x,y:pt.y}]) }
    else if(activeTool==="drain")      { setPtItems(prev=>[...prev,{id:uid(),type:"drain",     x:pt.x,y:pt.y}]) }
    else if(activeTool==="penetration"){ setPtItems(prev=>[...prev,{id:uid(),type:"penetration",subtype:penSub,x:pt.x,y:pt.y}]) }
    else if(activeTool==="scale"){
      if(!scaleLine?.p1)       setScaleLine({p1:pt,p2:null,knownM})
      else if(!scaleLine?.p2){ setScaleLine(prev=>({...prev,p2:pt})); setActiveTool("section") }
    }
  }

  function finishLine(){
    if(drawPts.length>=2) setLineItems(prev=>[...prev,{id:uid(),type:activeTool,pts:drawPts}])
    setDrawPts([])
  }

  function clearAll(){
    setSections([]); setLineItems([]); setPtItems([])
    setScaleLine(null); setDrawPts([]); setAsbestos(false)
  }

  function loadImage(file){
    const r=new FileReader()
    r.onload=e=>{
      const img=new Image()
      img.onload=()=>{imgRef.current=img;drawCanvas()}
      img.src=e.target.result; setImgSrc(e.target.result)
    }
    r.readAsDataURL(file)
  }

  const TOOLS=[
    {key:"section",    label:"Roof Section", icon:"▲", color:"#3b82f6", hint:"Click to add points · click first point (⭕) to close polygon"},
    {key:"flashing",   label:"Flashing",     icon:"⚡", color:"#f59e0b", hint:"Click points to trace flashing lines · press Done ✓ to finish"},
    {key:"gutter",     label:"Gutter",       icon:"〰", color:"#06b6d4", hint:"Click points to trace gutters · press Done ✓ to finish"},
    {key:"downpipe",   label:"Downpipe",     icon:"⬇", color:"#0ea5e9", hint:"Click canvas to place a downpipe (DP) marker"},
    {key:"drain",      label:"Roof Drain",   icon:"⊙", color:"#6366f1", hint:"Click canvas to place a roof drain (DR) marker"},
    {key:"penetration",label:"Penetration",  icon:"◇", color:"#8b5cf6", hint:"Click to place — select type below"},
    {key:"scale",      label:"Set Scale",    icon:"📏", color:"#10b981", hint:"Click two points over a known dimension, then enter the real length"},
  ]
  const tip=TOOLS.find(t=>t.key===activeTool)?.hint||""

  return (
    <div>
      <div style={{border:"2px dashed #e2e8f0",borderRadius:10,padding:"13px 18px",cursor:"pointer",marginBottom:12,background:"#f8fafc",display:"flex",alignItems:"center",justifyContent:"space-between"}}
        onClick={()=>document.getElementById("mt-upload").click()}>
        <input id="mt-upload" type="file" accept="image/*" style={{display:"none"}} onChange={e=>e.target.files[0]&&loadImage(e.target.files[0])}/>
        <span style={{fontSize:13,color:"#64748b"}}>📷 Upload aerial or site photo <span style={{color:"#94a3b8",fontSize:11}}>(JPG / PNG / HEIC)</span></span>
        {imgSrc
          ? <span style={{fontSize:11,color:"#10b981",fontWeight:500}}>✓ Photo loaded</span>
          : <span style={{fontSize:11,color:"#94a3b8"}}>or draw on blank canvas →</span>}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 250px",gap:12}}>
        <div style={{border:"1px solid #334155",borderRadius:12,overflow:"hidden"}}>
          <div style={{display:"flex",alignItems:"center",gap:5,padding:"8px 10px",background:"#1e293b",flexWrap:"wrap"}}>
            {TOOLS.map(t=>(
              <button key={t.key}
                onClick={()=>{setActiveTool(t.key);setDrawPts([])}}
                style={{padding:"5px 9px",borderRadius:6,
                  border:`1px solid ${activeTool===t.key?t.color:"rgba(255,255,255,0.14)"}`,
                  background:activeTool===t.key?t.color+"28":"transparent",
                  color:activeTool===t.key?t.color:"#94a3b8",
                  fontSize:11,fontWeight:activeTool===t.key?600:400,cursor:"pointer",
                  display:"flex",alignItems:"center",gap:4,fontFamily:"inherit"}}>
                <span>{t.icon}</span>{t.label}
              </button>
            ))}
            <div style={{marginLeft:"auto",display:"flex",gap:5}}>
              {(activeTool==="flashing"||activeTool==="gutter")&&drawPts.length>=2&&(
                <button onClick={finishLine} style={{padding:"5px 10px",borderRadius:6,border:"1px solid #10b981",background:"#10b981",color:"#fff",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                  Done ✓
                </button>
              )}
              <button onClick={clearAll} style={{padding:"5px 10px",borderRadius:6,border:"1px solid rgba(255,255,255,0.15)",background:"transparent",color:"#64748b",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>
                Clear All
              </button>
            </div>
          </div>

          <div style={{padding:"5px 12px",background:"#0f172a",fontSize:11,color:"#475569",display:"flex",alignItems:"center",justifyContent:"space-between",minHeight:28}}>
            <span>{tip}</span>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              {activeTool==="penetration"&&(
                <div style={{display:"flex",gap:4}}>
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
              {activeTool==="scale"&&!scaleLine?.p2&&(
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <span style={{color:"#64748b",fontSize:10}}>Known length:</span>
                  <input type="number" value={knownM} onChange={e=>setKnownM(parseFloat(e.target.value)||10)}
                    style={{width:46,padding:"1px 5px",background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:4,color:"#fff",fontSize:11}}/>
                  <span style={{color:"#64748b",fontSize:10}}>m</span>
                </div>
              )}
            </div>
          </div>

          <canvas ref={canvasRef} width={490} height={330}
            style={{display:"block",cursor:["section","flashing","gutter","scale"].includes(activeTool)?"crosshair":"cell"}}
            onClick={handleClick} onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}/>

          <div style={{padding:"7px 12px",background:"#0f172a",display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{fontSize:11}}>
              <span style={{color:"#475569"}}>Scale: </span>
              <span style={{color:mPerPx?"#10b981":"#f59e0b",fontWeight:600}}>
                {mPerPx?`1px = ${(mPerPx*100).toFixed(1)}cm`:"Not calibrated (using 5cm/px default)"}
              </span>
            </div>
            <div style={{fontSize:11}}>
              <span style={{color:"#475569"}}>Surface area: </span>
              <span style={{color:"#f59e0b",fontWeight:700,fontSize:13}}>{geometry.total_surface_m2} m²</span>
            </div>
            <span style={{fontSize:11,color:"#475569",marginLeft:"auto"}}>{drawPts.length>0?`Drawing: ${drawPts.length} pts`:""}</span>
          </div>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:10,overflowY:"auto",maxHeight:420}}>
          <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:10,padding:12}}>
            <div style={{fontSize:11,fontWeight:600,color:"#64748b",textTransform:"uppercase",letterSpacing:.5,marginBottom:10}}>Roof Sections</div>
            {sections.length===0&&<div style={{fontSize:11,color:"#94a3b8",textAlign:"center",padding:"8px 0"}}>No sections yet — use ▲ Section tool</div>}
            {sections.map((sec,idx)=>{
              const gs=geometry.sections[idx]
              return(
                <div key={sec.id} style={{marginBottom:10,paddingBottom:10,borderBottom:"1px solid #f1f5f9"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                    <div style={{width:10,height:10,borderRadius:2,background:sec.color,flexShrink:0}}/>
                    <input value={sec.name}
                      onChange={e=>setSections(prev=>prev.map(x=>x.id===sec.id?{...x,name:e.target.value}:x))}
                      style={{flex:1,padding:"2px 6px",border:"1px solid #e2e8f0",borderRadius:4,fontSize:11,fontFamily:"inherit"}}/>
                    <button onClick={()=>setSections(prev=>prev.filter(x=>x.id!==sec.id))}
                      style={{padding:"1px 6px",border:"none",background:"#fee2e2",color:"#ef4444",borderRadius:4,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{fontSize:10,color:"#64748b",width:30,flexShrink:0}}>Pitch</span>
                    <input value={sec.pitch}
                      onChange={e=>setSections(prev=>prev.map(x=>x.id===sec.id?{...x,pitch:e.target.value}:x))}
                      placeholder="4:12 or 30°"
                      style={{width:62,padding:"2px 6px",border:"1px solid #e2e8f0",borderRadius:4,fontSize:11,fontFamily:"inherit"}}/>
                    <span style={{fontSize:10,color:"#94a3b8"}}>×{gs?.pitchFactor||1}</span>
                  </div>
                  <div style={{marginTop:5,fontSize:11,color:"#64748b",display:"flex",justifyContent:"space-between"}}>
                    <span>Plan: {gs?.footprint_m2||0} m²</span>
                    <span style={{color:sec.color,fontWeight:700}}>Surf: {gs?.surface_m2||0} m²</span>
                  </div>
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
    </div>
  )
}

// ─────────────────────────── ESTIMATE ENGINE ───────────────────────────
function EstimateEngine({ initialArea, onEstimateChange }) {
  const [e, setE] = useState({
    area:initialArea||0, pitch:1.15, waste:10,
    materialRate:55, materialLabel:"Long Run Steel",
    flashings:0, guttering:0, dayRate:850, days:2, margin:20,
  })

  const result = useMemo(()=>calcEst(e),[e])
  // FIX: added onEstimateChange to deps
  useEffect(()=>{ onEstimateChange?.(result) },[result, onEstimateChange])

  const upd = k => v => setE(prev=>({...prev,[k]:typeof v==="number"?v:parseFloat(v)||0}))

  const row = (label,val,bold,accent) => (
    <div style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid rgba(255,255,255,0.07)",fontSize:13}}>
      <span style={{color:bold?"#fff":"#94a3b8"}}>{label}</span>
      <span style={{fontWeight:bold?700:500,color:accent?"#f59e0b":"#fff"}}>{val}</span>
    </div>
  )

  return (
    <div style={s.grid2}>
      <div>
        <div style={{...s.card,marginBottom:14}}>
          <div style={{fontWeight:700,marginBottom:14}}>Roof Dimensions</div>
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
        </div>
        <div style={{...s.card,marginBottom:14}}>
          <div style={{fontWeight:700,marginBottom:14}}>Materials</div>
          <FG label="Material Type">
            <select style={s.input} onChange={ev=>{
              const m=MATERIALS.find(x=>x.label===ev.target.value)
              if(m) setE(prev=>({...prev,materialLabel:m.label,materialRate:m.rate}))
            }} value={e.materialLabel}>
              {MATERIALS.map(m=><option key={m.label} value={m.label}>{m.label} — ${m.rate}/m²</option>)}
            </select>
          </FG>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <FG label={`Flashings (m) @ $${RATES.flashings}/m`}><input style={s.input} type="number" value={e.flashings} onChange={ev=>upd("flashings")(ev.target.value)}/></FG>
            <FG label={`Guttering (m) @ $${RATES.guttering}/m`}><input style={s.input} type="number" value={e.guttering} onChange={ev=>upd("guttering")(ev.target.value)}/></FG>
          </div>
        </div>
        <div style={s.card}>
          <div style={{fontWeight:700,marginBottom:14}}>Labour & Margin</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <FG label="Day Rate ($)"><input style={s.input} type="number" value={e.dayRate} onChange={ev=>upd("dayRate")(ev.target.value)}/></FG>
            <FG label="Est. Days"><input style={s.input} type="number" step="0.5" value={e.days} onChange={ev=>upd("days")(ev.target.value)}/></FG>
          </div>
          <FG label="Margin %"><input style={s.input} type="number" value={e.margin} onChange={ev=>upd("margin")(ev.target.value)}/></FG>
        </div>
      </div>

      <div>
        <div style={{background:"#0f172a",borderRadius:12,padding:20,color:"#fff"}}>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:15,fontWeight:800,marginBottom:16,color:"#f59e0b"}}>Cost Breakdown</div>
          {row(`Material (${result.adjArea.toFixed(1)} m² × $${e.materialRate})`, fmt(result.matCost))}
          {row(`Flashings (${e.flashings}m × $${RATES.flashings})`, fmt(result.flashCost))}
          {row(`Guttering (${e.guttering}m × $${RATES.guttering})`, fmt(result.gutCost))}
          {row(`Labour (${e.days} days × $${e.dayRate})`, fmt(result.labCost))}
          {row(`Margin (${e.margin}%)`, fmt(result.marginAmt))}
          <div style={{borderTop:"1px solid rgba(255,255,255,0.15)",paddingTop:12,marginTop:4}}>
            {row("Sell Price (excl. GST)", fmt(result.sellPrice), true, true)}
            {row(`GST (${GST_RATE*100}%)`, fmt(result.gst))}
            <div style={{display:"flex",justifyContent:"space-between",padding:"12px 0 0",alignItems:"center"}}>
              <span style={{color:"#fff",fontWeight:700,fontSize:15}}>Total inc. GST</span>
              <span style={{fontFamily:"'Syne',sans-serif",fontSize:24,fontWeight:800,color:"#f59e0b"}}>{fmt(result.total)}</span>
            </div>
          </div>
        </div>
        <div style={{...s.card,marginTop:14}}>
          <div style={{fontWeight:600,fontSize:13,marginBottom:10}}>Material Summary</div>
          <div style={{fontSize:12,color:"#64748b",lineHeight:2}}>
            <div>Adjusted area: <strong style={{color:"#0f172a"}}>{result.adjArea.toFixed(1)} m²</strong></div>
            <div>Material: <strong style={{color:"#0f172a"}}>{e.materialLabel} @ ${e.materialRate}/m²</strong></div>
            <div>Flashings: <strong style={{color:"#0f172a"}}>{e.flashings}m @ ${RATES.flashings}/m</strong></div>
            <div>Guttering: <strong style={{color:"#0f172a"}}>{e.guttering}m @ ${RATES.guttering}/m</strong></div>
            <div>Labour: <strong style={{color:"#0f172a"}}>{e.days} days @ ${e.dayRate}/day</strong></div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── QUOTE VIEW ───────────────────────────
// FIX: accepts company from settings instead of reading dead COMPANY constant
function QuoteView({ project, customer, company }) {
  if(!project||!customer) return <div style={{color:"#64748b",padding:20}}>No project selected.</div>
  const e = project.estimate
  if(!e) return <div style={{color:"#64748b",padding:20}}>No estimate available. Complete the estimate step first.</div>

  const qn  = project.quoteNum || "DRAFT"
  const qd  = project.quoteDate || today()
  const exp = new Date(new Date(qd.slice(0,10)+"T12:00:00").getTime()+30*86400000).toISOString().slice(0,10)

  // FIX: use RATES constant instead of magic numbers
  const quoteLines = [
    { desc:`${e.materialLabel} roofing — supply & install`, qty:`${e.adjArea?.toFixed(1)} m²`,     unit:`$${e.materialRate}`,       total:e.matCost   },
    { desc:"Flashings — ridge/hip/valley",                  qty:`${e.flashings}m`,                  unit:`$${RATES.flashings}/m`,    total:e.flashCost },
    { desc:"Guttering & downpipes",                         qty:`${e.guttering}m`,                  unit:`$${RATES.guttering}/m`,    total:e.gutCost   },
    { desc:`Labour — installation (${e.days} days)`,        qty:"—",                                unit:"—",                        total:e.labCost   },
  ].filter(l=>l.total>0)

  return (
    <div style={{maxWidth:660,background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:28,paddingBottom:22,borderBottom:"2px solid #e2e8f0"}}>
        <div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:24,fontWeight:800}}>{company.companyName}</div>
          <div style={{fontSize:12,color:"#64748b",marginTop:5,lineHeight:1.9}}>
            {company.companyAddress}<br/>{company.companyEmail} · {company.companyPhone}<br/>GST No: {company.companyGst}
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

      <div style={{marginBottom:20}}>
        <div style={{fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#64748b",marginBottom:10}}>Line Items</div>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead>
            <tr>
              {["Description","Qty","Unit","Total"].map(h=>(
                <th key={h} style={{textAlign:h==="Total"||h==="Unit"?"right":"left",padding:"8px 10px",fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#64748b",borderBottom:"1px solid #e2e8f0"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {quoteLines.map((li,i)=>(
              <tr key={i}>
                <td style={{padding:"10px",borderBottom:"1px solid #f1f5f9"}}>{li.desc}</td>
                <td style={{padding:"10px",borderBottom:"1px solid #f1f5f9",whiteSpace:"nowrap"}}>{li.qty}</td>
                <td style={{padding:"10px",borderBottom:"1px solid #f1f5f9",textAlign:"right"}}>{li.unit}</td>
                <td style={{padding:"10px",borderBottom:"1px solid #f1f5f9",textAlign:"right",fontWeight:500}}>{fmt(li.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{display:"flex",justifyContent:"flex-end"}}>
        <div style={{minWidth:240}}>
          {[["Subtotal (excl. GST)", fmt(e.sellPrice)],[`GST (${GST_RATE*100}%)`, fmt(e.gst)]].map(([l,v])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #f1f5f9",fontSize:13}}>
              <span style={{color:"#64748b"}}>{l}</span><span style={{fontWeight:500}}>{v}</span>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:14}}>
            <span style={{fontWeight:700,fontSize:15}}>Total inc. GST</span>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:26,fontWeight:800}}>{fmt(e.total)}</div>
              <div style={{fontSize:11,color:"#64748b"}}>New Zealand Dollars</div>
            </div>
          </div>
        </div>
      </div>

      <div style={{borderTop:"1px solid #e2e8f0",paddingTop:18,marginTop:18}}>
        <div style={{fontSize:11,color:"#94a3b8",lineHeight:2}}>
          <strong style={{color:"#64748b"}}>Terms:</strong> 50% deposit on acceptance. Balance on completion within 7 days of invoice.<br/>
          <strong style={{color:"#64748b"}}>Payment:</strong> Bank transfer to {company.companyName} — {company.companyBank}<br/>
          <strong style={{color:"#64748b"}}>Validity:</strong> This quote is valid for 30 days from date of issue. Subject to site inspection.
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── NEW PROJECT WIZARD ───────────────────────────
function NewProjectWizard({ customers, projects, onSave, onCancel, existingProject, company }) {
  const [step,    setStep]    = useState(0)
  const [saving,  setSaving]  = useState(false)
  const [form,    setForm]    = useState(existingProject || {
    customerId:"", address:"", roofType:"Long Run Steel", status:"New Lead", notes:"",
  })
  const [newCust, setNewCust] = useState({ name:"", email:"", phone:"", address:"" })
  const [isNewCust, setIsNewCust] = useState(false)
  const [area,     setArea]     = useState(existingProject?.area||null)
  const [estimate, setEstimate] = useState(existingProject?.estimate||null)

  const STEPS = ["Customer","Measure","Estimate","Quote & Save"]
  const isEdit = !!existingProject

  async function save() {
    setSaving(true)
    let cid = form.customerId
    let pendingNewCust = null
    if(isNewCust && newCust.name) {
      pendingNewCust = newCust
      cid = uid() // temporary; real ID comes from API in handleSaveProject
    }
    const project = {
      ...form,
      id: existingProject?.id || uid(),
      customerId: cid,
      area: area||0,
      estimate,
      quoteNum:  existingProject?.quoteNum  || (estimate ? nextQuoteNum(projects) : ""),
      quoteDate: existingProject?.quoteDate || (estimate ? today() : ""),
      createdAt: existingProject?.createdAt || today(),
    }
    await onSave(project, pendingNewCust)
    setSaving(false)
  }

  const upd = k => v => setForm(prev=>({...prev,[k]:v}))

  const canNext = [
    isNewCust ? newCust.name && newCust.phone : form.customerId,
    true, true, true,
  ]

  const stepNext = () => setStep(n=>n+1)
  const stepBack = () => setStep(n=>n-1)

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:0,marginBottom:24}}>
        {STEPS.map((label,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",flex:i<STEPS.length-1?1:"auto"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}} onClick={()=>i<step&&setStep(i)}>
              <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,
                background:i===step?"#f59e0b":i<step?"#10b981":"#f1f5f9",
                color:i<=step?"#000":"#94a3b8",transition:"all .2s"}}>{i<step?"✓":i+1}</div>
              <span style={{fontSize:12,fontWeight:i===step?600:400,color:i===step?"#0f172a":i<step?"#10b981":"#94a3b8"}}>{label}</span>
            </div>
            {i<STEPS.length-1&&<div style={{flex:1,height:1,background:i<step?"#10b981":"#e2e8f0",margin:"0 10px"}}/>}
          </div>
        ))}
      </div>

      {step===0 && (
        <div>
          <div style={{display:"flex",gap:10,marginBottom:16}}>
            <Btn onClick={()=>setIsNewCust(false)} style={{border:!isNewCust?"2px solid #f59e0b":"1px solid #e2e8f0",background:!isNewCust?"#fef3c7":""}}>Existing Customer</Btn>
            <Btn onClick={()=>setIsNewCust(true)}  style={{border:isNewCust?"2px solid #f59e0b":"1px solid #e2e8f0",background:isNewCust?"#fef3c7":""}}>+ New Customer</Btn>
          </div>
          {!isNewCust ? (
            <FG label="Select Customer">
              <select style={s.input} value={form.customerId} onChange={e=>upd("customerId")(e.target.value)}>
                <option value="">— Choose customer —</option>
                {customers.map(c=><option key={c.id} value={c.id}>{c.name} · {c.phone}</option>)}
              </select>
            </FG>
          ):(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <FG label="Full Name"><input style={s.input} value={newCust.name} onChange={e=>setNewCust(p=>({...p,name:e.target.value}))} placeholder="Sarah Thompson"/></FG>
              <FG label="Phone"><input style={s.input} value={newCust.phone} onChange={e=>setNewCust(p=>({...p,phone:e.target.value}))} placeholder="021 999 0000"/></FG>
              <FG label="Email"><input style={s.input} value={newCust.email} onChange={e=>setNewCust(p=>({...p,email:e.target.value}))} placeholder="sarah@email.com"/></FG>
              <FG label="Address"><input style={s.input} value={newCust.address} onChange={e=>setNewCust(p=>({...p,address:e.target.value}))} placeholder="123 Main St, Auckland"/></FG>
            </div>
          )}
          <div style={{height:1,background:"#e2e8f0",margin:"18px 0"}}/>
          <FG label="Job Address"><input style={s.input} value={form.address} onChange={e=>upd("address")(e.target.value)} placeholder="47 Ridgeline Ave, Titirangi, Auckland"/></FG>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
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
          <FG label="Notes"><textarea style={{...s.input,resize:"vertical"}} rows={3} value={form.notes} onChange={e=>upd("notes")(e.target.value)} placeholder="Site notes, access details, special requirements..."/></FG>
        </div>
      )}

      {/* FIX: pass onGeometryChange (was broken: passed onAreaChange which component never read) */}
      {step===1 && <MeasurementTool onGeometryChange={g=>setArea(g.total_surface_m2)}/>}

      {step===2 && <EstimateEngine initialArea={area||0} onEstimateChange={setEstimate}/>}

      {step===3 && (
        <div style={{display:"flex",gap:20,alignItems:"flex-start"}}>
          <div style={{flex:1,overflowY:"auto",maxHeight:"55vh"}}>
            <QuoteView
              project={{...form,area,estimate,quoteNum:nextQuoteNum(projects),quoteDate:today()}}
              customer={isNewCust ? newCust : customers.find(c=>c.id===form.customerId)}
              company={company}
            />
          </div>
          <div style={{width:180,flexShrink:0}}>
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

      <div style={{display:"flex",justifyContent:"space-between",marginTop:24,paddingTop:18,borderTop:"1px solid #e2e8f0"}}>
        <Btn onClick={step===0?onCancel:stepBack}>{step===0?"Cancel":"← Back"}</Btn>
        <div style={{display:"flex",gap:10}}>
          {step<STEPS.length-1 && (
            <Btn onClick={stepNext} style={{opacity:canNext[step]?1:.5,pointerEvents:canNext[step]?"auto":"none"}}>
              Skip →
            </Btn>
          )}
          {step<STEPS.length-1
            ? <Btn primary onClick={()=>canNext[step]&&stepNext()}>Next →</Btn>
            : <Btn primary onClick={save}>{saving?"Saving…":(isEdit?"Update Project":"Save Project ✓")}</Btn>
          }
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── PIPELINE ───────────────────────────
function Pipeline({ projects, customers, setProjects, setView, setSelectedProject }) {
  const getCustomer = id => customers.find(c=>c.id===id)

  async function moveStatus(project, newStatus) {
    try {
      await projectsApi.updateStatus(project.id, newStatus)
      setProjects(prev=>prev.map(p=>p.id===project.id?{...p,status:newStatus}:p))
    } catch(err) {
      console.error("Failed to update status:", err)
    }
  }

  return (
    <div style={{overflowX:"auto",paddingBottom:12}}>
      <div style={{display:"flex",gap:14,minWidth:"max-content"}}>
        {STATUSES.map(status=>{
          const cols  = projects.filter(p=>p.status===status)
          const st    = STATUS_STYLE[status]
          const colVal= cols.reduce((a,p)=>a+(p.estimate?.total||0),0)
          return (
            <div key={status} style={{width:220}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderRadius:"10px 10px 0 0",background:st.bg,color:st.color}}>
                <span style={{fontWeight:700,fontSize:12}}>{status}</span>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:11,fontWeight:700}}>{cols.length}</div>
                  {colVal>0&&<div style={{fontSize:10,opacity:.8}}>{fmt(colVal)}</div>}
                </div>
              </div>
              <div style={{border:"1px solid #e2e8f0",borderTop:"none",borderRadius:"0 0 10px 10px",padding:8,minHeight:240,background:"#f8fafc"}}>
                {cols.map(p=>{
                  const cust=getCustomer(p.customerId)
                  return (
                    <div key={p.id} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,padding:12,marginBottom:8,cursor:"pointer",transition:"box-shadow .15s"}}
                      onClick={()=>{ setSelectedProject(p); setView("project") }}>
                      <div style={{fontWeight:600,fontSize:13,marginBottom:2}}>{cust?.name||"—"}</div>
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
                <div style={{textAlign:"center",padding:"8px 0",cursor:"pointer",color:"#94a3b8",fontSize:12}}
                  onClick={()=>setView("new")}>+ Add</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────── PROJECTS LIST ───────────────────────────
function ProjectsList({ projects, customers, setView, setSelectedProject }) {
  const [search,       setSearch]       = useState("")
  const [filterStatus, setFilterStatus] = useState("All")

  const getCustomer = id => customers.find(c=>c.id===id)

  const filtered = projects
    .filter(p=>filterStatus==="All"||p.status===filterStatus)
    .filter(p=>{
      const cust=getCustomer(p.customerId)
      const q=search.toLowerCase()
      return !q || (cust?.name||"").toLowerCase().includes(q) || p.address.toLowerCase().includes(q)
    })
    .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))

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
        <span style={{marginLeft:"auto",fontSize:13,color:"#64748b"}}>{filtered.length} projects</span>
      </div>
      <div style={{...s.card,padding:0,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead>
            <tr>{["Customer","Address","Roof Area","Value","Status","Date",""].map(h=><th key={h} style={s.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {filtered.map(p=>{
              const cust=getCustomer(p.customerId)
              return (
                <tr key={p.id} style={{cursor:"pointer"}} onClick={()=>{ setSelectedProject(p); setView("project") }}>
                  <td style={s.td}><div style={{fontWeight:500}}>{cust?.name||"—"}</div><div style={{fontSize:11,color:"#64748b"}}>{cust?.phone}</div></td>
                  <td style={{...s.td,maxWidth:200}}><div style={{fontSize:12,color:"#64748b",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.address}</div></td>
                  <td style={s.td}>{p.area>0 ? p.area+" m²" : <span style={{color:"#94a3b8"}}>—</span>}</td>
                  <td style={s.td}><span style={{fontWeight:600}}>{p.estimate?fmt(p.estimate.total):<span style={{color:"#94a3b8"}}>—</span>}</span></td>
                  <td style={s.td}><StatusBadge status={p.status}/></td>
                  <td style={{...s.td,color:"#64748b",fontSize:12}}>{fmtD(p.createdAt)}</td>
                  <td style={s.td}><span style={{color:"#3b82f6",fontSize:12}}>View →</span></td>
                </tr>
              )
            })}
            {filtered.length===0&&<tr><td colSpan={7} style={{...s.td,textAlign:"center",color:"#94a3b8",padding:32}}>No projects found</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─────────────────────────── PROJECT DETAIL ───────────────────────────
function ProjectDetail({ project, customers, setProjects, setView, onEdit, company }) {
  if(!project) return null
  const cust = customers.find(c=>c.id===project.customerId)
  const e = project.estimate

  async function updateStatus(newStatus) {
    try {
      await projectsApi.updateStatus(project.id, newStatus)
      setProjects(prev=>prev.map(p=>p.id===project.id?{...p,status:newStatus}:p))
    } catch(err) {
      console.error("updateStatus failed:", err)
    }
  }

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <Btn onClick={()=>setView("projects")}>← Projects</Btn>
        <div style={{flex:1}}/>
        <select value={project.status} onChange={ev=>updateStatus(ev.target.value)}
          style={{padding:"8px 12px",border:"1px solid #e2e8f0",borderRadius:8,fontSize:13,fontFamily:"inherit",cursor:"pointer",background:"#fff"}}>
          {STATUSES.map(st=><option key={st}>{st}</option>)}
        </select>
        <Btn primary onClick={onEdit}>✏ Edit Project</Btn>
      </div>

      <div style={s.grid2}>
        <div>
          <div style={s.card}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:4}}>{cust?.name||"—"}</div>
            <div style={{fontSize:13,color:"#64748b",lineHeight:1.9}}>
              {cust?.email}<br/>{cust?.phone}
            </div>
            <div style={{height:1,background:"#f1f5f9",margin:"14px 0"}}/>
            <div style={{fontSize:12,color:"#64748b",marginBottom:4}}>Job Address</div>
            <div style={{fontSize:13,fontWeight:500}}>{project.address}</div>
            {project.roofType&&<div style={{marginTop:8}}><span style={{fontSize:11,color:"#64748b"}}>Roof Type: </span><span style={{fontSize:12,fontWeight:500}}>{project.roofType}</span></div>}
            {project.area>0&&<div><span style={{fontSize:11,color:"#64748b"}}>Area: </span><span style={{fontSize:12,fontWeight:500}}>{project.area} m²</span></div>}
            {project.notes&&(
              <div style={{marginTop:14,padding:12,background:"#f8fafc",borderRadius:8,fontSize:12,color:"#64748b",lineHeight:1.7}}>
                📋 {project.notes}
              </div>
            )}
          </div>

          {e&&(
            <div style={{...s.card,marginTop:14}}>
              <div style={{fontWeight:700,marginBottom:14}}>Estimate Breakdown</div>
              {[
                ["Adjusted Area",               `${e.adjArea?.toFixed(1)} m²`],
                [`Material (${e.materialLabel})`, fmt(e.matCost)],
                ["Flashings",                   fmt(e.flashCost)],
                ["Guttering",                   fmt(e.gutCost)],
                ["Labour",                      fmt(e.labCost)],
                [`Margin (${e.margin}%)`,        fmt(e.marginAmt)],
              ].map(([l,v])=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #f1f5f9",fontSize:13}}>
                  <span style={{color:"#64748b"}}>{l}</span>
                  <span style={{fontWeight:500}}>{v}</span>
                </div>
              ))}
              <div style={{display:"flex",justifyContent:"space-between",paddingTop:14,alignItems:"center"}}>
                <span style={{fontWeight:700}}>Total inc. GST</span>
                <span style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:800,color:"#f59e0b"}}>{fmt(e.total)}</span>
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
                Amount: <strong style={{color:"#0f172a"}}>{e?fmt(e.total):"—"}</strong>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <Btn full primary onClick={()=>setView("quote_print")}>📄 View Full Quote</Btn>
                <Btn full>📧 Email to Client</Btn>
                <Btn full>🖨 Print</Btn>
              </div>
            </div>
          ):(
            <div style={{...s.card,marginBottom:14,border:"2px dashed #e2e8f0",textAlign:"center",padding:24}}>
              <div style={{fontSize:14,color:"#64748b",marginBottom:12}}>No quote generated yet</div>
              <Btn primary onClick={onEdit}>Generate Quote →</Btn>
            </div>
          )}

          <div style={s.card}>
            <div style={{fontWeight:700,marginBottom:14}}>Timeline</div>
            {[
              { label:"Project Created",     date:project.createdAt,                            color:"#94a3b8" },
              { label:"Estimate Completed",  date:e?project.createdAt:null,                     color:"#8b5cf6" },
              { label:"Quote Sent",          date:project.quoteDate||null,                      color:"#f59e0b" },
              { label:"Won",                 date:project.status==="Won"?project.quoteDate:null, color:"#10b981" },
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
    </div>
  )
}

// ─────────────────────────── CUSTOMERS ───────────────────────────
function Customers({ customers, setCustomers, projects }) {
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
        // FIX: use API response (normalized) instead of local form
        const raw     = await customersApi.update(editCust.id, form)
        const updated = normalizeKeys(raw)
        setCustomers(prev=>prev.map(c=>c.id===editCust.id?{...c,...updated}:c))
      } else {
        // FIX: use API response for real backend-generated ID
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
    } catch(err) {
      console.error("Failed to delete customer:", err)
    }
  }

  return (
    <div>
      <div style={{display:"flex",gap:12,marginBottom:20}}>
        <input style={{...s.input,width:260}} placeholder="Search customers..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <Btn primary onClick={()=>{ setForm({name:"",email:"",phone:"",address:""}); setEditCust(null); setShowNew(true) }}>+ New Customer</Btn>
      </div>
      <div style={{...s.card,padding:0,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
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

      {showNew&&(
        <Modal title={editCust?"Edit Customer":"New Customer"} onClose={closeModal}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <FG label="Full Name *"><input style={s.input} value={form.name} onChange={e=>upd("name")(e.target.value)} placeholder="Sarah Thompson"/></FG>
            <FG label="Phone *"><input style={s.input} value={form.phone} onChange={e=>upd("phone")(e.target.value)} placeholder="021 999 0011"/></FG>
            <FG label="Email"><input style={s.input} value={form.email} onChange={e=>upd("email")(e.target.value)} placeholder="sarah@email.com"/></FG>
            <FG label="Address"><input style={s.input} value={form.address} onChange={e=>upd("address")(e.target.value)} placeholder="47 Main St, Auckland"/></FG>
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

// ─────────────────────────── SETTINGS ───────────────────────────
// FIX: fully controlled component that reads/writes localStorage; "Save Changes" actually works
function Settings({ settings, onSave }) {
  const [form, setForm] = useState(settings)
  const [saved, setSaved] = useState(false)

  const upd = k => e => setForm(prev=>({...prev,[k]:e.target.value}))
  const updNum = k => e => setForm(prev=>({...prev,[k]:parseFloat(e.target.value)||0}))

  function save() {
    onSave(form)
    setSaved(true)
    setTimeout(()=>setSaved(false), 2500)
  }

  return (
    <div style={{maxWidth:600}}>
      <div style={{...s.card,marginBottom:16}}>
        <div style={{fontWeight:700,marginBottom:16}}>Company Profile</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <FG label="Company Name"><input style={s.input} value={form.companyName} onChange={upd("companyName")}/></FG>
          <FG label="GST Number"><input style={s.input} value={form.companyGst} onChange={upd("companyGst")}/></FG>
          <FG label="Phone"><input style={s.input} value={form.companyPhone} onChange={upd("companyPhone")}/></FG>
          <FG label="Email"><input style={s.input} value={form.companyEmail} onChange={upd("companyEmail")}/></FG>
          <FG label="Address"><input style={s.input} value={form.companyAddress} onChange={upd("companyAddress")}/></FG>
          <FG label="Bank Account"><input style={s.input} value={form.companyBank} onChange={upd("companyBank")}/></FG>
        </div>
      </div>
      <div style={{...s.card,marginBottom:16}}>
        <div style={{fontWeight:700,marginBottom:16}}>Default Pricing</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <FG label="Default Day Rate ($)"><input style={s.input} type="number" value={form.dayRate} onChange={updNum("dayRate")}/></FG>
          <FG label="Default Margin %"><input style={s.input} type="number" value={form.margin} onChange={updNum("margin")}/></FG>
          {/* FIX: removed duplicate style prop; GST is read-only display */}
          <FG label="GST Rate %"><input style={{...s.input,background:"#f8fafc",color:"#64748b"}} type="number" value={GST_RATE*100} readOnly/></FG>
          <FG label="Default Wastage %"><input style={s.input} type="number" value={form.wastage} onChange={updNum("wastage")}/></FG>
        </div>
      </div>
      <div style={{...s.card,marginBottom:16}}>
        <div style={{fontWeight:700,marginBottom:14}}>Accessory Rates</div>
        {[
          ["Flashings",    `$${RATES.flashings}/m`],
          ["Guttering",    `$${RATES.guttering}/m`],
          ["Downpipes",    `$${RATES.downpipe}/each`],
          ["Underlayment", `$${RATES.underlayment}/m²`],
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

// ─────────────────────────── APP ───────────────────────────
export default function App() {
  const [view,            setView]           = useState("dashboard")
  const [projects,        setProjects]       = useState([])
  const [customers,       setCustomers]      = useState([])
  const [selectedProject, setSelectedProject]= useState(null)
  const [loaded,          setLoaded]         = useState(false)
  const [toast,           setToast]          = useState(null)
  const [showWizard,      setShowWizard]     = useState(false)
  const [editingProject,  setEditingProject] = useState(null)

  const { user, login, logout } = useAuth()

  // settings must be declared before any early return (Rules of Hooks)
  const [settings, setSettings] = useState(()=>{
    try { return {...DEFAULT_SETTINGS,...JSON.parse(localStorage.getItem("atoproof_settings"))||{}} }
    catch { return DEFAULT_SETTINGS }
  })

  if (!user) return <LoginPage onLogin={login} />

  function saveSettings(updates) {
    const merged = {...settings,...updates}
    setSettings(merged)
    try { localStorage.setItem("atoproof_settings", JSON.stringify(merged)) } catch {}
  }

  // FIX: normalize API responses (snake_case → camelCase)
  useEffect(()=>{
    async function loadData() {
      try {
        const [rawProjects, rawCustomers] = await Promise.all([
          projectsApi.getAll(),
          customersApi.getAll(),
        ])
        setProjects(rawProjects.map(normalizeProject))
        setCustomers(rawCustomers.map(normalizeKeys))
      } catch(err) {
        console.warn("Backend not available, using seed data:", err.message)
        setProjects(seed_projects)
        setCustomers(seed_customers)
      }
      setLoaded(true)
    }
    loadData()
  },[])

  const PAGE_TITLES = {
    dashboard:"Dashboard", pipeline:"Pipeline",
    projects:"Projects", project:"Project Detail",
    customers:"Customers", quote_print:"Quote", settings:"Settings",
  }

  // FIX: intercept "new" nav key → open wizard instead of navigating to blank view
  function handleNav(key) {
    if(key==="new") {
      setEditingProject(null)
      setShowWizard(true)
      return
    }
    setView(key)
    if(key!=="project") setSelectedProject(null)
  }

  // FIX: use API response for correct backend IDs; normalize; handle new customer properly
  async function handleSaveProject(project, pendingNewCust) {
    try {
      const isEdit = projects.some(p=>p.id===project.id)
      let savedProject

      if(isEdit) {
        const raw = await projectsApi.update(project.id, project)
        // Merge API response (for updated_at etc.) but keep local estimate which isn't in the projects table response
        savedProject = { ...project, ...normalizeProject(raw), estimate: project.estimate }
        setProjects(prev=>prev.map(p=>p.id===savedProject.id?savedProject:p))
      } else {
        const raw = await projectsApi.create(project)
        // Use backend-generated ID; preserve local estimate
        savedProject = { ...project, ...normalizeProject(raw), estimate: project.estimate }
        setProjects(prev=>[...prev,savedProject])
      }

      // FIX: create new customer via API and use real backend ID
      if(pendingNewCust) {
        const rawCust  = await customersApi.create(pendingNewCust)
        const newCust  = normalizeKeys(rawCust)
        // Update the project's customerId to the real backend ID if it was a temp uid
        savedProject   = { ...savedProject, customerId: newCust.id }
        setProjects(prev=>prev.map(p=>p.id===savedProject.id?savedProject:p))
        setCustomers(prev=>[...prev, newCust])
      }

      setShowWizard(false)
      setEditingProject(null)
      setSelectedProject(savedProject)
      setView("project")
      setToast(isEdit?"Project updated!":"Project created!")
    } catch(err) {
      console.error("Save failed:", err)
      setToast("Error saving project. Is the backend running?")
    }
  }

  function openEdit(project) {
    setEditingProject(project)
    setShowWizard(true)
  }

  const currentProject = selectedProject
    ? (projects.find(p=>p.id===selectedProject.id) || selectedProject)
    : null

  if(!loaded) return (
    <div style={{...s.app,alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <img src="/aTopRoof.png" alt="aTopRoof" style={{width:220,marginBottom:12}}/>
        <div style={{color:"#64748b",marginTop:8,fontSize:13}}>Loading your workspace…</div>
      </div>
    </div>
  )

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Syne:wght@700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input, select, textarea { font-family: 'DM Sans', sans-serif; }
        input:focus, select:focus, textarea:focus { outline: none; border-color: #f59e0b !important; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 3px; }
        tr:hover td { background: #f8fafc; }
        button { font-family: 'DM Sans', sans-serif; }
      `}</style>

      <div style={s.app}>
        <Sidebar view={view} onNav={handleNav} projects={projects} user={user} onLogout={logout}/>
        <div style={s.main}>
          <div style={s.topbar}>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800}}>
              {view==="project"&&currentProject
                ? (customers.find(c=>c.id===currentProject.customerId)?.name||"Project Detail")
                : PAGE_TITLES[view]||view}
            </div>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              {view==="project"&&currentProject&&<StatusBadge status={currentProject.status}/>}
              {view==="projects"&&<span style={{fontSize:13,color:"#64748b"}}>{projects.length} total</span>}
              <Btn onClick={()=>{ setEditingProject(null); setShowWizard(true) }} primary>
                📸 New Project
              </Btn>
            </div>
          </div>

          <div style={s.content}>
            {view==="dashboard"&&(
              <Dashboard
                projects={projects} customers={customers}
                setView={setView} setSelectedProject={setSelectedProject}
                onNewProject={()=>{ setEditingProject(null); setShowWizard(true) }}
              />
            )}
            {view==="projects"&&<ProjectsList projects={projects} customers={customers} setView={setView} setSelectedProject={setSelectedProject}/>}
            {view==="project"&&currentProject&&(
              <ProjectDetail
                project={currentProject} customers={customers}
                projects={projects} setProjects={setProjects}
                setView={setView} onEdit={()=>openEdit(currentProject)}
                company={settings}
              />
            )}
            {view==="quote_print"&&currentProject&&(
              <div>
                <div style={{display:"flex",gap:10,marginBottom:20}}>
                  <Btn onClick={()=>setView("project")}>← Back to Project</Btn>
                  <Btn primary onClick={()=>window.print()}>🖨 Print / Save PDF</Btn>
                </div>
                <QuoteView
                  project={currentProject}
                  customer={customers.find(c=>c.id===currentProject.customerId)}
                  company={settings}
                />
              </div>
            )}
            {view==="pipeline"&&<Pipeline projects={projects} customers={customers} setProjects={setProjects} setView={setView} setSelectedProject={setSelectedProject}/>}
            {view==="customers"&&<Customers customers={customers} setCustomers={setCustomers} projects={projects}/>}
            {view==="settings"&&<Settings settings={settings} onSave={saveSettings}/>}
          </div>
        </div>
      </div>

      {showWizard&&(
        <Modal title={editingProject?"Edit Project":"New Project"} onClose={()=>{ setShowWizard(false); setEditingProject(null) }} width={700}>
          <NewProjectWizard
            customers={customers} projects={projects}
            existingProject={editingProject}
            onSave={handleSaveProject}
            onCancel={()=>{ setShowWizard(false); setEditingProject(null) }}
            company={settings}
          />
        </Modal>
      )}

      {toast&&<Toast msg={toast} onDone={()=>setToast(null)}/>}
    </>
  )
}