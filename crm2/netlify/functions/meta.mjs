import { getClient, ensureSeeded, STATUS_OPTIONS, VENDEDOR_OPTIONS, CANAL_OPTIONS, json, errorJson } from "./lib/db.mjs";

export default async (req) => {
  try {
    await ensureSeeded();
    const db = getClient();
    const cidadesRes = await db.execute("SELECT DISTINCT cidade FROM leads WHERE cidade != '' ORDER BY cidade");
    const segmentosRes = await db.execute("SELECT DISTINCT segmento FROM leads WHERE segmento != '' ORDER BY segmento");
    return json({
      status_options: STATUS_OPTIONS,
      vendedor_options: VENDEDOR_OPTIONS,
      canal_options: CANAL_OPTIONS,
      cidades: cidadesRes.rows.map((r) => r.cidade),
      segmentos: segmentosRes.rows.map((r) => r.segmento),
    });
  } catch (err) {
    return errorJson(err.message, 500);
  }
};

export const config = { path: "/api/meta" };
