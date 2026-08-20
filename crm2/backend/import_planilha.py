"""Importa os contatos da planilha 'Acompanhamento comercial.xlsx' (aba Controle Geral)
para o CRM, como leads novos. Não duplica se rodado de novo (checa por
cliente_empresa + contato já existentes)."""
import json
from pathlib import Path

from database import get_db, init_db

SEED_FILE = Path(__file__).parent.parent / "notion_export" / "planilha_contatos.json"


def main():
    init_db()
    with open(SEED_FILE, encoding="utf-8") as f:
        records = json.load(f)

    with get_db() as conn:
        existing_pairs = set(
            (r["cliente_empresa"], r["contato"])
            for r in conn.execute("SELECT cliente_empresa, contato FROM leads").fetchall()
        )

        inserted = 0
        skipped = 0
        for rec in records:
            key = (rec["cliente_empresa"], rec["contato"])
            if key in existing_pairs:
                skipped += 1
                continue
            conn.execute(
                """INSERT INTO leads
                (cliente_empresa, contato, cargo, telefone1, telefone2, email,
                 segmento, cidade, status, primeiro_contato, proximo_contato,
                 notas, origem)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    rec["cliente_empresa"], rec["contato"], rec["cargo"],
                    rec["telefone1"], rec["telefone2"], rec["email"],
                    rec["segmento"], rec["cidade"], rec["status"],
                    rec["primeiro_contato"], rec["proximo_contato"],
                    rec["notas"], rec["origem"],
                ),
            )
            existing_pairs.add(key)
            inserted += 1

    print(f"Importados {inserted} contatos novos da planilha ({skipped} já existiam e foram ignorados).")


if __name__ == "__main__":
    main()
