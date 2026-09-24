// Aba "Mapa Comercial" — território por vendedor nos municípios de RS/SC/PR.
// Portado da ferramenta HTML autônoma enviada por e-mail, adaptado para:
//   - carregar a geometria dos municípios de um arquivo estático (mapa-data.json)
//   - carregar/gravar as regiões e atribuições no CRM (GET/PUT /api/map-data)
//   - só o administrador pode editar; vendedores só visualizam.
(function () {
  const PALETTE = ["#c5e1a5", "#d1c4e9", "#ffcc80", "#90caf9", "#f48fb1", "#80cbc4", "#ffe082", "#bcaaa4", "#ef9a9a", "#a5d6a7"];

  let MAP = null;
  let regions = [];
  let assign = {}; // municipioCodigo -> regionId
  let activeRegionId = null;
  let nextRegionNum = 1;
  let loaded = false;
  let dirty = false;
  let saving = false;

  let svg, mapwrap, tooltip, vb;

  function editable() {
    return typeof isAdmin === "function" && isAdmin();
  }

  function regionById(id) {
    return regions.find((r) => r.id === id);
  }

  function markDirty() {
    dirty = true;
    const btn = document.getElementById("mapa-save-btn");
    if (btn) btn.textContent = "Salvar alterações*";
  }

  function buildSvg() {
    svg.innerHTML = "";
    const muniGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    MAP.municipios.forEach((m) => {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", m.d);
      p.setAttribute("class", "mapa-muni");
      p.setAttribute("data-c", m.c);
      p.setAttribute("fill-rule", "evenodd");
      muniGroup.appendChild(p);
      m._el = p;
    });
    svg.appendChild(muniGroup);
    const borderGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    Object.entries(MAP.estados).forEach(([uf, d]) => {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d);
      p.setAttribute("class", "mapa-state-border");
      p.setAttribute("fill-rule", "evenodd");
      borderGroup.appendChild(p);
    });
    svg.appendChild(borderGroup);
  }

  function repaint() {
    MAP.municipios.forEach((m) => {
      const rid = assign[m.c];
      const r = rid ? regionById(rid) : null;
      m._el.setAttribute("fill", r ? r.color : "#e4e6e0");
    });
  }

  function renderRegions() {
    const box = document.getElementById("mapa-regions-box");
    box.innerHTML = "";
    regions.forEach((r) => {
      const count = Object.values(assign).filter((v) => v === r.id).length;
      const row = document.createElement("div");
      row.className = "mapa-region-row" + (activeRegionId === r.id ? " active" : "");
      if (editable()) {
        row.innerHTML = `
          <input type="color" class="mapa-swatch" value="${r.color}">
          <input type="text" class="mapa-region-name" value="${r.name.replace(/"/g, "&quot;")}">
          <span class="mapa-region-count">${count} mun.</span>
          <button class="mapa-region-del" title="Remover região">✕</button>
        `;
        row.querySelector(".mapa-swatch").addEventListener("input", (e) => {
          r.color = e.target.value;
          repaint();
          markDirty();
        });
        row.querySelector(".mapa-swatch").addEventListener("click", (e) => e.stopPropagation());
        row.querySelector(".mapa-region-name").addEventListener("click", (e) => e.stopPropagation());
        row.querySelector(".mapa-region-name").addEventListener("change", (e) => {
          r.name = e.target.value;
          markDirty();
        });
        row.querySelector(".mapa-region-del").addEventListener("click", (e) => {
          e.stopPropagation();
          if (!confirm(`Remover a região "${r.name}"? Os municípios atribuídos a ela ficarão sem atribuição.`)) return;
          regions = regions.filter((x) => x.id !== r.id);
          Object.keys(assign).forEach((k) => { if (assign[k] === r.id) delete assign[k]; });
          if (activeRegionId === r.id) activeRegionId = regions[0] ? regions[0].id : null;
          markDirty();
          renderRegions();
          repaint();
          renderStats();
        });
      } else {
        row.innerHTML = `
          <span class="mapa-swatch" style="background:${r.color};border-radius:5px;display:inline-block;width:20px;height:20px;"></span>
          <span class="mapa-region-name" style="cursor:default;">${escapeMapaHtml(r.name)}</span>
          <span class="mapa-region-count">${count} mun.</span>
        `;
      }
      row.addEventListener("click", () => {
        if (!editable()) return;
        activeRegionId = r.id;
        renderRegions();
      });
      box.appendChild(row);
    });

    if (editable()) {
      const addBtn = document.createElement("button");
      addBtn.id = "mapa-add-region-btn";
      addBtn.textContent = "+ Adicionar região";
      addBtn.addEventListener("click", () => {
        const name = prompt("Nome da nova região (ex: vendedor):", "Região " + nextRegionNum);
        if (!name) return;
        const color = PALETTE[(nextRegionNum - 1) % PALETTE.length];
        const id = "r" + Date.now();
        regions.push({ id, name, color });
        nextRegionNum++;
        activeRegionId = id;
        markDirty();
        renderRegions();
      });
      box.appendChild(addBtn);
    }
  }

  function escapeMapaHtml(str) {
    if (str == null) return "";
    return String(str).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[m]);
  }

  function renderStats() {
    const total = MAP.municipios.length;
    const assigned = Object.keys(assign).length;
    const el = document.getElementById("mapa-stats");
    el.textContent = `${assigned} de ${total} municípios atribuídos (RS ${MAP.municipios.filter((m) => m.uf === "RS").length} · SC ${MAP.municipios.filter((m) => m.uf === "SC").length} · PR ${MAP.municipios.filter((m) => m.uf === "PR").length})`;
  }

  function setViewBox(x, y, w, h) {
    vb = [x, y, w, h];
    svg.setAttribute("viewBox", vb.join(" "));
  }

  function zoomAt(px, py, factor) {
    const [x, y, w, h] = vb;
    const nw = w * factor, nh = h * factor;
    const nx = px - (px - x) * factor;
    const ny = py - (py - y) * factor;
    setViewBox(nx, ny, nw, nh);
  }

  function focusMuni(m) {
    const [x0, y0, x1, y1] = m.b;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const w = Math.max((x1 - x0) * 4, 40), h = Math.max((y1 - y0) * 4, 40);
    setViewBox(cx - w / 2, cy - h / 2, w, h);
  }

  let wired = false;
  function wireInteractions() {
    if (wired) return;
    wired = true;

    svg.addEventListener("click", (e) => {
      if (!editable()) return;
      const t = e.target;
      if (!t.classList || !t.classList.contains("mapa-muni")) return;
      if (!activeRegionId) { alert("Selecione uma região na barra lateral primeiro."); return; }
      const c = t.getAttribute("data-c");
      if (assign[c] === activeRegionId) delete assign[c];
      else assign[c] = activeRegionId;
      markDirty();
      repaint();
      renderRegions();
      renderStats();
    });

    svg.addEventListener("mousemove", (e) => {
      const t = e.target;
      if (!t.classList || !t.classList.contains("mapa-muni")) { tooltip.style.display = "none"; return; }
      const c = t.getAttribute("data-c");
      const m = MAP.municipios.find((x) => x.c === c);
      const rid = assign[c];
      const r = rid ? regionById(rid) : null;
      tooltip.textContent = `${m.n} — ${m.uf} — ${r ? r.name : "sem atribuição"}`;
      const rect = mapwrap.getBoundingClientRect();
      tooltip.style.left = e.clientX - rect.left + 14 + "px";
      tooltip.style.top = e.clientY - rect.top + 10 + "px";
      tooltip.style.display = "block";
    });
    svg.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });

    const searchBox = document.getElementById("mapa-search");
    const searchResults = document.getElementById("mapa-search-results");
    searchBox.addEventListener("input", () => {
      const q = searchBox.value.trim().toLowerCase();
      searchResults.innerHTML = "";
      if (q.length < 2) return;
      const matches = MAP.municipios.filter((m) => m.n.toLowerCase().includes(q)).slice(0, 20);
      matches.forEach((m) => {
        const div = document.createElement("div");
        div.className = "mapa-sr-item";
        div.textContent = `${m.n} (${m.uf})`;
        div.addEventListener("click", () => focusMuni(m));
        searchResults.appendChild(div);
      });
    });

    document.getElementById("mapa-zoom-in").addEventListener("click", () => zoomAt(MAP.width / 2, MAP.height / 2, 0.8));
    document.getElementById("mapa-zoom-out").addEventListener("click", () => zoomAt(MAP.width / 2, MAP.height / 2, 1.25));
    document.getElementById("mapa-zoom-reset").addEventListener("click", () => setViewBox(0, 0, MAP.width, MAP.height));

    mapwrap.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = mapwrap.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;
      const [x, y, w, h] = vb;
      const px = x + mx * w, py = y + my * h;
      zoomAt(px, py, e.deltaY > 0 ? 1.12 : 0.89);
    }, { passive: false });

    let dragging = false, lastX = 0, lastY = 0;
    mapwrap.addEventListener("mousedown", (e) => {
      if (e.target.classList && e.target.classList.contains("mapa-muni")) {
        lastX = e.clientX; lastY = e.clientY; dragging = "maybe"; return;
      }
      dragging = true; lastX = e.clientX; lastY = e.clientY; mapwrap.classList.add("dragging");
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (dragging === "maybe" && Math.hypot(dx, dy) > 4) { dragging = true; mapwrap.classList.add("dragging"); }
      if (dragging === true) {
        const rect = mapwrap.getBoundingClientRect();
        const [x, y, w, h] = vb;
        setViewBox(x - dx * (w / rect.width), y - dy * (h / rect.height), w, h);
        lastX = e.clientX; lastY = e.clientY;
      }
    });
    window.addEventListener("mouseup", () => { dragging = false; mapwrap.classList.remove("dragging"); });

    document.getElementById("mapa-save-btn").addEventListener("click", async () => {
      if (saving) return;
      saving = true;
      const btn = document.getElementById("mapa-save-btn");
      btn.disabled = true;
      btn.textContent = "Salvando…";
      try {
        await api("/map-data", { method: "PUT", body: JSON.stringify({ regions, assign }) });
        dirty = false;
        btn.textContent = "Salvar alterações";
      } catch (err) {
        alert("Erro ao salvar o mapa: " + err.message);
        btn.textContent = "Salvar alterações*";
      } finally {
        saving = false;
        btn.disabled = false;
      }
    });

    document.getElementById("mapa-clear-btn").addEventListener("click", () => {
      if (!editable()) return;
      if (!confirm("Remover todas as atribuições de município?")) return;
      assign = {};
      markDirty();
      repaint();
      renderRegions();
      renderStats();
    });

    window.addEventListener("beforeunload", (e) => {
      if (dirty && editable()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  async function ensureLoaded() {
    if (loaded) return;
    svg = document.getElementById("mapa-svg");
    mapwrap = document.getElementById("mapa-mapwrap");
    tooltip = document.getElementById("mapa-tooltip");
    const loadingEl = document.getElementById("mapa-loading");
    loadingEl.classList.remove("hidden");
    try {
      const [mapData, apiData] = await Promise.all([
        fetch("/mapa-data.json").then((r) => {
          if (!r.ok) throw new Error("Não foi possível carregar a geometria do mapa.");
          return r.json();
        }),
        api("/map-data"),
      ]);
      MAP = mapData;
      regions = apiData.regions || [];
      assign = apiData.assign || {};
      nextRegionNum = regions.length + 1;
      activeRegionId = regions[0] ? regions[0].id : null;
      svg.setAttribute("viewBox", `0 0 ${MAP.width} ${MAP.height}`);
      buildSvg();
      renderRegions();
      repaint();
      renderStats();
      setViewBox(0, 0, MAP.width, MAP.height);
      wireInteractions();
      loaded = true;
    } finally {
      loadingEl.classList.add("hidden");
    }
  }

  window.MapaComercial = {
    show: function () {
      document.getElementById("mapa-admin-actions").classList.toggle("hidden", !editable());
      document.getElementById("mapa-readonly-note").classList.toggle("hidden", editable());
      ensureLoaded().catch((err) => {
        alert("Erro ao carregar o mapa comercial: " + err.message);
      });
      if (loaded) renderRegions(); // refaz a lista com/sem controles de edição, caso o papel do usuário tenha mudado
    },
  };
})();
