from pathlib import Path
p = Path("routes/manualPayments.js")
s = p.read_text(encoding="utf-8")
old = """    status varchar(12) NOT NULL DEFAULT 'pending', decided_note varchar(300),
    created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz)`;"""
new = """    status varchar(12) NOT NULL DEFAULT 'pending', decided_note varchar(300),
    payment_channel varchar(20), payment_ref varchar(160), paid_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz)`;
  await q`ALTER TABLE manual_payouts ADD COLUMN IF NOT EXISTS payment_channel varchar(20)`;
  await q`ALTER TABLE manual_payouts ADD COLUMN IF NOT EXISTS payment_ref varchar(160)`;
  await q`ALTER TABLE manual_payouts ADD COLUMN IF NOT EXISTS paid_at timestamptz`;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS manual_payouts_payment_ref_uniq ON manual_payouts (lower(payment_ref)) WHERE payment_ref IS NOT NULL`;"""
if old not in s:
    raise SystemExit("ERREUR: definition manual_payouts introuvable")
p.write_text(s.replace(old, new, 1), encoding="utf-8")
print("OK: colonnes de preuve ajoutees au schema manual_payouts")
