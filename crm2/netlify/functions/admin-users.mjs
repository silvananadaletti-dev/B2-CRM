import { getClient, ensureSeeded, json, errorJson, rowToPlain, VENDEDOR_OPTIONS } from "./lib/db.mjs";
import { requireAdmin, hashPassword } from "./lib/auth.mjs";

const ROLES = ["admin", "vendedor"];

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    vendedor: row.vendedor || "",
    nome: row.nome || "",
    active: !!row.active,
    created_at: row.created_at,
  };
}

export default async (req) => {
  try {
    requireAdmin(req);
    await ensureSeeded();
    const db = getClient();

    if (req.method === "GET") {
      const res = await db.execute("SELECT * FROM users ORDER BY role DESC, nome, username");
      return json(res.rows.map(rowToPlain).map(publicUser));
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const username = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      const role = ROLES.includes(body.role) ? body.role : "vendedor";
      const vendedor = role === "vendedor" ? String(body.vendedor || "") : "";
      const nome = String(body.nome || "").trim();

      if (!username || !/^[a-z0-9._-]{3,32}$/.test(username)) {
        return errorJson("Usuário inválido — use letras minúsculas, números, ponto, traço ou underline (3 a 32 caracteres).", 400);
      }
      if (!password || password.length < 6) {
        return errorJson("A senha precisa ter pelo menos 6 caracteres.", 400);
      }
      if (role === "vendedor" && !VENDEDOR_OPTIONS.includes(vendedor)) {
        return errorJson(`Selecione um vendedor válido: ${VENDEDOR_OPTIONS.join(", ")}`, 400);
      }
      const existing = await db.execute({ sql: "SELECT id FROM users WHERE lower(username) = ?", args: [username] });
      if (existing.rows.length) return errorJson("Já existe um usuário com esse nome de login.", 409);

      const result = await db.execute({
        sql: `INSERT INTO users (username, password_hash, role, vendedor, nome) VALUES (?, ?, ?, ?, ?)`,
        args: [username, hashPassword(password), role, vendedor, nome],
      });
      const row = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [Number(result.lastInsertRowid)] });
      return json(publicUser(rowToPlain(row.rows[0])), { status: 201 });
    }

    return errorJson("Método não permitido", 405);
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/admin/users" };
