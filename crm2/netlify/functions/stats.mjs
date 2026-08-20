import { getClient, ensureSeeded, json, errorJson } from "./lib/db.mjs";

export default async (req) => {
  try {
    await ensureSeeded();
    const db = getClient();
    const byStatusRes = await db.execute("SELECT status, COUNT(*) as n FROM leads GROUP BY status");
    const byVendedorRes = await db.execute("SELECT vendedor, COUNT(*) as n FROM leads GROUP BY vendedor");
    const totalRes = await db.execute("SELECT COUNT(*) as n FROM leads");
    const totalOrcRes = await db.execute("SELECT COALESCE(SUM(num_orcamentos),0) as n FROM leads");

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
    return errorJson(err.message, 500);
  }
};

export const config = { path: "/api/stats" };
