// ---------------------------------------------------------------------------
// Base URL resolution
// ---------------------------------------------------------------------------
const BASE_URL =
  `${window.location.protocol}//${window.location.hostname}:3001/api`;

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 15_000;

async function request(endpoint, options = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const isFormData = typeof FormData !== "undefined" && fetchOptions.body instanceof FormData;

  let response;
  try {
    response = await fetch(`${BASE_URL}${endpoint}`, {
      signal: controller.signal,
      headers: {
        // FormData bodies must NOT set Content-Type — the browser fills in
        // the multipart boundary itself when the header is left unset.
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(localStorage.getItem("auth_token")
          ? { Authorization: `Bearer ${localStorage.getItem("auth_token")}` }
          : {}),
        ...fetchOptions.headers,
      },
      ...fetchOptions,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeout / 1000}s: ${endpoint}`);
    }
    throw new Error(`Network error: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body?.error || body?.message || `HTTP ${response.status}`;

    // A 401 on any authenticated call means the stored token is dead (expired,
    // or — as happened when the multi-tenant JWT shape changed — simply out of
    // date). Without this, the app silently renders empty (every load fails,
    // but nothing ever clears the stale session or sends the user back to the
    // login screen) instead of just asking the user to log back in. Login
    // itself is excluded — a wrong password there is a normal 401, not a dead
    // session, and there's no token to clear yet anyway.
    if (response.status === 401 && !endpoint.startsWith("/auth/")) {
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
      window.location.reload();
    }

    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  // 204 No Content — return null instead of trying to parse an empty body
  if (response.status === 204) return null;

  return response.json();
}

// Convenience wrappers
const get    = (endpoint, opts)       => request(endpoint, { method: "GET", ...opts });
const post   = (endpoint, data, opts) => request(endpoint, { method: "POST",  body: JSON.stringify(data), ...opts });
const put    = (endpoint, data, opts) => request(endpoint, { method: "PUT",   body: JSON.stringify(data), ...opts });
const patch  = (endpoint, data, opts) => request(endpoint, { method: "PATCH", body: JSON.stringify(data), ...opts });
const del    = (endpoint, opts)       => request(endpoint, { method: "DELETE", ...opts });

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
export const customersApi = {
  getAll:  ()             => get("/customers"),
  getOne:  (id)           => get(`/customers/${id}`),
  create:  (data)         => post("/customers", data),
  update:  (id, data)     => put(`/customers/${id}`, data),
  delete:  (id)           => del(`/customers/${id}`),
};

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
export const projectsApi = {
  getAll:       ()              => get("/projects"),
  getOne:       (id)            => get(`/projects/${id}`),
  create:       (data)          => post("/projects", data),
  update:       (id, data)      => put(`/projects/${id}`, data),
  updateStatus: (id, status)    => patch(`/projects/${id}/status`, { status }),
  delete:       (id)            => del(`/projects/${id}`),
};

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------
export const estimatesApi = {
  getForProject:  (projectId)       => get(`/estimates/${projectId}`),
  saveForProject: (projectId, data) => post(`/estimates/${projectId}`, data),
  getGeometry:    (projectId)       => get(`/estimates/${projectId}/geometry`),
  saveGeometry:   (projectId, data) => post(`/estimates/${projectId}/geometry`, data),
};

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
export const photosApi = {
  getForProject: (projectId)         => get(`/photos/${projectId}`),
  upload:        (projectId, files)  => {
    const form = new FormData();
    for (const file of files) form.append("photos", file);
    return request(`/photos/${projectId}`, { method: "POST", body: form });
  },
  delete: (id) => del(`/photos/${id}`),
};

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export const jobsApi = {
  getAll:  (customerId) => get(customerId ? `/jobs?customerId=${customerId}` : "/jobs"),
  getOne:  (id)         => get(`/jobs/${id}`),
  create:  (data)       => post("/jobs", data),
  update:  (id, data)   => put(`/jobs/${id}`, data),
  delete:  (id)         => del(`/jobs/${id}`),
};

// ---------------------------------------------------------------------------
// Job photos
// ---------------------------------------------------------------------------
export const jobPhotosApi = {
  getForJob: (jobId)        => get(`/job-photos/${jobId}`),
  upload:    (jobId, files) => {
    const form = new FormData();
    for (const file of files) form.append("photos", file);
    return request(`/job-photos/${jobId}`, { method: "POST", body: form });
  },
  delete: (id) => del(`/job-photos/${id}`),
};

// ---------------------------------------------------------------------------
// Roof materials (supplier price catalog)
// ---------------------------------------------------------------------------
export const materialsApi = {
  search:       (query, group="", catalogUnit="")         => get(`/materials?search=${encodeURIComponent(query)}${group?`&group=${encodeURIComponent(group)}`:""}${catalogUnit?`&unit=${encodeURIComponent(catalogUnit)}`:""}`),
  getSuppliers: ()                                        => get(`/materials/suppliers`),
  getTypes:     (supplier, group="", catalogUnit="")       => get(`/materials/types?supplier=${encodeURIComponent(supplier)}${group?`&group=${encodeURIComponent(group)}`:""}${catalogUnit?`&unit=${encodeURIComponent(catalogUnit)}`:""}`),
  getByType:    (supplier, type, group="", catalogUnit="") => get(`/materials/by-type?supplier=${encodeURIComponent(supplier)}&type=${encodeURIComponent(type)}${group?`&group=${encodeURIComponent(group)}`:""}${catalogUnit?`&unit=${encodeURIComponent(catalogUnit)}`:""}`),
};

// ---------------------------------------------------------------------------
// Company profile (per-user quotation branding)
// ---------------------------------------------------------------------------
export const companyProfileApi = {
  get:    ()     => get("/company-profile"),
  update: (data) => put("/company-profile", data),
  uploadLogo:   (file) => {
    const form = new FormData(); form.append("image", file);
    return request("/company-profile/logo", { method: "POST", body: form });
  },
  uploadBadges: (file) => {
    const form = new FormData(); form.append("image", file);
    return request("/company-profile/badges", { method: "POST", body: form });
  },
};

// ---------------------------------------------------------------------------
// Billing (Stripe) — starting a paid signup, and the owner's "manage
// billing" link into the Stripe Customer Portal
// ---------------------------------------------------------------------------
export const billingApi = {
  startCheckout:           (data) => post("/billing/checkout-session", data),
  getPortalUrl:            ()     => get("/billing/portal-session"),
  getPaymentMethods:       ()     => get("/billing/payment-methods"),
  getPublishableKey:       ()     => get("/billing/publishable-key"),
  createSetupIntent:       ()     => post("/billing/setup-intent", {}),
  createDummyPaymentMethod:(data) => post("/billing/payment-methods/dummy", data),
  setDefaultPaymentMethod: (id)   => post(`/billing/payment-methods/${id}/default`, {}),
  deletePaymentMethod:     (id)   => del(`/billing/payment-methods/${id}`),
};

// ---------------------------------------------------------------------------
// The caller's own organization — plan, seat usage, subscription status
// ---------------------------------------------------------------------------
export const organizationApi = {
  get: () => get("/organization"),
};

// ---------------------------------------------------------------------------
// Platform admin only — cross-organization, read-only. Every other API
// module here is scoped to the caller's own org; these two endpoints are
// the deliberate exception, gated server-side by requirePlatformAdmin.
// ---------------------------------------------------------------------------
export const platformAdminApi = {
  getOrganizations:       ()                    => get("/platform-admin/organizations"),
  getOrganizationUsers:   (orgId)                => get(`/platform-admin/organizations/${orgId}/users`),
  createOrganization:     (data)                 => post("/platform-admin/organizations", data),
  updateOrganization:     (orgId, data)           => put(`/platform-admin/organizations/${orgId}`, data),
  createOrganizationUser: (orgId, data)           => post(`/platform-admin/organizations/${orgId}/users`, data),
  updateOrganizationUser: (orgId, userId, data)   => put(`/platform-admin/organizations/${orgId}/users/${userId}`, data),
};

// ---------------------------------------------------------------------------
// Job complexity multipliers (global, not per-user — same list for everyone
// quoting, editable from the Job Complexity settings page)
// ---------------------------------------------------------------------------
export const complexityLevelsApi = {
  getAll: ()       => get("/complexity-levels"),
  save:   (levels) => put("/complexity-levels", levels),
};

// ---------------------------------------------------------------------------
// Quote history
// ---------------------------------------------------------------------------
export const quotesApi = {
  getForProject: (projectId)       => get(`/quotes/${projectId}`),
  save:          (projectId, data) => post(`/quotes/${projectId}`, data),
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export const dashboardApi = {
  getStats:    () => get("/dashboard"),
  getPipeline: () => get("/pipeline"),
};

// ---------------------------------------------------------------------------
// Users  (admin user management)
// ---------------------------------------------------------------------------
export const usersApi = {
  getAll:       ()              => get("/users"),
  create:       (data)          => post("/users", data),
  update:       (id, data)      => put(`/users/${id}`, data),
  setActive:    (id, is_active) => patch(`/users/${id}/status`, { is_active }),
};

// ---------------------------------------------------------------------------
// Settings  (currency preferences)
// ---------------------------------------------------------------------------
export const settingsApi = {
  getCurrencies:   ()     => get("/settings/currencies"),
  getUserCurrency: ()     => get("/settings/user-currency"),
  setUserCurrency: (code) => put("/settings/user-currency", { code }),
};