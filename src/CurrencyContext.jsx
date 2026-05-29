import { createContext, useContext, useEffect, useState, useCallback } from "react"
import { settingsApi } from "./api"

const FALLBACK_CURRENCIES = [
  { code:"NZD", symbol:"$",  name:"New Zealand Dollar", locale:"en-NZ" },
  { code:"USD", symbol:"$",  name:"US Dollar",          locale:"en-US" },
  { code:"AUD", symbol:"$",  name:"Australian Dollar",  locale:"en-AU" },
  { code:"PHP", symbol:"₱",  name:"Philippine Peso",    locale:"en-PH" },
  { code:"CAD", symbol:"$",  name:"Canadian Dollar",    locale:"en-CA" },
  { code:"GBP", symbol:"£",  name:"British Pound",      locale:"en-GB" },
  { code:"EUR", symbol:"€",  name:"Euro",               locale:"en-EU" },
  { code:"JPY", symbol:"¥",  name:"Japanese Yen",       locale:"ja-JP" },
  { code:"SGD", symbol:"$",  name:"Singapore Dollar",   locale:"en-SG" },
  { code:"HKD", symbol:"$",  name:"Hong Kong Dollar",   locale:"en-HK" },
  { code:"INR", symbol:"₹",  name:"Indian Rupee",       locale:"en-IN" },
  { code:"THB", symbol:"฿",  name:"Thai Baht",          locale:"th-TH" },
  { code:"MYR", symbol:"RM", name:"Malaysian Ringgit",  locale:"en-MY" },
]

const DEFAULT_CODE = "NZD"
const LS_KEY       = "atoproof_currency"

const CurrencyContext = createContext(null)

export function CurrencyProvider({ children }) {
  const [currencies,   setCurrencies]   = useState(FALLBACK_CURRENCIES)
  const [selectedCode, setSelectedCode] = useState(() => {
    try { return localStorage.getItem(LS_KEY) || DEFAULT_CODE } catch { return DEFAULT_CODE }
  })

  // Load from backend
  useEffect(() => {
    async function load() {
      try {
        const rows = await settingsApi.getCurrencies()
        if (Array.isArray(rows) && rows.length > 0) {
          setCurrencies(rows.map(r => ({
            code:   r.code,
            symbol: r.symbol,
            name:   r.name,
            locale: r.locale || "en-US",
          })))
        }
      } catch { /* keep fallback */ }

      try {
        const { code } = await settingsApi.getUserCurrency()
        if (code) {
          setSelectedCode(code)
          try { localStorage.setItem(LS_KEY, code) } catch {}
        }
      } catch { /* keep localStorage value */ }
    }
    load()
  }, [])

  const updateCurrency = useCallback(async (code) => {
    setSelectedCode(code)
    try { localStorage.setItem(LS_KEY, code) } catch {}
    try { await settingsApi.setUserCurrency(code) } catch {}
  }, [])

  const currency =
    currencies.find(c => c.code === selectedCode) ||
    FALLBACK_CURRENCIES.find(c => c.code === DEFAULT_CODE)

  // ── currency‑aware formatter ──────────────────────────────────
  const formatMoney = useCallback((amount) => {
    if (amount == null || isNaN(amount)) return "—"
    const locale = currency?.locale || "en-NZ"
    const code   = currency?.code   || "NZD"
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: code,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(Math.round(amount))
    } catch {
      // fallback if locale/currency code not recognised by browser
      return `${currency?.symbol || "$"}${Math.round(amount).toLocaleString(locale)}`
    }
  }, [currency])

  return (
    <CurrencyContext.Provider value={{ currency, currencies, updateCurrency, formatMoney }}>
      {children}
    </CurrencyContext.Provider>
  )
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext)
  if (!ctx) throw new Error("useCurrency must be used inside <CurrencyProvider>")
  return ctx
}