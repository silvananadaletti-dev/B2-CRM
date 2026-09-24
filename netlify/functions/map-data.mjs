import { getClient, ensureSeeded, json, errorJson, rowToPlain } from "./lib/db.mjs";
import { requireAuth, requireAdmin } from "./lib/auth.mjs";

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
      return json({
        regions: regionsRes.rows.map(rowToPlain).map((r) => ({ id: r.id, name: r.name, color: r.color })),
        assign,
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
