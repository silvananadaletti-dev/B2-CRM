import { getClient, ensureSeeded, json, errorJson, rowToPlain } from "./lib/db.mjs";
import { verifyPassword, signToken } from "./lib/auth.mjs";

export default async (req) => {
  try {
    if (req.method !== "POST") return errorJson("Método não permitido", 405);
    await ensureSeeded();
    const db = getClient();
    const body = await req.json().catch(() => ({}));
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!username || !password) return errorJson("Informe usuário e senha.", 400);

    const res = await db.execute({
      sql: "SELECT * FROM users WHERE lower(username) = ?",
      args: [username],
    });
    const row = res.rows[0] ? rowToPlain(res.rows[0]) : null;
    if (!row || !row.active || !verifyPassword(password, row.password_hash)) {
      return errorJson("Usuário ou senha inválidos.", 401);
    }

    const token = signToken({
      sub: row.id,
      username: row.username,
      role: row.role,
      vendedor: row.vendedor || "",
      nome: row.nome || row.username,
    });

    return json({
      token,
      user: {
        id: row.id,
        username: row.username,
        role: row.role,
        vendedor: row.vendedor || "",
        nome: row.nome || row.username,
      },
    });
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/auth/login" };
