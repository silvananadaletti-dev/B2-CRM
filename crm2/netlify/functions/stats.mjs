import { getClient, ensureSeeded, json, errorJson } from "./lib/db.mjs";
import { requireAuth, scopedVendedor } from "./lib/auth.mjs";

export default async (req) => {
  try {
    const user = requireAuth(req);
    const lockedVendedor = scopedVendedor(user);
    await ensureSeeded();
    const db = getClient();
    const where = lockedVendedor !== null ? " WHERE vendedor = ?" : "";
    const args = lockedVendedor !== null ? [lockedVendedor] : [];
    const byStatusRes = await db.execute({ sql: `SELECT status, COUNT(*) as n FROM leads${where} GROUP BY status`, args });
    const byVendedorRes = await db.execute({ sql: `SELECT vendedor, COUNT(*) as n FROM leads${where} GROUP BY vendedor`, args });
    const totalRes = await db.execute({ sql: `SELECT COUNT(*) as n FROM leads${where}`, args });
    const totalOrcRes = await db.execute({ sql: `SELECT COALESCE(SUM(num_orcamentos),0) as n FROM leads${where}`, args });

    const by_status = {};
    for (const r of byStatusRes.rows) by_status[r.status] = Number(r.n);
    const by_vendedor = {};
    for (const r of byVendedorRes.rows) by_vendedor[r.vendedor || "(sem vendedor)"] = Number(r.n);

    return json({
      total_leads: Number(totalRes.rows[0].n),
      total_orcamentos: Number(totalOrcRes.rows[0].n),
      by_status,
      by_vendedor,
    });
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/stats" };
