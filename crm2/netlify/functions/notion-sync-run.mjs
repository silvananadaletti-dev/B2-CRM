import { getClient, ensureSeeded, json, errorJson, rowToPlain } from "./lib/db.mjs";
import { requireAdmin } from "./lib/auth.mjs";
import { runNotionSync } from "./lib/notion-sync.mjs";

// GET  /api/admin/notion-sync -> status da última sincronização (admin only)
// POST /api/admin/notion-sync -> dispara uma sincronização agora, na hora
//                                 (botão "Sincronizar agora" na Administração)
export default async (req) => {
  try {
    await ensureSeeded();
    requireAdmin(req);
    const db = getClient();

    if (req.method === "GET") {
      const res = await db.execute("SELECT last_synced_at, last_result FROM sync_state WHERE id = 1");
      const row = res.rows[0] ? rowToPlain(res.rows[0]) : {};
      return json({
        last_synced_at: row.last_synced_at || null,
        last_result: row.last_result ? JSON.parse(row.last_result) : null,
      });
    }

    if (req.method === "POST") {
      const resumo = await runNotionSync();
      return json(resumo);
    }

    return errorJson("Método não permitido", 405);
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/admin/notion-sync" };
