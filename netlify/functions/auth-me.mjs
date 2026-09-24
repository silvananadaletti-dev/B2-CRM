import { getClient, ensureSeeded, json, errorJson, rowToPlain } from "./lib/db.mjs";
import { requireAuth } from "./lib/auth.mjs";

// Usado no carregamento da página para validar o token salvo no navegador e
// pegar os dados atuais do usuário (ex.: se um admin mudou o papel dele).
export default async (req) => {
  try {
    if (req.method !== "GET") return errorJson("Método não permitido", 405);
    const authUser = requireAuth(req);
    await ensureSeeded();
    const db = getClient();
    const res = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [authUser.sub] });
    const row = res.rows[0] ? rowToPlain(res.rows[0]) : null;
    if (!row || !row.active) return errorJson("Usuário não encontrado ou inativo.", 401);
    return json({
      id: row.id,
      username: row.username,
      role: row.role,
      vendedor: row.vendedor || "",
      nome: row.nome || row.username,
    });
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/auth/me" };
