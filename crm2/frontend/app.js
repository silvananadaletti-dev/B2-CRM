const API = "/api";

const STATUS_COLORS = {
  "Prospect": "#8e5cf0",
  "Fazer contato futuro": "#c2831f",
  "Aguardando resposta": "#0f9bb0",
  "Follow-up": "#d67e2c",
  "Em orçamento": "#2f6feb",
  "Negociação": "#17a673",
  "Perdido": "#d64545",
  "Arquivado": "#8a8f98",
};

const STATUS_GROUPS = {
  "Prospecção": ["Prospect", "Fazer contato futuro", "Aguardando resposta", "Follow-up"],
  "Negócios em Andamento": ["Em orçamento", "Negociação", "Perdido"],
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

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Erro na requisição");
  }
  if (res.status === 204) return null;
  return res.json();
}

async function loadAll() {
  const [meta, leads, stats, activities] = await Promise.all([
    api("/meta"),
    api("/leads"),
    api("/stats"),
    api("/activities"),
  ]);
  state.meta = meta;
  state.leads = leads;
  state.activities = activities;
  renderFilters();
  renderStats(stats);
  render();
}

function renderStats(stats) {
  $("#stat-line").textContent =
    `${stats.total_leads} leads · ${stats.total_orcamentos} orçamentos · ` +
    Object.entries(stats.by_status).map(([k, v]) => `${k}: ${v}`).join(" · ");
}

function renderFilters() {
  const vSel = $("#filter-vendedor");
  vSel.innerHTML = '<option value="">Todos os vendedores</option>' +
    state.meta.vendedor_options.map((v) => `<option value="${v}">${v}</option>`).join("");
  const segSel = $("#filter-segmento");
  segSel.innerHTML = '<option value="">Todos os segmentos</option>' +
    state.meta.segmentos.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  const cSel = $("#filter-cidade");
  cSel.innerHTML = '<option value="">Todas as cidades</option>' +
    state.meta.cidades.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  const fVendedor = $("#f-vendedor");
  fVendedor.innerHTML = '<option value="">(sem vendedor)</option>' +
    state.meta.vendedor_options.map((v) => `<option value="${v}">${v}</option>`).join("");
  const fStatus = $("#f-status");
  fStatus.innerHTML = state.meta.status_options.map((s) => `<option value="${s}">${s}</option>`).join("");
  const aCanal = $("#a-canal");
  aCanal.innerHTML = state.meta.canal_options.map((c) => `<option value="${c}">${c}</option>`).join("");

  const fSegmento = $("#f-segmento");
  fSegmento.innerHTML =
    '<option value="">(sem segmento)</option>' +
    state.meta.segmentos.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("") +
    '<option value="Outros">Outros…</option>';
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[m]);
}

function getFiltered() {
  const { search, vendedor, cidade, segmento } = state.filters;
  const s = search.trim().toLowerCase();
  const tabStatuses = STATUS_GROUPS[state.tab] || Object.keys(STATUS_COLORS);
  return state.leads.filter((l) => {
    if (!tabStatuses.includes(l.status)) return false;
    if (vendedor && l.vendedor !== vendedor) return false;
    if (cidade && l.cidade !== cidade) return false;
    if (segmento && l.segmento !== segmento) return false;
    if (s) {
      const hay = `${l.cliente_empresa} ${l.contato} ${l.cidade} ${l.segmento} ${l.tipo_obra}`.toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });
}

function countAllUpcomingEvents() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let count = 0;
  state.leads.forEach((l) => {
    const d = parseLooseDate(l.proximo_contato);
    if (d && isUpcoming(d, today)) count++;
  });
  state.activities.forEach((a) => {
    const d = parseLooseDate(a.data_followup);
    if (d && isUpcoming(d, today)) count++;
  });
  return count;
}

