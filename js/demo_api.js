const local = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
const base = local ? 'http://127.0.0.1:8787' : 'https://api.planeir.ie';
let csrf = '';
export function setDemoCsrf(value) { csrf = value || ''; }
export async function demoApi(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, credentials: 'include', cache: 'no-store',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf && method !== 'GET' ? { 'X-Demo-CSRF': csrf } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Your information could not be saved. Please try again.'), { status: response.status, code: data.code });
  return data;
}
