import { createContext, useContext, useState, useCallback } from "react"

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("auth_user")) || null }
    catch { return null }
  })

  const login = useCallback((userData, token) => {
    localStorage.setItem("auth_token", token)
    localStorage.setItem("auth_user", JSON.stringify(userData))
    setUser(userData)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem("auth_token")
    localStorage.removeItem("auth_user")
    setUser(null)
  }, [])

  // ← After a self-profile edit (name/email), the cached user object needs
  //   updating too — nothing else refreshes it, and it drives what's shown
  //   in the sidebar/topbar. Doesn't touch the JWT itself (role/org can't
  //   change via a profile edit), just the locally-cached display fields.
  const updateUser = useCallback((partial) => {
    setUser(prev => {
      const next = { ...prev, ...partial }
      localStorage.setItem("auth_user", JSON.stringify(next))
      return next
    })
  }, [])

  return (
    <AuthContext.Provider value={{ user, login, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)