import { getClient, ensureSeeded, json, errorJson, rowToPlain } from "./lib/db.mjs";
import { requireAuth, scopedVendedor } from "./lib/auth.mjs";

export default async (req) => {
  try {
    const user = requireAuth(req);
    const lockedVendedor = scopedVendedor(user);
    await ensureSeeded();
    const db = getClient();
    let sql = `SELECT a.*, l.cliente_empresa AS lead_cliente_empresa, l.status AS lead_status
       FROM activities a
       JOIN leads l ON l.id = a.lead_id`;
    const args = [];
    if (lockedVendedor !== null) {
      sql += " WHERE l.vendedor = ?";
      args.push(lockedVendedor);
    }
    sql += " ORDER BY a.data DESC, a.id DESC";
    const res = await db.execute({ sql, args });
    return json(res.rows.map(rowToPlain));
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/activities" };
