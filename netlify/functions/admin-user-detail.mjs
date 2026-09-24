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

async function countOtherActiveAdmins(db, excludeId) {
  const res = await db.execute({
    sql: "SELECT COUNT(*) as n FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
    args: [excludeId],
  });
  return Number(res.rows[0].n);
}

export default async (req, context) => {
  try {
    const admin = requireAdmin(req);
    await ensureSeeded();
    const db = getClient();
    const userId = Number(context.params.id);
    if (!userId) return errorJson("ID inválido", 400);

    const existingRes = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [userId] });
    if (!existingRes.rows.length) return errorJson("Usuário não encontrado.", 404);
    const existing = rowToPlain(existingRes.rows[0]);

    if (req.method === "PATCH") {
      const body = await req.json().catch(() => ({}));
      const fields = {};

      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) return errorJson("Papel inválido.", 400);
        if (existing.role === "admin" && body.role !== "admin") {
          if (userId === admin.sub) return errorJson("Você não pode remover o próprio acesso de administrador.", 400);
          if ((await countOtherActiveAdmins(db, userId)) === 0) {
            return errorJson("Precisa existir pelo menos um administrador ativo.", 400);
          }
        }
        fields.role = body.role;
      }
      const nextRole = fields.role || existing.role;
      if (body.vendedor !== undefined) {
        const vendedor = String(body.vendedor || "");
        if (nextRole === "vendedor") {
          if (!VENDEDOR_OPTIONS.includes(vendedor)) {
            return errorJson(`Selecione um vendedor válido: ${VENDEDOR_OPTIONS.join(", ")}`, 400);
          }
          fields.vendedor = vendedor;
        } else {
          fields.vendedor = "";
        }
      } else if (fields.role === "admin") {
        fields.vendedor = "";
      }
      if (body.nome !== undefined) fields.nome = String(body.nome || "").trim();
      if (body.active !== undefined) {
        const active = !!body.active;
        if (!active) {
          if (userId === admin.sub) return errorJson("Você não pode desativar a própria conta.", 400);
          if (existing.role === "admin" && (await countOtherActiveAdmins(db, userId)) === 0) {
            return errorJson("Precisa existir pelo menos um administrador ativo.", 400);
          }
        }
        fields.active = active ? 1 : 0;
      }
      if (body.password !== undefined) {
        const password = String(body.password || "");
        if (!password || password.length < 6) return errorJson("A nova senha precisa ter pelo menos 6 caracteres.", 400);
        fields.password_hash = hashPassword(password);
      }

      if (Object.keys(fields).length === 0) return errorJson("Nada para atualizar.", 400);
      const setClause = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
      const args = [...Object.values(fields), userId];
      await db.execute({ sql: `UPDATE users SET ${setClause}, updated_at = datetime('now') WHERE id = ?`, args });
      const row = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [userId] });
      return json(publicUser(rowToPlain(row.rows[0])));
    }

    if (req.method === "DELETE") {
      if (userId === admin.sub) return errorJson("Você não pode excluir a própria conta.", 400);
      if (existing.role === "admin" && (await countOtherActiveAdmins(db, userId)) === 0) {
        return errorJson("Precisa existir pelo menos um administrador ativo.", 400);
      }
      await db.execute({ sql: "DELETE FROM users WHERE id = ?", args: [userId] });
      return new Response(null, { status: 204 });
    }

    return errorJson("Método não permitido", 405);
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/admin/users/:id" };
