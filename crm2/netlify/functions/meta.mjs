import { getClient, ensureSeeded, STATUS_OPTIONS, VENDEDOR_OPTIONS, CANAL_OPTIONS, json, errorJson } from "./lib/db.mjs";
import { requireAuth, scopedVendedor } from "./lib/auth.mjs";

export default async (req) => {
  try {
    const user = requireAuth(req);
    const lockedVendedor = scopedVendedor(user);
    await ensureSeeded();
    const db = getClient();
    const where = lockedVendedor !== null ? " AND vendedor = ?" : "";
    const args = lockedVendedor !== null ? [lockedVendedor] : [];
    const cidadesRes = await db.execute({ sql: `SELECT DISTINCT cidade FROM leads WHERE cidade != ''${where} ORDER BY cidade`, args });
    const segmentosRes = await db.execute({ sql: `SELECT DISTINCT segmento FROM leads WHERE segmento != ''${where} ORDER BY segmento`, args });
    return json({
      status_options: STATUS_OPTIONS,
      // Vendedor não-admin só vê o próprio nome (não precisa filtrar por outro,
      // já que o backend só devolve os leads dele de qualquer forma).
      vendedor_options: lockedVendedor !== null ? [lockedVendedor] : VENDEDOR_OPTIONS,
      canal_options: CANAL_OPTIONS,
      cidades: cidadesRes.rows.map((r) => r.cidade),
      segmentos: segmentosRes.rows.map((r) => r.segmento),
    });
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/meta" };
