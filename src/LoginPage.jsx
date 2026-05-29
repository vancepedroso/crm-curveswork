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

  return (
    <div style={{
      display:"flex", alignItems:"center", justifyContent:"center",
      height:"100vh", background:"#0f172a", fontFamily:"'DM Sans', sans-serif",
    }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Syne:wght@700;800&display=swap');`}</style>
      <div style={{
        background:"#1e293b", borderRadius:16, padding:"40px 36px",
        width:"100%", maxWidth:380, boxShadow:"0 24px 80px rgba(0,0,0,0.5)",
      }}>
        <img src="/aTopRoof.png" alt="aTopRoof"
  style={{width:160, display:"block", margin:"0 auto 28px", background:"#ffffff", borderRadius:10, padding:"8px 12px", boxShadow:"0 1px 4px rgba(0,0,0,0.25)"}}/>

        <h2 style={{
          fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:800,
          color:"#f8fafc", textAlign:"center", marginBottom:6,
        }}>Welcome back</h2>
        <p style={{textAlign:"center", fontSize:13, color:"#64748b", marginBottom:28}}>
          Sign in to your workspace
        </p>

        <form onSubmit={handleSubmit}>
          <div style={{marginBottom:14}}>
            <label style={{display:"block",fontSize:12,color:"#94a3b8",marginBottom:5,fontWeight:500}}>
              Email
            </label>
            <input
              type="email" required value={email}
              onChange={e=>setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{
                width:"100%", padding:"10px 14px", borderRadius:8, fontSize:13,
                border:"1px solid #334155", background:"#0f172a", color:"#f8fafc",
                fontFamily:"inherit", outline:"none", boxSizing:"border-box",
              }}
            />
          </div>

          <div style={{marginBottom:22}}>
            <label style={{display:"block",fontSize:12,color:"#94a3b8",marginBottom:5,fontWeight:500}}>
              Password
            </label>
            <input
              type="password" required value={password}
              onChange={e=>setPassword(e.target.value)}
              placeholder="••••••••"
              style={{
                width:"100%", padding:"10px 14px", borderRadius:8, fontSize:13,
                border:"1px solid #334155", background:"#0f172a", color:"#f8fafc",
                fontFamily:"inherit", outline:"none", boxSizing:"border-box",
              }}
            />
          </div>

          {error && (
            <div style={{
              background:"#450a0a", border:"1px solid #7f1d1d", borderRadius:8,
              padding:"10px 14px", fontSize:12, color:"#fca5a5", marginBottom:16,
            }}>
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} style={{
            width:"100%", padding:"11px", borderRadius:8, border:"none",
            background: loading ? "#92400e" : "#f59e0b",
            color:"#000", fontWeight:600, fontSize:14,
            fontFamily:"inherit", cursor: loading ? "not-allowed" : "pointer",
          }}>
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  )
}