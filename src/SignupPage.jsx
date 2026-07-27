import { useState } from "react"
import { billingApi } from "./api"

// Mirrors backend/config/plans.js — kept in sync manually since plan
// pricing/labels are display copy, not something worth an API round-trip
// just to render two buttons.
const PLAN_OPTIONS = [
  { key: "starter", label: "Starter", seatLimit: 3,  blurb: "For small crews just getting started" },
  { key: "pro",     label: "Pro",     seatLimit: 10, blurb: "For growing teams with more estimators" },
]

export default function SignupPage({ onBackToLogin, onLogin }) {
  const [companyName, setCompanyName] = useState("")
  const [email,        setEmail]      = useState("")
  const [password,     setPassword]   = useState("")
  const [planKey,      setPlanKey]    = useState("starter")
  const [error,        setError]      = useState("")
  const [loading,      setLoading]    = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const res = await billingApi.startCheckout({ companyName, email, password, planKey })
      // ← Stripe isn't configured yet on the backend — it created the
      //   organization + owner directly instead of starting a real
      //   Checkout session, and handed back a normal login token. Log
      //   straight in rather than redirecting anywhere.
      if (res.bypassed) {
        onLogin(res.user, res.token)
        return
      }
      // ← Real Stripe path: the organization/user aren't created yet —
      //   only once Stripe confirms payment via webhook. This redirect
      //   hands off to Stripe Checkout; there's nothing to log into until
      //   that completes.
      window.location.href = res.url
    } catch (err) {
      setError(err.message || "Couldn't start signup")
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen bg-navy font-sans">
      <div className="flex-1 flex flex-col items-center justify-center px-5 py-10">
        <div className="w-full max-w-[420px]">
          <div className="text-center mb-8">
            <img src="/aTopRoof.png" alt="aTopRoof" className="w-36 mx-auto mb-6 rounded-xl bg-white p-2 shadow-lg"/>
            <h2 className="text-2xl font-display font-bold text-slate-100 mb-1.5">Start your workspace</h2>
            <p className="text-sm text-slate-400">Set up your company, then pick a plan</p>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="mb-5">
              <label className="block text-[13px] font-semibold text-slate-200 mb-2">Company Name</label>
              <input
                required value={companyName} onChange={e => setCompanyName(e.target.value)}
                placeholder="RK Roofing"
                className="w-full px-3.5 py-3 rounded-lg text-sm border border-slate-700 bg-navy text-slate-100 font-sans outline-none transition-colors focus:!border-accent"
              />
            </div>

            <div className="mb-5">
              <label className="block text-[13px] font-semibold text-slate-200 mb-2">Your Email</label>
              <input
                type="email" required value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full px-3.5 py-3 rounded-lg text-sm border border-slate-700 bg-navy text-slate-100 font-sans outline-none transition-colors focus:!border-accent"
              />
            </div>

            <div className="mb-6">
              <label className="block text-[13px] font-semibold text-slate-200 mb-2">Password</label>
              <input
                type="password" required minLength={6} value={password} onChange={e => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full px-3.5 py-3 rounded-lg text-sm border border-slate-700 bg-navy text-slate-100 font-sans outline-none transition-colors focus:!border-accent"
              />
            </div>

            <div className="mb-6">
              <label className="block text-[13px] font-semibold text-slate-200 mb-2">Plan</label>
              <div className="grid grid-cols-2 gap-3">
                {PLAN_OPTIONS.map(p => (
                  <button
                    type="button" key={p.key} onClick={() => setPlanKey(p.key)}
                    className={`text-left px-3.5 py-3 rounded-lg border font-sans transition-colors
                      ${planKey === p.key ? "border-accent bg-accent/10" : "border-slate-700 bg-navy hover:border-slate-500"}`}
                  >
                    <div className="text-sm font-semibold text-slate-100">{p.label}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">Up to {p.seatLimit} users</div>
                    <div className="text-[11px] text-slate-500 mt-1">{p.blurb}</div>
                  </button>
                ))}
              </div>
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
              {loading ? "Redirecting to checkout…" : "Continue to payment"}
            </button>

            <button
              type="button" onClick={onBackToLogin}
              className="w-full mt-3 px-4 py-2 rounded-lg border-none bg-transparent text-slate-400 text-[13px] font-sans cursor-pointer hover:text-slate-200"
            >
              Already have a workspace? Sign in
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
