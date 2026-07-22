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
  search:       (query)          => get(`/materials?search=${encodeURIComponent(query)}`),
  getSuppliers: ()                => get(`/materials/suppliers`),
  getTypes:     (supplier)        => get(`/materials/types?supplier=${encodeURIComponent(supplier)}`),
  getByType:    (supplier, type)  => get(`/materials/by-type?supplier=${encodeURIComponent(supplier)}&type=${encodeURIComponent(type)}`),
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
// Seed (dev / staging only)
// ---------------------------------------------------------------------------
export const seedApi = {
  seed: (data) => post("/seed", data),
};

// ---------------------------------------------------------------------------
// Settings  (currency preferences)
// ---------------------------------------------------------------------------
export const settingsApi = {
  getCurrencies:   ()     => get("/settings/currencies"),
  getUserCurrency: ()     => get("/settings/user-currency"),
  setUserCurrency: (code) => put("/settings/user-currency", { code }),
};