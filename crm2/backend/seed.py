"""Importa os leads exportados do Notion (notion_export/leads_seed.json) para o SQLite local."""
import json
from pathlib import Path

from database import get_db, init_db

SEED_FILE = Path(__file__).parent.parent / "notion_export" / "leads_seed.json"


def main():
    init_db()
    with open(SEED_FILE, encoding="utf-8") as f:
        records = json.load(f)

    with get_db() as conn:
        existing = conn.execute("SELECT COUNT(*) as n FROM leads").fetchone()["n"]
        if existing > 0:
            print(f"Banco já tem {existing} leads. Abortando para evitar duplicar. "
                  f"Apague crm.db se quiser re-popular do zero.")
            return

        count = 0
        for rec in records:
            cur = conn.execute(
                """INSERT INTO leads
                (cliente_empresa, cidade, vendedor, status, tipo_obra, num_orcamentos,
                 primeiro_orcamento, ultimo_orcamento, notas, origem)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    rec.get("Cliente/Empresa", "").strip() or "(sem nome)",
                    rec.get("Cidade", "") or "",
                    rec.get("Vendedor", "") or "",
                    rec.get("Status do Lead", "") or "Em orçamento",
                    rec.get("Tipo de Obra", "") or "",
                    rec.get("Nº de Orçamentos", 0) or 0,
                    rec.get("Primeiro Orçamento", "") or "",
                    rec.get("Último Orçamento", "") or "",
                    "",
                    "",
                ),
            )
            lead_id = cur.lastrowid
            for url in rec.get("Orçamentos", []) or []:
                conn.execute(
                    "INSERT INTO orcamento_links (lead_id, url) VALUES (?, ?)",
                    (lead_id, url),
                )
            count += 1

    print(f"Importados {count} leads do Notion com sucesso a partir de {SEED_FILE.name}.")


if __name__ == "__main__":
    main()
