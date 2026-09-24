import { getClient, ensureSeeded, json, errorJson, rowToPlain } from "./lib/db.mjs";
import { requireAuth, verifyPassword, hashPassword } from "./lib/auth.mjs";

export default async (req) => {
  try {
    if (req.method !== "POST") return errorJson("Método não permitido", 405);
    const authUser = requireAuth(req);
    await ensureSeeded();
    const db = getClient();
    const body = await req.json().catch(() => ({}));
    const currentPassword = String(body.current_password || "");
    const newPassword = String(body.new_password || "");
    if (!currentPassword || !newPassword) {
      return errorJson("Informe a senha atual e a nova senha.", 400);
    }
    if (newPassword.length < 6) {
      return errorJson("A nova senha precisa ter pelo menos 6 caracteres.", 400);
    }
    const res = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [authUser.sub] });
    const row = res.rows[0] ? rowToPlain(res.rows[0]) : null;
    if (!row || !row.active) return errorJson("Usuário não encontrado ou inativo.", 401);
    if (!verifyPassword(currentPassword, row.password_hash)) {
      return errorJson("Senha atual incorreta.", 400);
    }
    await db.execute({
      sql: "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?",
      args: [hashPassword(newPassword), row.id],
    });
    return json({ ok: true });
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/auth/change-password" };
