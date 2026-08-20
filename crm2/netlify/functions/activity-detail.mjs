import { getClient, ensureSeeded, errorJson } from "./lib/db.mjs";

export default async (req, context) => {
  try {
    await ensureSeeded();
    const db = getClient();
    const activityId = Number(context.params.id);
    if (!activityId) return errorJson("ID inválido", 400);

    if (req.method === "DELETE") {
      const existing = await db.execute({ sql: "SELECT id FROM activities WHERE id = ?", args: [activityId] });
      if (!existing.rows.length) return errorJson("Atividade não encontrada", 404);
      await db.execute({ sql: "DELETE FROM activities WHERE id = ?", args: [activityId] });
      return new Response(null, { status: 204 });
    }

    return errorJson("Método não permitido", 405);
  } catch (err) {
    return errorJson(err.message, 500);
  }
};

export const config = { path: "/api/activities/:id" };
