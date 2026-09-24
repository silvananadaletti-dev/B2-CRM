import { getClient, ensureSeeded, errorJson } from "./lib/db.mjs";
import { requireAuth, scopedVendedor, AuthError } from "./lib/auth.mjs";

export default async (req, context) => {
  try {
    const user = requireAuth(req);
    const lockedVendedor = scopedVendedor(user);
    await ensureSeeded();
    const db = getClient();
    const activityId = Number(context.params.id);
    if (!activityId) return errorJson("ID inválido", 400);

    if (req.method === "DELETE") {
      const existing = await db.execute({
        sql: `SELECT a.id, l.vendedor FROM activities a JOIN leads l ON l.id = a.lead_id WHERE a.id = ?`,
        args: [activityId],
      });
      if (!existing.rows.length) return errorJson("Atividade não encontrada", 404);
      if (lockedVendedor !== null && (existing.rows[0].vendedor || "") !== lockedVendedor) {
        throw new AuthError("Esta atividade pertence a um lead de outro vendedor.", 403);
      }
      await db.execute({ sql: "DELETE FROM activities WHERE id = ?", args: [activityId] });
      return new Response(null, { status: 204 });
    }

    return errorJson("Método não permitido", 405);
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/activities/:id" };
