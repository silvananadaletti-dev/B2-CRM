const API = "/api";

const STATUS_COLORS = {
  "Prospect": "#8e5cf0",
  "Fazer contato futuro": "#c2831f",
  "Aguardando resposta": "#0f9bb0",
  "Follow-up": "#d67e2c",
  "Em orçamento": "#2f6feb",
  "Negociação": "#17a673",
  "Cliente": "#0c8f4e",
  "Perdido": "#d64545",
  "Arquivado": "#8a8f98",
};

const STATUS_GROUPS = {
  "Prospecção": ["Prospect", "Fazer contato futuro", "Aguardando resposta", "Follow-up"],
  "Negócios em Andamento": ["Em orçamento", "Negociação", "Cliente", "Perdido"],
  "Arquivados": ["Arquivado"],
};

const PT_MONTHS = { jan: 0, fev: 1, mar: 2, abr: 3, mai: 4, jun: 5, jul: 6, ago: 7, set: 8, out: 9, nov: 10, dez: 11 };
const MONTH_NAMES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

// Interpreta datas em formatos livres usadas no campo "Próximo Contato"
// (ISO, dd/mm/aaaa ou "mmm/aa" tipo "ago/26"). Retorna null se não reconhecer.
function parseLooseDate(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (!s || s === "-") return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { year: +m[1], month: +m[2] - 1, day: +m[3], exact: true };
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { year: +m[3], month: +m[2] - 1, day: +m[1], exact: true };
  m = s.match(/^([a-zç]{3})\/(\d{2,4})$/);
  if (m && PT_MONTHS.hasOwnProperty(m[1])) {
    const yy = +m[2];
    return { year: yy < 100 ? 2000 + yy : yy, month: PT_MONTHS[m[1]], day: null, exact: false };
  }
  return null;
}

function isUpcoming(d, today) {
  if (d.exact) return new Date(d.year, d.month, d.day) >= today;
  return new Date(d.year, d.month, 1) >= new Date(today.getFullYear(), today.getMonth(), 1);
}

let state = {
  leads: [],
  activities: [],
  meta: { status_options: [], vendedor_options: [], canal_options: [], cidades: [], segmentos: [] },
  view: "kanban",
  tab: "Prospecção",
  filters: { search: "", vendedor: "", cidade: "", segmento: "" },
  sort: { field: "cliente_empresa", dir: "asc" },
  columnLimits: {},
  editingId: null,
  calendar: { year: new Date().getFullYear(), month: new Date().getMonth() },
};

let auth = { token: null, user: null };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- Autenticação ----------

const AUTH_STORAGE_KEY = "crm_auth";

function loadStoredAuth() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.token) return null;
    return data;
  } catch {
    return null;
  }
}

function saveAuth(token, user) {
  auth = { token, user };
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
  } catch { /* navegador sem storage disponível: sessão só dura a aba atual */ }
}

function clearAuth() {
  auth = { token: null, user: null };
  try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* ignore */ }
}

function isAdmin() {
  return auth.user && auth.user.role === "admin";
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (auth.token) headers["Authorization"] = `Bearer ${auth.token}`;
  const res = await fetch(API + path, { ...opts, headers });
  if (res.status === 401) {
    clearAuth();
    showLoginScreen("Sua sessão expirou. Entre novamente.");
    throw new Error("Sessão expirada.");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Erro na requisição");
  }
  if (res.status === 204) return null;
  return res.json();
}

function showLoginScreen(message) {
  $("#app-root").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
  $("#login-password").value = "";
  const errEl = $("#login-error");
  if (message) {
    errEl.textContent = message;
    errEl.classList.remove("hidden");
  } else {
    errEl.classList.add("hidden");
  }
}

function showApp() {
  $("#login-screen").classList.add("hidden");
  $("#app-root").classList.remove("hidden");
  applyRoleUI();
}

function applyRoleUI() {
  if (!auth.user) return;
  $("#user-menu-name").textContent = auth.user.nome || auth.user.username;
  $("#tab-admin-btn").classList.toggle("hidden", !isAdmin());
  if (!isAdmin() && state.tab === "Administração") state.tab = "Prospecção";
  // Vendedor: o filtro de vendedor não faz sentido (o backend já só devolve os
  // próprios leads), então escondemos pra não confundir.
  const filterVendedor = $("#filter-vendedor");
  if (filterVendedor) filterVendedor.classList.toggle("hidden", !isAdmin());
}

async function bootstrapAuth() {
  const stored = loadStoredAuth();
  if (!stored) {
    showLoginScreen();
    return;
  }
  auth = stored;
  try {
    const me = await api("/auth/me");
    auth.user = me;
    saveAuth(auth.token, me);
    showApp();
    await loadAll();
  } catch (err) {
    clearAuth();
    showLoginScreen();
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = $("#login-username").value.trim();
  const password = $("#login-password").value;
  const btn = $(".login-submit");
  btn.disabled = true;
  try {
    const res = await fetch(API + "/auth/login", {
      method: "POST",
      headers: { "Content-Type":
