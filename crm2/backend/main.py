from typing import Optional, List
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path

from database import get_db, init_db, STATUS_OPTIONS, VENDEDOR_OPTIONS, CANAL_OPTIONS

app = FastAPI(title="CRM Pré-Fabricados API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


@app.on_event("startup")
def startup():
    init_db()
    # Primeira inicialização (disco persistente vazio, ex: recém-implantado no Render):
    # popula automaticamente com os dados originais. Ambos os scripts são seguros de
    # rodar de novo (seed.py aborta se já houver leads; import_planilha.py não duplica).
    try:
        with get_db() as conn:
            existing = conn.execute("SELECT COUNT(*) as n FROM leads").fetchone()["n"]
        if existing == 0:
            import seed
            import import_planilha
            seed.main()
            import_planilha.main()
    except Exception as e:
        print(f"Aviso: seed automático falhou ({e}). Rode manualmente se necessário.")


# ---------- Schemas ----------

LEAD_FIELDS = [
    "cliente_empresa", "contato", "cargo", "telefone1", "telefone2", "email",
    "segmento", "cidade", "vendedor", "status", "tipo_obra", "num_orcamentos",
    "primeiro_orcamento", "ultimo_orcamento", "primeiro_contato", "proximo_contato",
    "notas", "origem",
]


class LeadIn(BaseModel):
    cliente_empresa: str
    contato: Optional[str] = ""
    cargo: Optional[str] = ""
    telefone1: Optional[str] = ""
    telefone2: Optional[str] = ""
    email: Optional[str] = ""
    segmento: Optional[str] = ""
    cidade: Optional[str] = ""
    vendedor: Optional[str] = ""
    status: Optional[str] = "Prospect"
    tipo_obra: Optional[str] = ""
    num_orcamentos: Optional[int] = 0
    primeiro_orcamento: Optional[str] = ""
    ultimo_orcamento: Optional[str] = ""
    primeiro_contato: Optional[str] = ""
    proximo_contato: Optional[str] = ""
    notas: Optional[str] = ""
    origem: Optional[str] = ""


class LeadPatch(BaseModel):
    cliente_empresa: Optional[str] = None
    contato: Optional[str] = None
    cargo: Optional[str] = None
    telefone1: Optional[str] = None
    telefone2: Optional[str] = None
    email: Optional[str] = None
    segmento: Optional[str] = None
    cidade: Optional[str] = None
    vendedor: Optional[str] = None
    status: Optional[str] = None
    tipo_obra: Optional[str] = None
    num_orcamentos: Optional[int] = None
    primeiro_orcamento: Optional[str] = None
    ultimo_orcamento: Optional[str] = None
    primeiro_contato: Optional[str] = None
    proximo_contato: Optional[str] = None
    notas: Optional[str] = None
    origem: Optional[str] = None


class ActivityIn(BaseModel):
    data: str
    canal: Optional[str] = ""
    assunto: Optional[str] = ""
    resultado: Optional[str] = ""
    proxima_acao: Optional[str] = ""
    data_followup: Optional[str] = ""


def row_to_dict(row):
    return dict(row)


# ---------- Meta ----------

@app.get("/api/meta")
def get_meta():
    with get_db() as conn:
        cidades = [r["cidade"] for r in conn.execute(
            "SELECT DISTINCT cidade FROM leads WHERE cidade != '' ORDER BY cidade"
        ).fetchall()]
        segmentos = [r["segmento"] for r in conn.execute(
            "SELECT DISTINCT segmento FROM leads WHERE segmento != '' ORDER BY segmento"
        ).fetchall()]
    return {
        "status_options": STATUS_OPTIONS,
        "vendedor_options": VENDEDOR_OPTIONS,
        "canal_options": CANAL_OPTIONS,
        "cidades": cidades,
        "segmentos": segmentos,
    }


@app.get("/api/stats")
def get_stats():
    with get_db() as conn:
        by_status = {r["status"]: r["n"] for r in conn.execute(
            "SELECT status, COUNT(*) as n FROM leads GROUP BY status"
        ).fetchall()}
        by_vendedor = {(r["vendedor"] or "(sem vendedor)"): r["n"] for r in conn.execute(
            "SELECT vendedor, COUNT(*) as n FROM leads GROUP BY vendedor"
        ).fetchall()}
        total = conn.execute("SELECT COUNT(*) as n FROM leads").fetchone()["n"]
        total_orcamentos = conn.execute(
            "SELECT COALESCE(SUM(num_orcamentos),0) as n FROM leads"
        ).fetchone()["n"]
    return {
        "total_leads": total,
        "total_orcamentos": total_orcamentos,
        "by_status": by_status,
        "by_vendedor": by_vendedor,
    }


# ---------- Leads CRUD ----------

@app.get("/api/leads")
def list_leads(
    status: Optional[str] = None,
    vendedor: Optional[str] = None,
    cidade: Optional[str] = None,
    segmento: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 5000,
    offset: int = 0,
):
    query = "SELECT * FROM leads WHERE 1=1"
    params: List = []
    if status:
        query += " AND status = ?"
        params.append(status)
    if vendedor:
        query += " AND vendedor = ?"
        params.append(vendedor)
    if cidade:
        query += " AND cidade = ?"
        params.append(cidade)
    if segmento:
        query += " AND segmento = ?"
        params.append(segmento)
    if search:
        query += " AND (cliente_empresa LIKE ? OR contato LIKE ? OR cidade LIKE ? OR tipo_obra LIKE ? OR segmento LIKE ?)"
        like = f"%{search}%"
        params.extend([like, like, like, like, like])
    query += " ORDER BY cliente_empresa LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    with get_db() as conn:
        rows = conn.execute(query, params).fetchall()
    return [row_to_dict(r) for r in rows]


@app.get("/api/leads/{lead_id}")
def get_lead(lead_id: int):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Lead não encontrado")
        links = conn.execute(
            "SELECT url FROM orcamento_links WHERE lead_id = ?", (lead_id,)
        ).fetchall()
        activities = conn.execute(
            "SELECT * FROM activities WHERE lead_id = ? ORDER BY data DESC, id DESC", (lead_id,)
        ).fetchall()
    result = row_to_dict(row)
    result["orcamentos"] = [l["url"] for l in links]
    result["activities"] = [row_to_dict(a) for a in activities]
    return result


@app.post("/api/leads", status_code=201)
def create_lead(lead: LeadIn):
    if lead.status and lead.status not in STATUS_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Status inválido: {lead.status}")
    if lead.vendedor and lead.vendedor not in VENDEDOR_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Vendedor inválido: {lead.vendedor}")
    with get_db() as conn:
        cols = ", ".join(LEAD_FIELDS)
        placeholders = ", ".join(["?"] * len(LEAD_FIELDS))
        values = [getattr(lead, f) for f in LEAD_FIELDS]
        cur = conn.execute(
            f"INSERT INTO leads ({cols}, updated_at) VALUES ({placeholders}, datetime('now'))",
            values,
        )
        new_id = cur.lastrowid
        row = conn.execute("SELECT * FROM leads WHERE id = ?", (new_id,)).fetchone()
    return row_to_dict(row)


@app.patch("/api/leads/{lead_id}")
def patch_lead(lead_id: int, patch: LeadPatch):
    fields = {k: v for k, v in patch.dict(exclude_unset=True).items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Nada para atualizar")
    if "status" in fields and fields["status"] not in STATUS_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Status inválido: {fields['status']}")
    if "vendedor" in fields and fields["vendedor"] not in VENDEDOR_OPTIONS and fields["vendedor"] != "":
        raise HTTPException(status_code=400, detail=f"Vendedor inválido: {fields['vendedor']}")
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    params = list(fields.values()) + [lead_id]
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM leads WHERE id = ?", (lead_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Lead não encontrado")
        conn.execute(
            f"UPDATE leads SET {set_clause}, updated_at = datetime('now') WHERE id = ?",
            params,
        )
        row = conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/leads/{lead_id}", status_code=204)
def delete_lead(lead_id: int):
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM leads WHERE id = ?", (lead_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Lead não encontrado")
        conn.execute("DELETE FROM leads WHERE id = ?", (lead_id,))
    return None


