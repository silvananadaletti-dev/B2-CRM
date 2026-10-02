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

  // --- Visão nacional (Brasil) --------------------------------------------
  // Estados com território editável por município (o resto do Brasil só
  // mostra se há proposta ativa ou não, sem edição por enquanto).
  const ESTADOS_TERRITORIO = ["RS", "SC", "PR"];
  let brasilLoaded = false;
  let brasilData = null; // { viewBox, states: [{uf, nome, d}] }
  let estadosAtivos = [];
  let brasilView = true; // true = mapa do Brasil; false = detalhe RS/SC/PR
  let vbBrasil = null; // viewBox atual do svg do Brasil [x, y, w, h], pro zoom
  let wiredBrasil = false;

  // --- Resumo visual de negócios em andamento, por vendedor ---------------
  // Pedido pela Sil em 01/10/2026: mostrar no mapa, dentro de cada cidade,
  // os negócios em andamento (status "Em orçamento", "Negociação" e
  // "Cliente" — a própria API /map-data já filtra isso, ver map-data.mjs),
  // com cliente e valor, e cada vendedor numa cor diferente. Um ponto no
  // mapa = um lead; a cor do ponto é o vendedor dele.
  // Em 01/10/2026 ela pediu mais 3 coisas: (1) o mapa do Brasil INTEIRO, não
  // só RS/SC/PR — resolvido com brasil-municipios-xy.json, uma projeção
  // aproximada lat/long -> xy calibrada contra o contorno dos 27 estados
  // (ver script de geração, não versionado aqui: ajuste por mínimos
  // quadrados usando o centro de cada estado); (2) poder escolher ver todos
  // os vendedores ou só alguns — clicar num vendedor na legenda liga/desliga
  // ele, em ambos os mapas; (3) destacar quem está em "Negociação" — esses
  // pontos ganham um contorno amarelo (classe mapa-negocio-dot--negociacao).
  const VENDEDOR_PALETTE = [
    "#e53935", "#1e88e5", "#43a047", "#fb8c00", "#8e24aa",
    "#00897b", "#c0ca33", "#6d4c41", "#d81b60", "#3949ab",
  ];
  const SEM_VENDEDOR_COLOR = "#9aa08e";
  let negocios = []; // array de leads cru, vindo da API (ver map-data.mjs)
  let vendedorColors = new Map(); // vendedor (string, "" = sem vendedor) -> cor
  let vendedorOcultos = new Set(); // vendedores que o usuário escondeu do mapa (filtro, vale pros 2 mapas)
  let negociosVisiveis = true; // camada ligada/desligada no mapa do território (RS/SC/PR)
  let negociosVisiveisBrasil = true; // camada ligada/desligada no mapa do Brasil
  let ufAggregates = new Map(); // UF -> { count, totalValor }
  let negociosPoints = []; // território (RS/SC/PR): [{x, y, color, ...negocio}]
  let negociosPointsBrasil = []; // Brasil inteiro: [{x, y, color, ...negocio}]
  let negociosLayer = null; // <g> no svg do território
  let negociosLayerBrasil = null; // <g> no svg do Brasil
  let muniIndexNacional = null; // "nome normalizado|UF" -> {x,y}, carregado sob demanda
  let cidadesTerritorio = []; // [{key, nome, x, y}] — 1 por município com negócio (território)
  let cidadesBrasil = []; // idem, mapa do Brasil inteiro
  let negociosLabelsLayer = null; // <g> de rótulos de cidade no território
  let negociosLabelsLayerBrasil = null; // <g> de rótulos de cidade no Brasil

  function normalizeCidade(str) {
    return String(str || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
  }

  function cidadeSemUF(cidade) {
    return String(cidade || "").replace(/,\s*[A-Za-z]{2}\s*$/, "").trim();
  }

  function formatBRL(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!isFinite(n)) return null;
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  }

  // Cor fixa por vendedor (ordem alfabética, estável entre recarregamentos) —
  // "" (sem vendedor) sempre usa a cor neutra SEM_VENDEDOR_COLOR, nunca uma
  // da paleta.
  function colorForVendedor(vendedor) {
    const v = vendedor || "";
    if (!v) return SEM_VENDEDOR_COLOR;
    if (!vendedorColors.has(v)) {
      const nomes = Array.from(new Set(negocios.map((n) => n.vendedor || ""))).filter(Boolean).sort();
      nomes.forEach((nome, i) => {
        if (!vendedorColors.has(nome)) vendedorColors.set(nome, VENDEDOR_PALETTE[i % VENDEDOR_PALETTE.length]);
      });
    }
    return vendedorColors.get(v) || SEM_VENDEDOR_COLOR;
  }

  // Carrega (uma vez só) a projeção aproximada dos ~5571 municípios do Brasil
  // pra coordenadas x/y do mapa nacional (brasil-estados.json).
  async function ensureMuniIndexNacional() {
    if (muniIndexNacional) return muniIndexNacional;
    const list = await fetch("/brasil-municipios-xy.json").then((r) => {
      if (!r.ok) throw new Error("Não foi possível carregar as coordenadas dos municípios.");
      return r.json();
    });
    muniIndexNacional = new Map();
    list.forEach((m) => {
      muniIndexNacional.set(normalizeCidade(m.n) + "|" + m.uf, m);
    });
    return muniIndexNacional;
  }

  // Agrega os negócios por UF (visão nacional) — conta e soma valor (quando
  // preenchido), independente de bater com um município específico. A UF já
  // vem resolvida do backend (ver map-data.mjs: inferUFs), que cobre tanto o
  // sufixo ", UF" quanto cidades antigas cadastradas sem ele.
  function buildUfAggregates() {
    ufAggregates = new Map();
    negocios.forEach((n) => {
      const uf = n.uf;
      if (!uf) return;
      if (!ufAggregates.has(uf)) ufAggregates.set(uf, { count: 0, totalValor: 0 });
      const agg = ufAggregates.get(uf);
      agg.count++;
      if (n.valor !== null && n.valor !== undefined && n.valor !== "") agg.totalValor += Number(n.valor) || 0;
    });
  }

  // Casa cada negócio (RS/SC/PR) com o município correspondente em MAP, pelo
  // nome normalizado + UF, e calcula um ponto (com leve espalhamento quando
  // há mais de um negócio no mesmo município, pra não ficarem 100% sobrepostos).
  function buildNegociosPoints() {
    negociosPoints = [];
    cidadesTerritorio = [];
    if (!MAP) return;
    const muniIndex = new Map(); // "nome normalizado|UF" -> município
    MAP.municipios.forEach((m) => {
      muniIndex.set(normalizeCidade(m.n) + "|" + m.uf, m);
    });
    const countPorMuni = new Map();
    negocios.forEach((n) => {
      const uf = n.uf;
      if (!uf || !ESTADOS_TERRITORIO.includes(uf)) return;
      const nome = normalizeCidade(cidadeSemUF(n.cidade));
      const m = muniIndex.get(nome + "|" + uf);
      if (!m) return;
      const [x0, y0, x1, y1] = m.b;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const idx = countPorMuni.get(m.c) || 0;
      countPorMuni.set(m.c, idx + 1);
      if (idx === 0) cidadesTerritorio.push({ key: m.c, nome: m.n, x: cx, y: cy });
      // Espalha em espiral (ângulo dourado) ao redor do centro do município.
      // Antes o raio máximo era baseado no tamanho do retângulo (bbox) do
      // município — em municípios grandes/compridos isso deixava pontos
      // "escapando" bem longe do centro, caindo fora da área real da cidade
      // (às vezes até fora do território desenhado). Agora o teto é um valor
      // fixo e pequeno, igual pra qualquer município: por mais negócios que
      // tenha na mesma cidade, o conjunto fica sempre bem agrupado nela.
      const angle = idx * 2.4;
      const radius = idx === 0 ? 0 : Math.min(0.6 + idx * 0.3, 5);
      negociosPoints.push({
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        color: colorForVendedor(n.vendedor),
        cliente_empresa: n.cliente_empresa,
        cidade: n.cidade,
        vendedor: n.vendedor,
        valor: n.valor,
        numero_proposta: n.numero_proposta,
        status: n.status,
        cidadeKey: m.c,
      });
    });
  }

  // Igual a buildNegociosPoints, mas pro mapa do Brasil inteiro (usa a
  // projeção aproximada de município em vez da geometria detalhada de
  // RS/SC/PR) — por isso o espalhamento entre negócios na mesma cidade é
  // bem menor (o mapa nacional é bem mais "zoomado out").
  function buildNegociosPointsBrasil() {
    negociosPointsBrasil = [];
    cidadesBrasil = [];
    if (!muniIndexNacional) return;
    const countPorMuni = new Map();
    negocios.forEach((n) => {
      if (!n.uf) return;
      const key = normalizeCidade(cidadeSemUF(n.cidade)) + "|" + n.uf;
      const m = muniIndexNacional.get(key);
      if (!m) return;
      const idx = countPorMuni.get(key) || 0;
      countPorMuni.set(key, idx + 1);
      if (idx === 0) cidadesBrasil.push({ key, nome: m.n, x: m.x, y: m.y });
      const angle = idx * 2.4;
      const radius = idx === 0 ? 0 : Math.min(0.35 + idx * 0.2, 1.8);
      negociosPointsBrasil.push({
        x: m.x + Math.cos(angle) * radius,
        y: m.y + Math.sin(angle) * radius,
        color: colorForVendedor(n.vendedor),
        cliente_empresa: n.cliente_empresa,
        cidade: n.cidade,
        vendedor: n.vendedor,
        valor: n.valor,
        numero_proposta: n.numero_proposta,
        status: n.status,
        cidadeKey: key,
      });
    });
  }

  // Liga/desliga um vendedor no filtro (clicável tanto na legenda do mapa do
  // território quanto na do mapa do Brasil) — reflete nos dois mapas juntos.
  function toggleVendedorFiltro(v) {
    if (vendedorOcultos.has(v)) vendedorOcultos.delete(v);
    else vendedorOcultos.add(v);
    renderNegociosLegend("mapa-negocios-legend", "mapa-negocios-summary", negociosPoints.length);
    renderNegociosLegend("mapa-brasil-negocios-legend", "mapa-brasil-negocios-summary", negociosPointsBrasil.length);
    renderNegociosLegend("mapa-overlay-legend", null, negociosPoints.length);
    renderNegociosLegend("mapa-brasil-overlay-legend", null, negociosPointsBrasil.length);
    renderNegociosLayer();
    renderNegociosLayerBrasil();
  }

  // summaryId é opcional — a legenda flutuante em cima do mapa (pedida pela
  // Sil em 02/10/2026: "trazer no mapa a opção de selecionar os vendedores
  // por cor", pra não depender só do painel lateral, que em telas mais
  // estreitas pode ficar fora da área visível) não tem um texto de resumo,
  // só a lista de vendedores clicável.
  function renderNegociosLegend(boxId, summaryId, localizados) {
    const box = document.getElementById(boxId);
    const summary = summaryId ? document.getElementById(summaryId) : null;
    if (!box || (summaryId && !summary)) return;
    const porVendedor = new Map(); // vendedor ("" = sem vendedor) -> count
    negocios.forEach((n) => {
      const v = n.vendedor || "";
      porVendedor.set(v, (porVendedor.get(v) || 0) + 1);
    });
    const entries = Array.from(porVendedor.entries()).sort((a, b) => {
      if (!a[0]) return 1; // "sem vendedor" sempre por último
      if (!b[0]) return -1;
      return b[1] - a[1]; // maior contagem primeiro
    });
    box.innerHTML = entries.map(([v, count]) => `
      <div class="mapa-negocio-legend-item${vendedorOcultos.has(v) ? " off" : ""}" data-v="${escapeMapaHtml(v)}" title="Clique pra mostrar/ocultar">
        <span class="mapa-negocio-legend-swatch" style="background:${colorForVendedor(v)}"></span>
        <span>${escapeMapaHtml(v || "Sem vendedor")}</span>
        <span class="mapa-negocio-legend-count">${count}</span>
      </div>
    `).join("");
    box.querySelectorAll(".mapa-negocio-legend-item").forEach((el) => {
      el.addEventListener("click", () => toggleVendedorFiltro(el.getAttribute("data-v")));
    });
    if (summary) {
      summary.textContent = negocios.length
        ? `${negocios.length} negócios em andamento (Em orçamento, Negociação e Cliente) — ${localizados} localizados no mapa`
        : "Nenhum negócio em andamento no momento.";
    }
  }

  function negocioDotClass(p) {
    return "mapa-negocio-dot" + (p.status === "Negociação" ? " mapa-negocio-dot--negociacao" : "");
  }

  function renderNegociosLayer() {
    if (!svg) return;
    if (negociosLayer) negociosLayer.remove();
    negociosLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    negociosLayer.setAttribute("id", "mapa-negocios-layer");
    negociosLayer.style.display = negociosVisiveis ? "" : "none";
    negociosPoints.forEach((p) => {
      if (vendedorOcultos.has(p.vendedor || "")) return;
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", p.x);
      c.setAttribute("cy", p.y);
      c.setAttribute("r", 0.8);
      c.setAttribute("fill", p.color);
      c.setAttribute("class", negocioDotClass(p));
      c.addEventListener("mousemove", (e) => {
        e.stopPropagation(); // senão o listener do svg (abaixo) apaga esse tooltip por cima
        const valorFmt = formatBRL(p.valor);
        const partes = [
          p.cliente_empresa,
          p.cidade,
          p.vendedor || "sem vendedor",
        ];
        if (valorFmt) partes.push(valorFmt);
        if (p.numero_proposta) partes.push("Proposta " + p.numero_proposta);
        if (p.status === "Negociação") partes.push("EM NEGOCIAÇÃO");
        tooltip.textContent = partes.join(" — ");
        const rect = mapwrap.getBoundingClientRect();
        tooltip.style.left = e.clientX - rect.left + 14 + "px";
        tooltip.style.top = e.clientY - rect.top + 10 + "px";
        tooltip.style.display = "block";
      });
      c.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
      negociosLayer.appendChild(c);
    });
    svg.appendChild(negociosLayer);
    renderNegociosLabelsTerritorio();
  }

  // Rótulo com o nome da cidade, 1 por município que tenha pelo menos 1
  // negócio visível (considerando o filtro de vendedor) — pedido pela Sil
  // em 01/10/2026: "mostrar as cidades no mapa". Fica achado automaticamente
  // toda vez que os pontos são redesenhados (filtro de vendedor, recarga).
  function renderNegociosLabelsTerritorio() {
    if (!svg) return;
    if (negociosLabelsLayer) negociosLabelsLayer.remove();
    negociosLabelsLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    negociosLabelsLayer.setAttribute("id", "mapa-negocios-labels");
    negociosLabelsLayer.style.display = negociosVisiveis ? "" : "none";
    cidadesTerritorio.forEach((c) => {
      const visivel = negociosPoints.some((p) => p.cidadeKey === c.key && !vendedorOcultos.has(p.vendedor || ""));
      if (!visivel) return;
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", c.x);
      t.setAttribute("y", c.y - 2.6);
      t.setAttribute("class", "mapa-negocio-label");
      t.textContent = c.nome;
      negociosLabelsLayer.appendChild(t);
    });
    svg.appendChild(negociosLabelsLayer);
  }

  // Igual a renderNegociosLayer, mas desenha no svg do mapa do Brasil
  // inteiro (negociosPointsBrasil), usando o tooltip/wrap daquela visão.
  function renderNegociosLayerBrasil() {
    const brasilSvg = document.getElementById("mapa-brasil-svg");
    if (!brasilSvg) return;
    if (negociosLayerBrasil) negociosLayerBrasil.remove();
    negociosLayerBrasil = document.createElementNS("http://www.w3.org/2000/svg", "g");
    negociosLayerBrasil.setAttribute("id", "mapa-brasil-negocios-layer");
    negociosLayerBrasil.style.display = negociosVisiveisBrasil ? "" : "none";
    const tooltip2 = document.getElementById("mapa-brasil-tooltip");
    const wrap = document.getElementById("mapa-brasil-mapwrap");
    negociosPointsBrasil.forEach((p) => {
      if (vendedorOcultos.has(p.vendedor || "")) return;
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", p.x);
      c.setAttribute("cy", p.y);
      c.setAttribute("r", 0.5);
      c.setAttribute("fill", p.color);
      c.setAttribute("class", negocioDotClass(p));
      c.addEventListener("mousemove", (e) => {
        e.stopPropagation();
        const valorFmt = formatBRL(p.valor);
        const partes = [p.cliente_empresa, p.cidade, p.vendedor || "sem vendedor"];
        if (valorFmt) partes.push(valorFmt);
        if (p.numero_proposta) partes.push("Proposta " + p.numero_proposta);
        if (p.status === "Negociação") partes.push("EM NEGOCIAÇÃO");
        tooltip2.textContent = partes.join(" — ");
        const rect = wrap.getBoundingClientRect();
        tooltip2.style.left = e.clientX - rect.left + 14 + "px";
        tooltip2.style.top = e.clientY - rect.top + 10 + "px";
        tooltip2.style.display = "block";
      });
      c.addEventListener("mouseleave", () => { tooltip2.style.display = "none"; });
      negociosLayerBrasil.appendChild(c);
    });
    brasilSvg.appendChild(negociosLayerBrasil);
    renderNegociosLabelsBrasil();
  }

  // Igual a renderNegociosLabelsTerritorio, mas pro mapa do Brasil inteiro.
  function renderNegociosLabelsBrasil() {
    const brasilSvg = document.getElementById("mapa-brasil-svg");
    if (!brasilSvg) return;
    if (negociosLabelsLayerBrasil) negociosLabelsLayerBrasil.remove();
    negociosLabelsLayerBrasil = document.createElementNS("http://www.w3.org/2000/svg", "g");
    negociosLabelsLayerBrasil.setAttribute("id", "mapa-brasil-negocios-labels");
    negociosLabelsLayerBrasil.style.display = negociosVisiveisBrasil ? "" : "none";
    cidadesBrasil.forEach((c) => {
      const visivel = negociosPointsBrasil.some((p) => p.cidadeKey === c.key && !vendedorOcultos.has(p.vendedor || ""));
      if (!visivel) return;
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", c.x);
      t.setAttribute("y", c.y - 1.6);
      t.setAttribute("class", "mapa-negocio-label mapa-negocio-label--brasil");
      t.textContent = c.nome;
      negociosLabelsLayerBrasil.appendChild(t);
    });
    brasilSvg.appendChild(negociosLabelsLayerBrasil);
  }

  async function ensureBrasilLoaded() {
    if (brasilLoaded) return;
    const loadingEl = document.getElementById("mapa-brasil-loading");
    loadingEl.classList.remove("hidden");
    try {
      const [geo, apiData] = await Promise.all([
        fetch("/brasil-estados.json").then((r) => {
          if (!r.ok) throw new Error("Não foi possível carregar o contorno dos estados.");
          return r.json();
        }),
        api("/map-data"),
        ensureMuniIndexNacional(),
      ]);
      brasilData = geo;
      estadosAtivos = apiData.estados_ativos || [];
      // Reaproveita regions/assign já buscados para não pedir de novo quando
      // o usuário clicar em RS/SC/PR (evita um round-trip extra).
      regions = apiData.regions || [];
      assign = apiData.assign || {};
      negocios = apiData.negocios || [];
      buildUfAggregates();
      nextRegionNum = regions.length + 1;
      activeRegionId = regions[0] ? regions[0].id : null;
      buildBrasilSvg();
      buildNegociosPointsBrasil();
      renderNegociosLayerBrasil();
      renderNegociosLegend("mapa-brasil-negocios-legend", "mapa-brasil-negocios-summary", negociosPointsBrasil.length);
      renderNegociosLegend("mapa-brasil-overlay-legend", null, negociosPointsBrasil.length);
      document.getElementById("mapa-brasil-negocios-toggle").addEventListener("change", (e) => {
        negociosVisiveisBrasil = e.target.checked;
        if (negociosLayerBrasil) negociosLayerBrasil.style.display = negociosVisiveisBrasil ? "" : "none";
        if (negociosLabelsLayerBrasil) negociosLabelsLayerBrasil.style.display = negociosVisiveisBrasil ? "" : "none";
      });
      wireBrasilInteractions();
      brasilLoaded = true;
    } finally {
      loadingEl.classList.add("hidden");
    }
  }

  // --- Zoom do mapa do Brasil ----------------------------------------------
  // Pedido pela Sil em 01/10/2026: "ficou muito pequeno quero que ao clicar
  // de zoom para ver as propostas" — o mapa do Brasil inteiro é pequeno
  // demais pra ver direito os pontos de negócio quando há muitos no mesmo
  // estado. Agora clicar em qualquer estado (fora RS/SC/PR, que já abrem o
  // detalhe por município) aproxima o zoom só naquele estado — mesmo
  // mecanismo de viewBox usado no mapa de território (setViewBox/zoomAt),
  // com seus próprios controles de +/-/reset e roda do mouse/arrastar.
  function setViewBoxBrasil(x, y, w, h) {
    vbBrasil = [x, y, w, h];
    document.getElementById("mapa-brasil-svg").setAttribute("viewBox", vbBrasil.join(" "));
  }

  function zoomAtBrasil(px, py, factor) {
    const [x, y, w, h] = vbBrasil;
    const nw = w * factor, nh = h * factor;
    const nx = px - (px - x) * factor;
    const ny = py - (py - y) * factor;
    setViewBoxBrasil(nx, ny, nw, nh);
  }

  function brasilFullViewBox() {
    return brasilData.viewBox.split(" ").map(Number);
  }

  function resetBrasilZoom() {
    const [x, y, w, h] = brasilFullViewBox();
    setViewBoxBrasil(x, y, w, h);
  }

  // Aproxima o zoom pro retângulo do estado clicado (com uma margem, pra não
  // colar nas bordas) — usa getBBox() do próprio <path> já desenhado.
  function focusEstado(pathEl) {
    const b = pathEl.getBBox();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const pad = 1.4;
    const w = Math.max(b.width * pad, 50), h = Math.max(b.height * pad, 50);
    setViewBoxBrasil(cx - w / 2, cy - h / 2, w, h);
  }

  function buildBrasilSvg() {
    const brasilSvg = document.getElementById("mapa-brasil-svg");
    brasilSvg.setAttribute("viewBox", brasilData.viewBox);
    brasilSvg.innerHTML = "";
    const tooltip2 = document.getElementById("mapa-brasil-tooltip");
    const wrap = document.getElementById("mapa-brasil-mapwrap");
    vbBrasil = brasilFullViewBox();

    brasilData.states.forEach((s) => {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", s.d);
      const isTerritorio = ESTADOS_TERRITORIO.includes(s.uf);
      const ativo = estadosAtivos.includes(s.uf);
      let cls = "mapa-brasil-state";
      if (isTerritorio) cls += " mapa-brasil-state--territorio";
      else if (ativo) cls += " mapa-brasil-state--ativo";
      else cls += " mapa-brasil-state--inativo";
      p.setAttribute("class", cls);
      p.addEventListener("mousemove", (e) => {
        const rect = wrap.getBoundingClientRect();
        const agg = ufAggregates.get(s.uf);
        const negocioTxt = agg
          ? `${agg.count} negócio${agg.count === 1 ? "" : "s"} em andamento${agg.totalValor ? " — " + formatBRL(agg.totalValor) : ""}`
          : "sem negócios em andamento";
        tooltip2.textContent = `${s.nome} — ${negocioTxt} — clique para aproximar`;
        tooltip2.style.left = e.clientX - rect.left + 14 + "px";
        tooltip2.style.top = e.clientY - rect.top + 10 + "px";
        tooltip2.style.display = "block";
      });
      p.addEventListener("mouseleave", () => { tooltip2.style.display = "none"; });
      // Pedido da Sil em 01/10/2026: clicar num estado (incluindo RS/SC/PR)
      // só dá zoom pra ver as propostas de perto, igual os outros estados —
      // antes RS/SC/PR pulava direto pra tela de atribuir território por
      // município, o que ela não queria mais nesse fluxo. Essa tela de
      // atribuição continua existindo, só que agora só se chega nela pelo
      // link "Editar território por vendedor" na legenda (ver wireBrasilInteractions).
      p.addEventListener("click", () => focusEstado(p));
      brasilSvg.appendChild(p);
    });
  }

  // Controles de zoom do mapa do Brasil: botões +/-/reset, roda do mouse e
  // arrastar pra navegar quando dado zoom — mesmo padrão do mapa de
  // território (wireInteractions), só que escalado pro svg/viewBox do
  // Brasil. Roda uma única vez (wiredBrasil evita duplicar os listeners
  // toda vez que a aba é reaberta, já que buildBrasilSvg só roda 1x).
  function wireBrasilInteractions() {
    if (wiredBrasil) return;
    wiredBrasil = true;

    const brasilSvg = document.getElementById("mapa-brasil-svg");
    const wrap = document.getElementById("mapa-brasil-mapwrap");

    document.getElementById("mapa-brasil-territorio-link").addEventListener("click", () => showDetalhe());

    document.getElementById("mapa-brasil-zoom-in").addEventListener("click", () => {
      zoomAtBrasil(vbBrasil[0] + vbBrasil[2] / 2, vbBrasil[1] + vbBrasil[3] / 2, 0.8);
    });
    document.getElementById("mapa-brasil-zoom-out").addEventListener("click", () => {
      zoomAtBrasil(vbBrasil[0] + vbBrasil[2] / 2, vbBrasil[1] + vbBrasil[3] / 2, 1.25);
    });
    document.getElementById("mapa-brasil-zoom-reset").addEventListener("click", () => resetBrasilZoom());

    wrap.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;
      const [x, y, w, h] = vbBrasil;
      const px = x + mx * w, py = y + my * h;
      zoomAtBrasil(px, py, e.deltaY > 0 ? 1.12 : 0.89);
    }, { passive: false });

    let dragging = false, lastX = 0, lastY = 0;
    wrap.addEventListener("mousedown", (e) => {
      if (e.target.classList && e.target.classList.contains("mapa-brasil-state")) {
        lastX = e.clientX; lastY = e.clientY; dragging = "maybe"; return;
      }
      dragging = true; lastX = e.clientX; lastY = e.clientY; wrap.classList.add("dragging");
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (dragging === "maybe" && Math.hypot(dx, dy) > 4) { dragging = true; wrap.classList.add("dragging"); }
      if (dragging === true) {
        const rect = wrap.getBoundingClientRect();
        const [x, y, w, h] = vbBrasil;
        setViewBoxBrasil(x - dx * (w / rect.width), y - dy * (h / rect.height), w, h);
        lastX = e.clientX; lastY = e.clientY;
      }
    });
    window.addEventListener("mouseup", () => { dragging = false; wrap.classList.remove("dragging"); });
  }

  function showBrasil() {
    brasilView = true;
    document.getElementById("mapa-brasil").classList.remove("hidden");
    document.querySelector(".mapa-app").classList.add("hidden");
    ensureBrasilLoaded().catch((err) => {
      alert("Erro ao carregar o mapa do Brasil: " + err.message);
    });
  }

  function showDetalhe() {
    brasilView = false;
    document.getElementById("mapa-brasil").classList.add("hidden");
    document.querySelector(".mapa-app").classList.remove("hidden");
    ensureLoaded().catch((err) => {
      alert("Erro ao carregar o mapa comercial: " + err.message);
    });
  }

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

    document.getElementById("mapa-back-btn").addEventListener("click", () => {
      if (dirty && editable() && !confirm("Você tem alterações não salvas no território. Sair mesmo assim?")) return;
      showBrasil();
    });

    document.getElementById("mapa-negocios-toggle").addEventListener("change", (e) => {
      negociosVisiveis = e.target.checked;
      if (negociosLayer) negociosLayer.style.display = negociosVisiveis ? "" : "none";
      if (negociosLabelsLayer) negociosLabelsLayer.style.display = negociosVisiveis ? "" : "none";
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
      negocios = apiData.negocios || [];
      buildUfAggregates();
      nextRegionNum = regions.length + 1;
      activeRegionId = regions[0] ? regions[0].id : null;
      svg.setAttribute("viewBox", `0 0 ${MAP.width} ${MAP.height}`);
      buildSvg();
      renderRegions();
      repaint();
      renderStats();
      buildNegociosPoints();
      renderNegociosLayer();
      renderNegociosLegend("mapa-negocios-legend", "mapa-negocios-summary", negociosPoints.length);
      renderNegociosLegend("mapa-overlay-legend", null, negociosPoints.length);
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
      if (brasilView) {
        showBrasil();
      } else if (loaded) {
        renderRegions(); // refaz a lista com/sem controles de edição, caso o papel do usuário tenha mudado
      }
    },
  };
})();
