import { useCallback } from "react"
import { useCurrency } from "./CurrencyContext"

// Currency and GST/VAT are now one "business region" setting, sourced from
// CurrencyContext (see the comment there). This file is a thin adapter kept
// only so the couple of existing useTax() call sites don't need to change
// shape — TaxProvider is a no-op passthrough; there is no separate fetch or
// state here anymore.
export function TaxProvider({ children }) {
  return children
}

export function useTax() {
  const { regions, region, updateRegion } = useCurrency()

  const taxRates = regions.map(r => ({
    countryCode: r.countryCode,
    countryName: r.countryName,
    rate:        r.gstRate,
  }))

  const updateTaxCountry = useCallback((countryCode) => updateRegion(countryCode), [updateRegion])

  return {
    taxRates,
    taxCountry: region?.countryCode ?? "NZ",
    updateTaxCountry,
    gstRate: region?.gstRate ?? 0.15,
  }
}
