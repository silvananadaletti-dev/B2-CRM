import { getClient, ensureSeeded, json, errorJson, rowToPlain } from "./lib/db.mjs";
import { requireAuth, requireAdmin } from "./lib/auth.mjs";
import { inferUFs } from "./lib/geo.mjs";

// Tamanho de lote ao regravar as atribuições de município -> região (mesmo
// padrão usado no seed de leads, para não estourar limites de uma única
// chamada ao Turso quando há muitos municípios atribuídos).
const CHUNK = 300;

export default async (req) => {
  try {
    await ensureSeeded();
    const db = getClient();

    if (req.method === "GET") {
      requireAuth(req); // qualquer usuário logado pode visualizar o mapa
      const regionsRes = await db.execute("SELECT * FROM map_regions ORDER BY sort_order, name");
      const assignRes = await db.execute("SELECT municipio_codigo, region_id FROM map_assignments");
      const assign = {};
      assignRes.rows.forEach((r) => { assign[r.municipio_codigo] = r.region_id; });

      // Resumo visual de negócios no mapa — pedido pela Sil em 01/10/2026:
      // "negócios em andamento" aqui são os leads nos status Em orçamento,
      // Negociação e Cliente (as mesmas 3 colunas da aba "Negócios em
      // Andamento" do Kanban, MENOS "Perdido" — negócio perdido não é
      // "negócio em andamento"). Cada linha vira um ponto no mapa, colorido
      // por vendedor, mostrando cliente/valor/nº da proposta ao passar o
      // mouse — ver mapa.js.
      const negociosRes = await db.execute(
        `SELECT cliente_empresa, cidade, vendedor, valor, numero_proposta, status
         FROM leads
         WHERE status IN ('Em orçamento', 'Negociação', 'Cliente')
           AND cliente_empresa != '' AND cidade != ''`
      );
      // Resolve a UF de cada negócio aqui (sufixo ", UF" OU busca pelo nome
      // do município na tabela de 5571 municípios do IBGE), porque nem toda
      // cidade cadastrada tem o sufixo ", UF" (ex.: cadastro antigo, sem vir
      // do Notion) — sem isso esses casos não apareceriam nem na contagem
      // por estado nem nos pontos por município no front-end.
      const negocios = negociosRes.rows.map(rowToPlain).map((n) => ({
        ...n,
        uf: inferUFs(n.cidade)[0] || null,
      }));

      // Visão nacional: em quais estados (UF) existe pelo menos 1 negócio em
      // andamento (mesmo critério acima, mesma lista de pontos) — pedido
      // pela Sil em 01/10/2026: "quero que apareça o mapa de todos os
      // estados com proposta ativa". Antes disso usava a coluna
      // `tem_orcamento_ativo` (calculada pela sincronização com o Notion,
      // base ORÇAMENTOS), que é um critério mais estrito/diferente e deixava
      // vários estados com negócio em andamento aparecendo cinza (inativo)
      // no mapa — agora os pontos e a cor do estado vêm sempre da mesma
      // fonte, pra não haver estado sem cor com pontos nele (ou vice-versa).
      const estadosAtivos = Array.from(new Set(negocios.map((n) => n.uf).filter(Boolean))).sort();

      return json({
        regions: regionsRes.rows.map(rowToPlain).map((r) => ({ id: r.id, name: r.name, color: r.color })),
        assign,
        estados_ativos: estadosAtivos,
        negocios,
      });
    }

    if (req.method === "PUT") {
      requireAdmin(req); // só o administrador edita/salva o mapa
      const body = await req.json().catch(() => ({}));
      const regions = Array.isArray(body.regions) ? body.regions : [];
      const assign = body.assign && typeof body.assign === "object" ? body.assign : {};

      if (regions.some((r) => !r || !r.id || !r.name || !r.color)) {
        return errorJson("Cada região precisa de id, name e color.", 400);
      }
      const validIds = new Set(regions.map((r) => String(r.id)));
      for (const regionId of Object.values(assign)) {
        if (!validIds.has(String(regionId))) {
          return errorJson(`Região "${regionId}" referenciada em uma atribuição não existe na lista de regiões enviada.`, 400);
        }
      }

      await db.batch(["DELETE FROM map_assignments", "DELETE FROM map_regions"], "write");

      const regionStatements = regions.map((r, i) => ({
        sql: "INSERT INTO map_regions (id, name, color, sort_order) VALUES (?, ?, ?, ?)",
        args: [String(r.id), String(r.name), String(r.color), i],
      }));
      for (let i = 0; i < regionStatements.length; i += CHUNK) {
        await db.batch(regionStatements.slice(i, i + CHUNK), "write");
      }

      const assignEntries = Object.entries(assign);
      const assignStatements = assignEntries.map(([codigo, regionId]) => ({
        sql: "INSERT INTO map_assignments (municipio_codigo, region_id) VALUES (?, ?)",
        args: [String(codigo), String(regionId)],
      }));
      for (let i = 0; i < assignStatements.length; i += CHUNK) {
        await db.batch(assignStatements.slice(i, i + CHUNK), "write");
      }

      return json({ ok: true, regions: regions.length, assignments: assignEntries.length });
    }

    return errorJson("Método não permitido", 405);
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/map-data" };
