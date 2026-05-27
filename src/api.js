// src/api.js — Central API service
const BASE = "http://localhost:3001/api";

async function request(url, options = {}) {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// ────────── Customers ──────────
export const customersApi = {
  getAll:    ()              => request("/customers"),
  getOne:    (id)            => request(`/customers/${id}`),
  create:    (data)          => request("/customers", { method:"POST", body:JSON.stringify(data) }),
  update:    (id, data)      => request(`/customers/${id}`, { method:"PUT", body:JSON.stringify(data) }),
  delete:    (id)            => request(`/customers/${id}`, { method:"DELETE" }),
};

// ────────── Projects ──────────
export const projectsApi = {
  getAll:       ()              => request("/projects"),
  getOne:       (id)            => request(`/projects/${id}`),
  create:       (data)          => request("/projects", { method:"POST", body:JSON.stringify(data) }),
  update:       (id, data)      => request(`/projects/${id}`, { method:"PUT", body:JSON.stringify(data) }),
  updateStatus: (id, status)    => request(`/projects/${id}/status`, { method:"PATCH", body:JSON.stringify({status}) }),
  delete:       (id)            => request(`/projects/${id}`, { method:"DELETE" }),
};

// ────────── Estimates ──────────
export const estimatesApi = {
  getForProject:    (projectId) => request(`/estimates/${projectId}`),
  saveForProject:   (projectId, data) => request(`/estimates/${projectId}`, { method:"POST", body:JSON.stringify(data) }),
  getGeometry:      (projectId) => request(`/estimates/${projectId}/geometry`),
  saveGeometry:     (projectId, data) => request(`/estimates/${projectId}/geometry`, { method:"POST", body:JSON.stringify(data) }),
};

// ────────── Dashboard ──────────
export const dashboardApi = {
  getStats:   () => request("/dashboard"),
  getPipeline:() => request("/pipeline"),
};

// ────────── Seed ──────────
export const seedApi = {
  seed: (data) => request("/seed", { method:"POST", body:JSON.stringify(data) }),
};