import os
import sqlite3
from pathlib import Path
from contextlib import contextmanager

# Em produção (Render), DB_PATH aponta para o disco persistente (ex: /var/data/crm.db)
# via variável de ambiente. Localmente, usa o arquivo dentro da própria pasta backend/.
DB_PATH = Path(os.environ.get("DB_PATH", str(Path(__file__).parent / "crm.db")))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Funil de vendas, na ordem real usada pela equipe (planilha "Acompanhamento comercial"):
# cadastro inicial -> primeiro contato agendado -> aguardando resposta -> follow-up de
# nutrição -> orçamento ativo -> negociação -> desfecho (Perdido) / Arquivado.
STATUS_OPTIONS = [
    "Prospect",
    "Fazer contato futuro",
    "Aguardando resposta",
    "Follow-up",
    "Em orçamento",
    "Negociação",
    "Perdido",
    "Arquivado",
]
VENDEDOR_OPTIONS = ["Augusto", "Luciano", "Jair", "Flávio", "Jorge"]
CANAL_OPTIONS = [
    "Ligação", "Whatsapp", "E-mail", "Visita", "Reunião online",
    "Follow-up", "Orçamento enviado", "LinkedIn", "Instagram",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_empresa TEXT NOT NULL,
    contato TEXT DEFAULT '',
    cargo TEXT DEFAULT '',
    telefone1 TEXT DEFAULT '',
    telefone2 TEXT DEFAULT '',
    email TEXT DEFAULT '',
    segmento TEXT DEFAULT '',
    cidade TEXT DEFAULT '',
    vendedor TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Prospect',
    tipo_obra TEXT DEFAULT '',
    num_orcamentos INTEGER DEFAULT 0,
    primeiro_orcamento TEXT DEFAULT '',
    ultimo_orcamento TEXT DEFAULT '',
    primeiro_contato TEXT DEFAULT '',
    proximo_contato TEXT DEFAULT '',
    notas TEXT DEFAULT '',
    origem TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orcamento_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    canal TEXT DEFAULT '',
    assunto TEXT DEFAULT '',
    resultado TEXT DEFAULT '',
    proxima_acao TEXT DEFAULT '',
    data_followup TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_vendedor ON leads(vendedor);
CREATE INDEX IF NOT EXISTS idx_orcamento_links_lead ON orcamento_links(lead_id);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id);
"""


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_db():
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA)
