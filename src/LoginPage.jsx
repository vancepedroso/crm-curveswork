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

  return (
    <div style={{
      display: "flex",
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { margin: 0; padding: 0; }
        body { font-family: 'Inter', sans-serif; }
      `}</style>

      {/* Left Section - Branding */}
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "60px 40px",
        color: "#f1f5f9",
      }}>
        {/* Logo & Brand */}
        <div>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            marginBottom: "40px",
          }}>
            <div style={{
              width: "40px",
              height: "40px",
              borderRadius: "10px",
              background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "20px",
              fontWeight: "700",
              color: "#fff",
            }}>
              ✓
            </div>
            <span style={{
              fontSize: "20px",
              fontWeight: "700",
              letterSpacing: "-0.5px",
            }}>
              aTopRoof - Roofing CRM
            </span>
          </div>

          {/* Tagline */}
          <h1 style={{
            fontSize: "48px",
            fontWeight: "700",
            lineHeight: "1.2",
            marginBottom: "20px",
            letterSpacing: "-1px",
          }}>
            Manage relationships.
            <br />
            <span style={{ background: "linear-gradient(135deg, #3b82f6, #8b5cf6)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
              Close deals faster.
            </span>
          </h1>

          <p style={{
            fontSize: "16px",
            color: "#cbd5e1",
            lineHeight: "1.6",
            maxWidth: "400px",
          }}>
            Streamline your sales pipeline, automate workflows, and track every customer interaction in one powerful platform.
          </p>
        </div>

        {/* Features */}
        <div style={{
          display: "grid",
          gap: "20px",
        }}>
          {[
            { icon: "⚡", title: "Lightning Fast", desc: "Real-time updates and instant sync" },
            { icon: "🔒", title: "Enterprise Security", desc: "Bank-level encryption & compliance" },
            { icon: "📊", title: "Analytics Ready", desc: "Deep insights into your sales pipeline" },
          ].map((feature, i) => (
            <div key={i} style={{ display: "flex", gap: "12px" }}>
              <span style={{ fontSize: "20px" }}>{feature.icon}</span>
              <div>
                <div style={{ fontSize: "14px", fontWeight: "600", marginBottom: "2px" }}>
                  {feature.title}
                </div>
                <div style={{ fontSize: "13px", color: "#94a3b8" }}>
                  {feature.desc}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          fontSize: "12px",
          color: "#64748b",
          borderTop: "1px solid #334155",
          paddingTop: "20px",
        }}>
          © {currentYear} aTopRoof - Roofing CRM. All rights reserved.
        </div>
      </div>

      {/* Right Section - Login Form */}
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 20px",
        background: "rgba(30, 41, 59, 0.5)",
        backdropFilter: "blur(10px)",
        borderLeft: "1px solid rgba(148, 163, 184, 0.1)",
      }}>
        <div style={{
          width: "100%",
          maxWidth: "400px",
        }}>
          <div style={{
            marginBottom: "32px",
            textAlign: "center",
          }}>
            <img src="/aTopRoof.png" alt="CRM Pro Logo"
              style={{
                width: "160px",
                height: "auto",
                display: "block",
                margin: "0 auto 24px",
                borderRadius: "12px",
                padding: "8px",
                background: "#ffffff",
                boxShadow: "0 8px 24px rgba(0,0,0,0.3)"
              }}
            />
            <h2 style={{
              fontSize: "28px",
              fontWeight: "700",
              color: "#f1f5f9",
              marginBottom: "8px",
            }}>
              Welcome back
            </h2>
            <p style={{
              fontSize: "14px",
              color: "#94a3b8",
            }}>
              Sign in to access your workspace
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            {/* Email Input */}
            <div style={{ marginBottom: "20px" }}>
              <label style={{
                display: "block",
                fontSize: "13px",
                fontWeight: "600",
                color: "#e2e8f0",
                marginBottom: "8px",
              }}>
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="name@company.com"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: "8px",
                  fontSize: "14px",
                  border: "1px solid #334155",
                  background: "#0f172a",
                  color: "#f1f5f9",
                  fontFamily: "inherit",
                  outline: "none",
                  boxSizing: "border-box",
                  transition: "all 0.2s ease",
                }}
                onFocus={e => e.target.style.borderColor = "#475569"}
                onBlur={e => e.target.style.borderColor = "#334155"}
              />
            </div>

            {/* Password Input */}
            <div style={{ marginBottom: "24px" }}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "8px",
              }}>
                <label style={{
                  fontSize: "13px",
                  fontWeight: "600",
                  color: "#e2e8f0",
                }}>
                  Password
                </label>
                <a href="#" style={{
                  fontSize: "12px",
                  color: "#3b82f6",
                  textDecoration: "none",
                  transition: "color 0.2s",
                }}
                onMouseEnter={e => e.target.style.color = "#60a5fa"}
                onMouseLeave={e => e.target.style.color = "#3b82f6"}
                >
                  Forgot Password?
                </a>
              </div>
              <input
                type="password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: "8px",
                  fontSize: "14px",
                  border: "1px solid #334155",
                  background: "#0f172a",
                  color: "#f1f5f9",
                  fontFamily: "inherit",
                  outline: "none",
                  boxSizing: "border-box",
                  transition: "all 0.2s ease",
                }}
                onFocus={e => e.target.style.borderColor = "#475569"}
                onBlur={e => e.target.style.borderColor = "#334155"}
              />
            </div>

            {/* Error Message */}
            {error && (
              <div style={{
                background: "rgba(220, 38, 38, 0.1)",
                border: "1px solid #dc2626",
                borderRadius: "8px",
                padding: "12px 14px",
                fontSize: "13px",
                color: "#fca5a5",
                marginBottom: "20px",
                display: "flex",
                gap: "8px",
                alignItems: "flex-start",
              }}>
                <span style={{ fontSize: "16px", marginTop: "2px" }}>⚠️</span>
                <span>{error}</span>
              </div>
            )}

            {/* Sign In Button */}
            <button
              type="submit"
              disabled={loading}
              style={{
                width: "100%",
                padding: "12px 16px",
                borderRadius: "8px",
                border: "none",
                background: loading
                  ? "linear-gradient(135deg, #64748b, #475569)"
                  : "linear-gradient(135deg, #3b82f6, #2563eb)",
                color: "#fff",
                fontWeight: "600",
                fontSize: "14px",
                fontFamily: "inherit",
                cursor: loading ? "not-allowed" : "pointer",
                transition: "all 0.3s ease",
                boxShadow: loading ? "none" : "0 4px 12px rgba(59, 130, 246, 0.3)",
                opacity: loading ? 0.7 : 1,
              }}
              onMouseEnter={e => {
                if (!loading) {
                  e.target.style.boxShadow = "0 6px 20px rgba(59, 130, 246, 0.4)"
                  e.target.style.transform = "translateY(-2px)"
                }
              }}
              onMouseLeave={e => {
                if (!loading) {
                  e.target.style.boxShadow = "0 4px 12px rgba(59, 130, 246, 0.3)"
                  e.target.style.transform = "translateY(0)"
                }
              }}
            >
              {loading ? "Signing in…" : "Sign In"}
            </button>

            {/* Sign Up Link */}
            <div style={{
              textAlign: "center",
              marginTop: "16px",
              fontSize: "13px",
              color: "#94a3b8",
            }}>
              Don't have an account?{" "}
              <a href="#" style={{
                color: "#3b82f6",
                textDecoration: "none",
                fontWeight: "600",
                transition: "color 0.2s",
              }}
              onMouseEnter={e => e.target.style.color = "#60a5fa"}
              onMouseLeave={e => e.target.style.color = "#3b82f6"}
              >
                Start free trial
              </a>
            </div>
          </form>

          {/* Divider */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            margin: "24px 0",
            color: "#475569",
            fontSize: "12px",
          }}>
            <div style={{ flex: 1, height: "1px", background: "#334155" }} />
            <span>or</span>
            <div style={{ flex: 1, height: "1px", background: "#334155" }} />
          </div>

          {/* Social Login */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "12px",
          }}>
            {["Google", "GitHub"].map((provider) => (
              <button
                key={provider}
                type="button"
                style={{
                  padding: "10px 14px",
                  borderRadius: "8px",
                  border: "1px solid #334155",
                  background: "#0f172a",
                  color: "#e2e8f0",
                  fontWeight: "500",
                  fontSize: "13px",
                  fontFamily: "inherit",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                }}
                onMouseEnter={e => {
                  e.target.style.borderColor = "#475569"
                  e.target.style.background = "#1e293b"
                }}
                onMouseLeave={e => {
                  e.target.style.borderColor = "#334155"
                  e.target.style.background = "#0f172a"
                }}
              >
                {provider}
              </button>
            ))}
          </div>

          {/* Legal Links */}
          <div style={{
            display: "flex",
            justifyContent: "center",
            gap: "20px",
            marginTop: "24px",
            fontSize: "11px",
            color: "#64748b",
          }}>
            <a href="#" style={{ color: "inherit", textDecoration: "none" }}>Terms</a>
            <a href="#" style={{ color: "inherit", textDecoration: "none" }}>Privacy</a>
            <a href="#" style={{ color: "inherit", textDecoration: "none" }}>Support</a>
          </div>
        </div>
      </div>
    </div>
  )
}
