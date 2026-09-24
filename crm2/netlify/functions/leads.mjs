import { getClient, ensureSeeded, json, errorJson, rowToPlain, STATUS_OPTIONS, VENDEDOR_OPTIONS, LEAD_FIELDS } from "./lib/db.mjs";
import { requireAuth, scopedVendedor } from "./lib/auth.mjs";

export default async (req) => {
  try {
    const user = requireAuth(req);
    const lockedVendedor = scopedVendedor(user); // null p/ admin, senão o próprio nome
    await ensureSeeded();
    const db = getClient();

    if (req.method === "GET") {
      const url = new URL(req.url);
      const p = url.searchParams;
      let sql = "SELECT * FROM leads WHERE 1=1";
      const args = [];
      if (p.get("status")) { sql += " AND status = ?"; args.push(p.get("status")); }
      // Vendedor não-admin: ignora qualquer valor vindo do cliente e trava no próprio nome.
      if (lockedVendedor !== null) { sql += " AND vendedor = ?"; args.push(lockedVendedor); }
      else if (p.get("vendedor")) { sql += " AND vendedor = ?"; args.push(p.get("vendedor")); }
      if (p.get("cidade")) { sql += " AND cidade = ?"; args.push(p.get("cidade")); }
      if (p.get("segmento")) { sql += " AND segmento = ?"; args.push(p.get("segmento")); }
      if (p.get("search")) {
        sql += " AND (cliente_empresa LIKE ? OR contato LIKE ? OR cidade LIKE ? OR tipo_obra LIKE ? OR segmento LIKE ?)";
        const like = `%${p.get("search")}%`;
        args.push(like, like, like, like, like);
      }
      const limit = Number(p.get("limit")) || 5000;
      const offset = Number(p.get("offset")) || 0;
      sql += " ORDER BY cliente_empresa LIMIT ? OFFSET ?";
      args.push(limit, offset);
      const res = await db.execute({ sql, args });
      return json(res.rows.map(rowToPlain));
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (!body.cliente_empresa) return errorJson("Informe o nome do cliente/empresa.");
      const status = body.status || "Prospect";
      if (!STATUS_OPTIONS.includes(status)) return errorJson(`Status inválido: ${status}`);
      if (body.vendedor && !VENDEDOR_OPTIONS.includes(body.vendedor)) {
        return errorJson(`Vendedor inválido: ${body.vendedor}`);
      }
      // Vendedor não-admin: qualquer lead criado por ele já nasce no próprio nome,
      // nunca no de outra pessoa (mesmo que o corpo da requisição diga outra coisa).
      if (lockedVendedor !== null) body.vendedor = lockedVendedor;
      const values = LEAD_FIELDS.map((f) => {
        if (f === "status") return status;
        const v = body[f];
        if (v === undefined || v === null) return f === "num_orcamentos" ? 0 : "";
        return v;
      });
      const cols = LEAD_FIELDS.join(", ");
      const placeholders = LEAD_FIELDS.map(() => "?").join(", ");
      const result = await db.execute({
        sql: `INSERT INTO leads (${cols}, updated_at) VALUES (${placeholders}, datetime('now'))`,
        args: values,
      });
      const newId = Number(result.lastInsertRowid);
      const row = await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [newId] });
      return json(rowToPlain(row.rows[0]), { status: 201 });
    }

    return errorJson("Método não permitido", 405);
  } catch (err) {
    return errorJson(err.message, err.status || 500);
  }
};

export const config = { path: "/api/leads" };
