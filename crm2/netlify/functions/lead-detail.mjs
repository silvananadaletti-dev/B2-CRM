import { getClient, ensureSeeded, json, errorJson, rowToPlain, STATUS_OPTIONS, VENDEDOR_OPTIONS } from "./lib/db.mjs";

const PATCHABLE_FIELDS = [
  "cliente_empresa", "contato", "cargo", "telefone1", "telefone2", "email",
  "segmento", "cidade", "vendedor", "status", "tipo_obra", "num_orcamentos",
  "primeiro_orcamento", "ultimo_orcamento", "primeiro_contato", "proximo_contato",
  "notas", "origem",
];

export default async (req, context) => {
  try {
    await ensureSeeded();
    const db = getClient();
    const leadId = Number(context.params.id);
    if (!leadId) return errorJson("ID inválido", 400);

    if (req.method === "GET") {
      const row = await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [leadId] });
      if (!row.rows.length) return errorJson("Lead não encontrado", 404);
      const links = await db.execute({ sql: "SELECT url FROM orcamento_links WHERE lead_id = ?", args: [leadId] });
      const activities = await db.execute({
        sql: "SELECT * FROM activities WHERE lead_id = ? ORDER BY data DESC, id DESC",
        args: [leadId],
      });
      const result = rowToPlain(row.rows[0]);
      result.orcamentos = links.rows.map((l) => l.url);
      result.activities = activities.rows.map(rowToPlain);
      return json(result);
    }

    if (req.method === "PATCH") {
      const body = await req.json();
      const fields = {};
      for (const f of PATCHABLE_FIELDS) {
        if (body[f] !== undefined && body[f] !== null) fields[f] = body[f];
      }
      if (Object.keys(fields).length === 0) return errorJson("Nada para atualizar");
      if (fields.status && !STATUS_OPTIONS.includes(fields.status)) {
        return errorJson(`Status inválido: ${fields.status}`);
      }
      if (fields.vendedor && fields.vendedor !== "" && !VENDEDOR_OPTIONS.includes(fields.vendedor)) {
        return errorJson(`Vendedor inválido: ${fields.vendedor}`);
      }
      const existing = await db.execute({ sql: "SELECT id FROM leads WHERE id = ?", args: [leadId] });
      if (!existing.rows.length) return errorJson("Lead não encontrado", 404);
      const setClause = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
      const args = [...Object.values(fields), leadId];
      await db.execute({ sql: `UPDATE leads SET ${setClause}, updated_at = datetime('now') WHERE id = ?`, args });
      const row = await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [leadId] });
      return json(rowToPlain(row.rows[0]));
    }

    if (req.method === "DELETE") {
      const existing = await db.execute({ sql: "SELECT id FROM leads WHERE id = ?", args: [leadId] });
      if (!existing.rows.length) return errorJson("Lead não encontrado", 404);
      // Cascade manual (sem depender de ON DELETE CASCADE em conexão HTTP stateless):
      await db.execute({ sql: "DELETE FROM activities WHERE lead_id = ?", args: [leadId] });
      await db.execute({ sql: "DELETE FROM orcamento_links WHERE lead_id = ?", args: [leadId] });
      await db.execute({ sql: "DELETE FROM leads WHERE id = ?", args: [leadId] });
      return new Response(null, { status: 204 });
    }

    return errorJson("Método não permitido", 405);
  } catch (err) {
    return errorJson(err.message, 500);
  }
};

export const config = { path: "/api/leads/:id" };