function renderTabCounts() {
  const countIn = (statuses) => state.leads.filter((l) => statuses.includes(l.status)).length;
  $("#tab-count-prospeccao").textContent = countIn(STATUS_GROUPS["Prospecção"]);
  $("#tab-count-projetos").textContent = countIn(STATUS_GROUPS["Negócios em Andamento"]);
  $("#tab-count-arquivados").textContent = countIn(STATUS_GROUPS["Arquivados"]);
  $("#tab-count-calendario").textContent = countAllUpcomingEvents();
}

function render() {
  const isCalendar = state.tab === "Calendário";
  $(".view-toggle").classList.toggle("hidden", isCalendar);
  $("#calendar-view").classList.toggle("hidden", !isCalendar);
  $("#filter-count").classList.toggle("hidden", isCalendar);

  renderTabCounts();

  if (isCalendar) {
    $("#kanban-view").classList.add("hidden");
    $("#list-view").classList.add("hidden");
    renderCalendar();
    return;
  }

  $("#kanban-view").classList.toggle("hidden", state.view !== "kanban");
  $("#list-view").classList.toggle("hidden", state.view !== "list");

  const filtered = getFiltered();
  const tabTotal = state.leads.filter((l) => (STATUS_GROUPS[state.tab] || []).includes(l.status)).length;
  $("#filter-count").textContent = `${filtered.length} de ${tabTotal} leads nesta aba`;
  if (state.view === "kanban") {
    renderKanban(filtered);
  } else {
    renderList(filtered);
  }
}

function renderKanban(filtered) {
  const board = $("#kanban-view");
  const statuses = STATUS_GROUPS[state.tab] || (state.meta.status_options.length ? state.meta.status_options : Object.keys(STATUS_COLORS));
  const grouped = {};
  statuses.forEach((s) => (grouped[s] = []));
  filtered.forEach((l) => {
    const key = grouped[l.status] ? l.status : statuses[0];
    grouped[key].push(l);
  });

  board.innerHTML = "";
  statuses.forEach((status) => {
    const items = grouped[status];
    const limit = state.columnLimits[status] || 60;
    const visible = items.slice(0, limit);
    const col = document.createElement("div");
    col.className = "kanban-column";
    col.style.setProperty("--col-color", STATUS_COLORS[status] || "#999");

    col.innerHTML = `
      <div class="kanban-column-header">
        <span>${status}</span>
        <span class="kanban-column-count">${items.length}</span>
      </div>
      <div class="kanban-column-body" data-status="${escapeHtml(status)}"></div>
    `;
    const body = col.querySelector(".kanban-column-body");
    visible.forEach((lead) => body.appendChild(renderCard(lead)));
    if (items.length > visible.length) {
      const more = document.createElement("button");
      more.className = "load-more-btn";
      more.textContent = `Carregar mais (${items.length - visible.length} restantes)`;
      more.onclick = () => {
        state.columnLimits[status] = limit + 60;
        render();
      };
      body.appendChild(more);
    }

    body.addEventListener("dragover", (e) => {
      e.preventDefault();
      body.classList.add("drag-over");
    });
    body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
    body.addEventListener("drop", async (e) => {
      e.preventDefault();
      body.classList.remove("drag-over");
      const leadId = e.dataTransfer.getData("text/plain");
      const lead = state.leads.find((l) => String(l.id) === leadId);
      if (lead && lead.status !== status) {
        lead.status = status;
        render();
        try {
          await api(`/leads/${leadId}`, { method: "PATCH", body: JSON.stringify({ status }) });
          loadStatsOnly();
        } catch (err) {
          alert("Erro ao mover lead: " + err.message);
          loadAll();
        }
      }
    });

    board.appendChild(col);
  });
}

function renderCard(lead) {
  const card = document.createElement("div");
  card.className = "lead-card";
  card.draggable = true;
  card.dataset.id = lead.id;
  card.innerHTML = `
    <div class="lead-card-title">${escapeHtml(lead.cliente_empresa)}</div>
    <div class="lead-card-meta">
      ${lead.contato ? `<span>👤 ${escapeHtml(lead.contato)}</span>` : ""}
      ${lead.cidade ? `<span>📍 ${escapeHtml(lead.cidade)}</span>` : ""}
      ${lead.vendedor ? `<span class="badge badge-vendedor">${escapeHtml(lead.vendedor)}</span>` : ""}
      ${lead.num_orcamentos ? `<span class="badge badge-n">${lead.num_orcamentos} orç.</span>` : ""}
    </div>
  `;
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", String(lead.id));
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  card.addEventListener("click", () => openModal(lead.id));
  return card;
}

