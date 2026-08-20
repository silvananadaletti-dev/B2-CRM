import { getClient, ensureSeeded, json, errorJson, rowToPlain } from "./lib/db.mjs";

export default async (req, context) => {
  try {
    await ensureSeeded();
    const db = getClient();
    const leadId = Number(context.params.id);
    if (!leadId) return errorJson("ID inválido", 400);

    if (req.method === "GET") {
      const rows = await db.execute({
        sql: "SELECT * FROM activities WHERE lead_id = ? ORDER BY data DESC, id DESC",
        args: [leadId],
      });
      return json(rows.rows.map(rowToPlain));
    }

    if (req.method === "POST") {
      const existing = await db.execute({ sql: "SELECT id FROM leads WHERE id = ?", args: [leadId] });
      if (!existing.rows.length) return errorJson("Lead não encontrado", 404);
      const body = await req.json();
      if (!body.data) return errorJson("Campo 'data' é obrigatório.");
      const result = await db.execute({
        sql: `INSERT INTO activities
          (lead_id, data, canal, assunto, resultado, proxima_acao, data_followup)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          leadId, body.data, body.canal || "", body.assunto || "",
          body.resultado || "", body.proxima_acao || "", body.data_followup || "",
        ],
      });
      const newId = Number(result.lastInsertRowid);
      const row = await db.execute({ sql: "SELECT * FROM activities WHERE id = ?", args: [newId] });
      return json(rowToPlain(row.rows[0]), { status: 201 });
    }

    return errorJson("Método não permitido", 405);
  } catch (err) {
    return errorJson(err.message, 500);
  }
};

export const config = { path: "/api/leads/:id/activities" };
