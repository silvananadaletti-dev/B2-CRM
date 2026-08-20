import { getClient, ensureSeeded, json, errorJson, rowToPlain } from "./lib/db.mjs";

export default async (req) => {
  try {
    await ensureSeeded();
    const db = getClient();
    const res = await db.execute(
      `SELECT a.*, l.cliente_empresa AS lead_cliente_empresa, l.status AS lead_status
       FROM activities a
       JOIN leads l ON l.id = a.lead_id
       ORDER BY a.data DESC, a.id DESC`
    );
    return json(res.rows.map(rowToPlain));
  } catch (err) {
    return errorJson(err.message, 500);
  }
};

export const config = { path: "/api/activities" };