function renderList(filtered) {
  const sorted = [...filtered].sort((a, b) => {
    const f = state.sort.field;
    let av = a[f] ?? "", bv = b[f] ?? "";
    if (f === "num_orcamentos") { av = Number(av); bv = Number(bv); }
    if (av < bv) return state.sort.dir === "asc" ? -1 : 1;
    if (av > bv) return state.sort.dir === "asc" ? 1 : -1;
    return 0;
  });
  const tbody = $("#list-tbody");
  tbody.innerHTML = "";
  const MAX_ROWS = 400;
  sorted.slice(0, MAX_ROWS).forEach((l) => {
    const tr = document.createElement("tr");
    const statusClass = "status-" + (l.status || "").toLowerCase().replace(/[^a-z]+/g, "-").replace(/(^-|-$)/g, "");
    tr.innerHTML = `
      <td>${escapeHtml(l.cliente_empresa)}</td>
      <td>${escapeHtml(l.contato)}</td>
      <td>${escapeHtml(l.segmento)}</td>
      <td>${escapeHtml(l.cidade)}</td>
      <td>${escapeHtml(l.vendedor)}</td>
      <td><span class="status-pill ${statusClass}">${escapeHtml(l.status)}</span></td>
      <td>${escapeHtml(l.proximo_contato)}</td>
    `;
    tr.addEventListener("click", () => openModal(l.id));
    tbody.appendChild(tr);
  });
  if (sorted.length > MAX_ROWS) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="7" style="text-align:center;color:var(--muted);padding:14px;">
      Mostrando ${MAX_ROWS} de ${sorted.length} — refine a busca ou os filtros para ver mais.</td>`;
    tbody.appendChild(tr);
  }
}

async function loadStatsOnly() {
  const stats = await api("/stats");
  renderStats(stats);
}

// ---------- Calendário ----------

function collectCalendarEvents() {
  const { search, vendedor, cidade, segmento } = state.filters;
  const s = search.trim().toLowerCase();
  const leadPasses = (l) => {
    if (vendedor && l.vendedor !== vendedor) return false;
    if (cidade && l.cidade !== cidade) return false;
    if (segmento && l.segmento !== segmento) return false;
    if (s) {
      const hay = `${l.cliente_empresa} ${l.contato} ${l.cidade} ${l.segmento} ${l.tipo_obra}`.toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const events = [];
  state.leads.forEach((lead) => {
    if (!leadPasses(lead)) return;
    const d = parseLooseDate(lead.proximo_contato);
    if (d && isUpcoming(d, today)) events.push({ ...d, type: "contato", lead });
  });
  state.activities.forEach((act) => {
    const lead = state.leads.find((l) => l.id === act.lead_id);
    if (!lead || !leadPasses(lead)) return;
    const d = parseLooseDate(act.data_followup);
    if (d && isUpcoming(d, today)) events.push({ ...d, type: "followup", lead, activity: act });
  });
  return events;
}

function renderCalendar() {
  const events = collectCalendarEvents();
  const { year, month } = state.calendar;
  $("#calendar-month-label").textContent = `${MONTH_NAMES[month]} ${year}`;

  const exactByDay = {};
  const unscheduled = [];
  events.forEach((e) => {
    if (e.year !== year || e.month !== month) return;
    if (e.exact) {
      (exactByDay[e.day] = exactByDay[e.day] || []).push(e);
    } else {
      unscheduled.push(e);
    }
  });

  const grid = $("#calendar-grid");
  grid.innerHTML = "";
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() === month;

  const eventLabel = (e) => e.type === "followup"
    ? `🔔 ${e.lead.cliente_empresa}`
    : `📞 ${e.lead.cliente_empresa}`;
  const eventTitle = (e) => e.type === "followup"
    ? `Follow-up: ${e.activity.assunto || "sem assunto"}`
    : "Próximo contato";

  for (let i = 0; i < firstDow; i++) {
    const cell = document.createElement("div");
    cell.className = "calendar-day other-month";
    grid.appendChild(cell);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement("div");
    cell.className = "calendar-day" + (isCurrentMonth && day === now.getDate() ? " today" : "");
    const dayEvents = exactByDay[day] || [];
    const numberEl = document.createElement("div");
    numberEl.className = "calendar-day-number";
    numberEl.textContent = day;
    cell.appendChild(numberEl);
    const list = document.createElement("div");
    list.className = "calendar-day-events";
    dayEvents.slice(0, 4).forEach((e) => {
      const chip = document.createElement("div");
      chip.className = "calendar-event calendar-event-" + e.type;
      chip.textContent = eventLabel(e);
      chip.title = eventTitle(e);
      chip.addEventListener("click", () => openModal(e.lead.id));
      list.appendChild(chip);
    });
    if (dayEvents.length > 4) {
      const more = document.createElement("div");
      more.className = "calendar-event-more";
      more.textContent = `+${dayEvents.length - 4} mais`;
      list.appendChild(more);
    }
    cell.appendChild(list);
    grid.appendChild(cell);
  }

  const unschedWrap = $("#calendar-unscheduled");
  const unschedList = unschedWrap.querySelector(".calendar-unscheduled-list");
  unschedList.innerHTML = "";
  if (unscheduled.length) {
    unschedWrap.classList.remove("hidden");
    unscheduled.forEach((e) => {
      const chip = document.createElement("span");
      chip.className = "calendar-event calendar-event-" + e.type;
      chip.textContent = eventLabel(e);
      chip.title = eventTitle(e);
      chip.addEventListener("click", () => openModal(e.lead.id));
      unschedList.appendChild(chip);
    });
  } else {
    unschedWrap.classList.add("hidden");
  }

  $("#calendar-count").textContent = `${events.length} compromisso${events.length === 1 ? "" : "s"} a partir de hoje`;
}

// ---------- Modal ----------

function openModal(id) {
  state.editingId = id;
  const lead = state.leads.find((l) => l.id === id);
  $("#modal-title").textContent = lead ? "Editar Lead" : "Novo Lead";
  $("#f-cliente").value = lead ? lead.cliente_empresa : "";
  $("#f-contato").value = lead ? lead.contato || "" : "";
  $("#f-cargo").value = lead ? lead.cargo || "" : "";
  $("#f-tel1").value = lead ? lead.telefone1 || "" : "";
  $("#f-tel2").value = lead ? lead.telefone2 || "" : "";
  $("#f-email").value = lead ? lead.email || "" : "";
  const segValue = lead ? lead.segmento || "" : "";
  const knownSegmento = !segValue || state.meta.segmentos.includes(segValue);
  $("#f-segmento").value = knownSegmento ? segValue : "Outros";
  $("#f-segmento-outro").value = knownSegmento ? "" : segValue;
  $("#f-segmento-outro-wrap").classList.toggle("hidden", knownSegmento);
  $("#f-cidade").value = lead ? lead.cidade : "";
  $("#f-vendedor").value = lead ? lead.vendedor || "" : "";
  $("#f-status").value = lead ? lead.status : (STATUS_GROUPS[state.tab] ? STATUS_GROUPS[state.tab][0] : state.meta.status_options[0]);
  $("#f-num").value = lead ? lead.num_orcamentos : 0;
  $("#f-tipo").value = lead ? lead.tipo_obra || "" : "";
  $("#f-primeiro-contato").value = lead ? lead.primeiro_contato || "" : "";
  $("#f-proximo-contato").value = lead ? lead.proximo_contato || "" : "";
  $("#f-primeiro").value = lead ? lead.primeiro_orcamento : "";
  $("#f-ultimo").value = lead ? lead.ultimo_orcamento : "";
  $("#f-notas").value = lead ? lead.notas : "";
  $("#f-origem").value = lead ? lead.origem : "";
  $("#delete-btn").classList.toggle("hidden", !lead);
  $("#a-data").value = new Date().toISOString().slice(0, 10);
  $("#a-assunto").value = "";
  $("#a-resultado").value = "";
  $("#a-proxima").value = "";
  $("#a-followup").value = "";

  const wrap = $("#f-orcamentos-wrap");
  const list = $("#f-orcamentos-list");
  list.innerHTML = "";
  const actWrap = $("#f-activities-wrap");

  if (lead) {
    actWrap.classList.remove("hidden");
    api(`/leads/${id}`).then((full) => {
      if (full.orcamentos && full.orcamentos.length) {
        wrap.classList.remove("hidden");
        full.orcamentos.forEach((url) => {
          const li = document.createElement("li");
          li.innerHTML = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
          list.appendChild(li);
        });
      } else {
        wrap.classList.add("hidden");
      }
      renderActivities(full.activities || []);
    });
  } else {
    wrap.classList.add("hidden");
    actWrap.classList.add("hidden");
  }

  $("#modal-backdrop").classList.remove("hidden");
}

function renderActivities(activities) {
  const list = $("#f-activities-list");
  list.innerHTML = "";
  if (!activities.length) {
    list.innerHTML = `<li class="activity-empty">Nenhuma interação registrada ainda.</li>`;
    return;
  }
  activities.forEach((a) => {
    const li = document.createElement("li");
    li.className = "activity-item";
    li.innerHTML = `
      <div class="activity-item-top">
        <span class="activity-date">${escapeHtml(a.data)}</span>
        ${a.canal ? `<span class="activity-canal">${escapeHtml(a.canal)}</span>` : ""}
      </div>
      ${a.assunto ? `<div class="activity-assunto">${escapeHtml(a.assunto)}</div>` : ""}
      ${a.resultado ? `<div class="activity-meta">Resultado: ${escapeHtml(a.resultado)}</div>` : ""}
      ${a.proxima_acao ? `<div class="activity-meta">Próxima ação: ${escapeHtml(a.proxima_acao)}${a.data_followup ? ` (${escapeHtml(a.data_followup)})` : ""}</div>` : ""}
    `;
    list.appendChild(li);
  });
}

async function addActivity() {
  if (!state.editingId) return;
  const payload = {
    data: $("#a-data").value || new Date().toISOString().slice(0, 10),
    canal: $("#a-canal").value,
    assunto: $("#a-assunto").value.trim(),
    resultado: $("#a-resultado").value.trim(),
    proxima_acao: $("#a-proxima").value.trim(),
    data_followup: $("#a-followup").value,
  };
  if (!payload.assunto) {
    alert("Descreva o assunto do contato.");
    return;
  }
  try {
    await api(`/leads/${state.editingId}/activities`, { method: "POST", body: JSON.stringify(payload) });
    const updated = await api(`/leads/${state.editingId}`);
    renderActivities(updated.activities || []);
    state.activities = await api("/activities");
    renderTabCounts();
    $("#a-assunto").value = "";
    $("#a-resultado").value = "";
    $("#a-proxima").value = "";
    $("#a-followup").value = "";
  } catch (err) {
    alert("Erro ao registrar interação: " + err.message);
  }
}

function closeModal() {
  $("#modal-backdrop").classList.add("hidden");
  state.editingId = null;
}

async function saveLead() {
  const segmentoSel = $("#f-segmento").value;
  const segmento = segmentoSel === "Outros" ? $("#f-segmento-outro").value.trim() : segmentoSel;
  const payload = {
    cliente_empresa: $("#f-cliente").value.trim(),
    contato: $("#f-contato").value.trim(),
    cargo: $("#f-cargo").value.trim(),
    telefone1: $("#f-tel1").value.trim(),
    telefone2: $("#f-tel2").value.trim(),
    email: $("#f-email").value.trim(),
    segmento: segmento,
    cidade: $("#f-cidade").value.trim(),
    vendedor: $("#f-vendedor").value,
    status: $("#f-status").value,
    tipo_obra: $("#f-tipo").value.trim(),
    num_orcamentos: Number($("#f-num").value) || 0,
    primeiro_contato: $("#f-primeiro-contato").value,
    proximo_contato: $("#f-proximo-contato").value.trim(),
    primeiro_orcamento: $("#f-primeiro").value,
    ultimo_orcamento: $("#f-ultimo").value,
    notas: $("#f-notas").value.trim(),
    origem: $("#f-origem").value.trim(),
  };
  if (!payload.cliente_empresa) {
    alert("Informe o nome do cliente/empresa.");
    return;
  }
  try {
    if (state.editingId) {
      await api(`/leads/${state.editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      await api("/leads", { method: "POST", body: JSON.stringify(payload) });
    }
    closeModal();
    await loadAll();
  } catch (err) {
    alert("Erro ao salvar: " + err.message);
  }
}

