import { createContext, useContext, useEffect, useState, useCallback } from "react"
import { settingsApi } from "./api"

// Currency and GST/VAT rate used to be two independent settings (their own
// table, their own app_settings key, their own picker) — nothing stopped an
// org from quoting in AUD while charging NZ's GST rate. They're now one
// "business region" per organization, so the two values physically cannot
// disagree. This context is the single real data source; useTax() (in
// TaxContext.jsx) is a thin adapter over the same data so the ~15 existing
// useCurrency() call sites and the couple of useTax() call sites don't need
// to change shape.
const FALLBACK_REGIONS = [
  { countryCode:"NZ", countryName:"New Zealand",    currencyCode:"NZD", currencySymbol:"$",  currencyName:"New Zealand Dollar", locale:"en-NZ", gstRate:0.15 },
  { countryCode:"AU", countryName:"Australia",      currencyCode:"AUD", currencySymbol:"$",  currencyName:"Australian Dollar",  locale:"en-AU", gstRate:0.10 },
  { countryCode:"GB", countryName:"United Kingdom", currencyCode:"GBP", currencySymbol:"£",  currencyName:"British Pound",      locale:"en-GB", gstRate:0.20 },
  { countryCode:"US", countryName:"United States",  currencyCode:"USD", currencySymbol:"$",  currencyName:"US Dollar",          locale:"en-US", gstRate:0.00 },
  { countryCode:"CA", countryName:"Canada",         currencyCode:"CAD", currencySymbol:"$",  currencyName:"Canadian Dollar",    locale:"en-CA", gstRate:0.05 },
  { countryCode:"PH", countryName:"Philippines",    currencyCode:"PHP", currencySymbol:"₱",  currencyName:"Philippine Peso",    locale:"en-PH", gstRate:0.12 },
  { countryCode:"SG", countryName:"Singapore",      currencyCode:"SGD", currencySymbol:"$",  currencyName:"Singapore Dollar",   locale:"en-SG", gstRate:0.09 },
  { countryCode:"IE", countryName:"Ireland",        currencyCode:"EUR", currencySymbol:"€",  currencyName:"Euro",               locale:"en-IE", gstRate:0.23 },
  { countryCode:"ZA", countryName:"South Africa",   currencyCode:"ZAR", currencySymbol:"R",  currencyName:"South African Rand", locale:"en-ZA", gstRate:0.15 },
  { countryCode:"IN", countryName:"India",          currencyCode:"INR", currencySymbol:"₹",  currencyName:"Indian Rupee",       locale:"en-IN", gstRate:0.18 },
  { countryCode:"JP", countryName:"Japan",          currencyCode:"JPY", currencySymbol:"¥",  currencyName:"Japanese Yen",       locale:"ja-JP", gstRate:0.10 },
  { countryCode:"HK", countryName:"Hong Kong",      currencyCode:"HKD", currencySymbol:"$",  currencyName:"Hong Kong Dollar",   locale:"en-HK", gstRate:0.00 },
  { countryCode:"TH", countryName:"Thailand",       currencyCode:"THB", currencySymbol:"฿",  currencyName:"Thai Baht",          locale:"th-TH", gstRate:0.07 },
  { countryCode:"MY", countryName:"Malaysia",       currencyCode:"MYR", currencySymbol:"RM", currencyName:"Malaysian Ringgit",  locale:"en-MY", gstRate:0.06 },
]

const DEFAULT_COUNTRY = "NZ"
const LS_KEY          = "atoproof_business_region"

const CurrencyContext = createContext(null)

export function CurrencyProvider({ children }) {
  const [regions,          setRegions]         = useState(FALLBACK_REGIONS)
  const [selectedCountry,  setSelectedCountry]  = useState(() => {
    try { return localStorage.getItem(LS_KEY) || DEFAULT_COUNTRY } catch { return DEFAULT_COUNTRY }
  })

  useEffect(() => {
    async function load() {
      try {
        const rows = await settingsApi.getBusinessRegions()
        if (Array.isArray(rows) && rows.length > 0) {
          setRegions(rows.map(r => ({
            countryCode:   r.country_code,
            countryName:   r.country_name,
            currencyCode:  r.currency_code,
            currencySymbol: r.currency_symbol,
            currencyName:  r.currency_name,
            locale:        r.locale || "en-US",
            gstRate:       parseFloat(r.gst_rate),
          })))
        }
      } catch { /* keep fallback */ }

      try {
        const { countryCode } = await settingsApi.getOrgBusinessRegion()
        if (countryCode) {
          setSelectedCountry(countryCode)
          try { localStorage.setItem(LS_KEY, countryCode) } catch {}
        }
      } catch { /* keep localStorage value */ }
    }
    load()
  }, [])

  const updateRegion = useCallback(async (countryCode) => {
    setSelectedCountry(countryCode)
    try { localStorage.setItem(LS_KEY, countryCode) } catch {}
    try { await settingsApi.setOrgBusinessRegion(countryCode) } catch {}
  }, [])

  const region =
    regions.find(r => r.countryCode === selectedCountry) ||
    FALLBACK_REGIONS.find(r => r.countryCode === DEFAULT_COUNTRY)

  // updateCurrency keeps its old signature (a currency code, e.g. "AUD") for
  // the ~15 existing call sites — it reverse-looks-up which region owns that
  // currency and switches the whole region (currency + GST together).
  const updateCurrency = useCallback(async (currencyCode) => {
    const match = regions.find(r => r.currencyCode === currencyCode)
    if (match) await updateRegion(match.countryCode)
  }, [regions, updateRegion])

  const currency = {
    code:   region?.currencyCode  || "NZD",
    symbol: region?.currencySymbol || "$",
    name:   region?.currencyName  || "New Zealand Dollar",
    locale: region?.locale        || "en-NZ",
  }

  const currencies = regions.map(r => ({
    code:   r.currencyCode,
    symbol: r.currencySymbol,
    name:   r.currencyName,
    locale: r.locale,
  }))

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
    <CurrencyContext.Provider value={{
      currency, currencies, updateCurrency, formatMoney,
      regions, region, updateRegion,
    }}>
      {children}
    </CurrencyContext.Provider>
  )
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext)
  if (!ctx) throw new Error("useCurrency must be used inside <CurrencyProvider>")
  return ctx
}
