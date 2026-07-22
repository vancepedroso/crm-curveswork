import { useState } from "react"

const BASE_URL = `${window.location.protocol}//${window.location.hostname}:3001/api`

export default function LoginPage({ onLogin }) {
  const [email,    setEmail]    = useState("")
  const [password, setPassword] = useState("")
  const [error,    setError]    = useState("")
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const res  = await fetch(`${BASE_URL}/auth/login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || "Login failed"); return }
      onLogin(data.user, data.token)
    } catch {
      setError("Cannot reach server. Is the backend running?")
    } finally {
      setLoading(false)
    }
  }

  const currentYear = new Date().getFullYear()

  const features = [
    { icon: "📸", title: "Photo to quote in minutes", desc: "Trace roof sections straight off a site photo" },
    { icon: "📐", title: "Real supplier pricing", desc: "Estimates pull live rates from your material catalog" },
    { icon: "📋", title: "One place for every job", desc: "Customers, jobs, photos, and quote history together" },
  ]

  return (
    <div className="flex min-h-screen bg-navy font-sans">
      {/* Left — branding */}
      <div className="hidden lg:flex flex-1 flex-col justify-between px-10 py-14 text-slate-100">
        <div>
          <div className="flex items-center gap-3 mb-10">
            <img src="/aTopRoof.png" alt="aTopRoof" className="w-10 h-10 rounded-lg bg-white p-1 object-contain"/>
            <span className="text-lg font-bold tracking-tight font-display">aTopRoof</span>
          </div>

          <h1 className="text-[42px] font-display font-extrabold leading-tight mb-5 tracking-tight">
            Get a roof quote
            <br/>
            <span className="text-accent">in 3 minutes.</span>
          </h1>

          <p className="text-base text-slate-400 leading-relaxed max-w-md">
            Upload a site photo, trace the roof, and generate a priced quote — built for roofing contractors, not generic sales teams.
          </p>
        </div>

        <div className="grid gap-5">
          {features.map((f, i) => (
            <div key={i} className="flex gap-3">
              <span className="text-xl">{f.icon}</span>
              <div>
                <div className="text-sm font-semibold mb-0.5">{f.title}</div>
                <div className="text-[13px] text-slate-400">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="text-xs text-slate-500 border-t border-white/10 pt-5">
          © {currentYear} aTopRoof. All rights reserved.
        </div>
      </div>

      {/* Right — sign in form */}
      <div className="flex-1 flex flex-col items-center justify-center px-5 py-10 bg-navy-soft/50 lg:border-l lg:border-white/10">
        <div className="w-full max-w-[380px]">
          <div className="text-center mb-8">
            <img src="/aTopRoof.png" alt="aTopRoof" className="w-36 mx-auto mb-6 rounded-xl bg-white p-2 shadow-lg"/>
            <h2 className="text-2xl font-display font-bold text-slate-100 mb-1.5">Welcome back</h2>
            <p className="text-sm text-slate-400">Sign in to your workspace</p>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="mb-5">
              <label className="block text-[13px] font-semibold text-slate-200 mb-2">Email Address</label>
              <input
                type="email" required value={email} onChange={e => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="w-full px-3.5 py-3 rounded-lg text-sm border border-slate-700 bg-navy text-slate-100 font-sans outline-none transition-colors focus:!border-accent"
              />
            </div>

            <div className="mb-6">
              <label className="block text-[13px] font-semibold text-slate-200 mb-2">Password</label>
              <input
                type="password" required value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3.5 py-3 rounded-lg text-sm border border-slate-700 bg-navy text-slate-100 font-sans outline-none transition-colors focus:!border-accent"
              />
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-600 rounded-lg px-3.5 py-3 text-[13px] text-red-300 mb-5 flex gap-2 items-start">
                <span className="text-base mt-0.5">⚠️</span>
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit" disabled={loading}
              className={`w-full px-4 py-3 rounded-lg border-none text-slate-900 font-semibold text-sm font-sans transition-opacity
                ${loading ? "bg-slate-500 cursor-not-allowed" : "bg-accent hover:bg-accent-dark cursor-pointer"}`}
            >
              {loading ? "Signing in…" : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