async function deleteLead() {
  if (!state.editingId) return;
  if (!confirm("Tem certeza que deseja excluir este lead?")) return;
  try {
    await api(`/leads/${state.editingId}`, { method: "DELETE" });
    closeModal();
    await loadAll();
  } catch (err) {
    alert("Erro ao excluir: " + err.message);
  }
}

// ---------- Events ----------

$$(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.tab = btn.dataset.tab;
    state.columnLimits = {};
    render();
  });
});

$$(".view-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".view-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.view = btn.dataset.view;
    $("#kanban-view").classList.toggle("hidden", state.view !== "kanban");
    $("#list-view").classList.toggle("hidden", state.view !== "list");
    render();
  });
});

$("#search-input").addEventListener("input", (e) => {
  state.filters.search = e.target.value;
  render();
});
$("#filter-vendedor").addEventListener("change", (e) => {
  state.filters.vendedor = e.target.value;
  render();
});
$("#filter-segmento").addEventListener("change", (e) => {
  state.filters.segmento = e.target.value;
  render();
});
$("#filter-cidade").addEventListener("change", (e) => {
  state.filters.cidade = e.target.value;
  render();
});
$("#f-segmento").addEventListener("change", (e) => {
  const isOutros = e.target.value === "Outros";
  $("#f-segmento-outro-wrap").classList.toggle("hidden", !isOutros);
  if (isOutros) {
    $("#f-segmento-outro").focus();
  } else {
    $("#f-segmento-outro").value = "";
  }
});
$("#cal-prev-btn").addEventListener("click", () => {
  state.calendar.month--;
  if (state.calendar.month < 0) { state.calendar.month = 11; state.calendar.year--; }
  renderCalendar();
});
$("#cal-next-btn").addEventListener("click", () => {
  state.calendar.month++;
  if (state.calendar.month > 11) { state.calendar.month = 0; state.calendar.year++; }
  renderCalendar();
});
$("#cal-today-btn").addEventListener("click", () => {
  const t = new Date();
  state.calendar = { year: t.getFullYear(), month: t.getMonth() };
  renderCalendar();
});

$("#clear-filters-btn").addEventListener("click", () => {
  state.filters = { search: "", vendedor: "", cidade: "", segmento: "" };
  $("#search-input").value = "";
  $("#filter-vendedor").value = "";
  $("#filter-segmento").value = "";
  $("#filter-cidade").value = "";
  render();
});

$$("th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const field = th.dataset.sort;
    if (state.sort.field === field) {
      state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    } else {
      state.sort.field = field;
      state.sort.dir = "asc";
    }
    render();
  });
});

$("#new-lead-btn").addEventListener("click", () => openModal(null));
$("#modal-close").addEventListener("click", closeModal);
$("#cancel-btn").addEventListener("click", closeModal);
$("#save-btn").addEventListener("click", saveLead);
$("#delete-btn").addEventListener("click", deleteLead);
$("#add-activity-btn").addEventListener("click", addActivity);
$("#modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "modal-backdrop") closeModal();
});

loadAll().catch((err) => {
  document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#d64545;">
    Erro ao carregar dados: ${escapeHtml(err.message)}</div>`;
});