# ---------- Activities (histórico de interações por lead) ----------

@app.get("/api/activities")
def list_all_activities():
    """Todas as atividades de todos os leads, com o nome do cliente/empresa
    e o status atual do lead — usado pela visão de Calendário."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT a.*, l.cliente_empresa AS lead_cliente_empresa, l.status AS lead_status
            FROM activities a
            JOIN leads l ON l.id = a.lead_id
            ORDER BY a.data DESC, a.id DESC"""
        ).fetchall()
    return [row_to_dict(r) for r in rows]


@app.get("/api/leads/{lead_id}/activities")
def list_activities(lead_id: int):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM activities WHERE lead_id = ? ORDER BY data DESC, id DESC", (lead_id,)
        ).fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/leads/{lead_id}/activities", status_code=201)
def create_activity(lead_id: int, activity: ActivityIn):
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM leads WHERE id = ?", (lead_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Lead não encontrado")
        cur = conn.execute(
            """INSERT INTO activities
            (lead_id, data, canal, assunto, resultado, proxima_acao, data_followup)
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (lead_id, activity.data, activity.canal, activity.assunto,
             activity.resultado, activity.proxima_acao, activity.data_followup),
        )
        new_id = cur.lastrowid
        row = conn.execute("SELECT * FROM activities WHERE id = ?", (new_id,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/activities/{activity_id}", status_code=204)
def delete_activity(activity_id: int):
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM activities WHERE id = ?", (activity_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Atividade não encontrada")
        conn.execute("DELETE FROM activities WHERE id = ?", (activity_id,))
    return None


# ---------- Static frontend ----------

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
