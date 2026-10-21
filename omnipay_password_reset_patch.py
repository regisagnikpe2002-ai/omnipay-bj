#!/usr/bin/env python3
from pathlib import Path
import shutil
import sys
import re
from datetime import datetime

ROOT = Path.cwd()
STAMP = datetime.now().strftime('%Y%m%d-%H%M%S')
BACKUP = ROOT / f'password-reset-backup-{STAMP}'

required = [
    ROOT / 'authController.js',
    ROOT / 'routes' / 'auth.js',
    ROOT / 'public' / 'dashboard-v3.js',
    ROOT / 'public' / 'register-otp.js',
]
missing = [str(p.relative_to(ROOT)) for p in required if not p.exists()]
if missing:
    print('ERREUR: fichiers manquants: ' + ', '.join(missing))
    sys.exit(1)

BACKUP.mkdir(parents=True, exist_ok=True)
for p in required:
    dest = BACKUP / p.relative_to(ROOT)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(p, dest)

# 1) authController.js
path = ROOT / 'authController.js'
text = path.read_text(encoding='utf-8')

old_sig = 'function verifyEmailVerificationToken({ verificationToken, email }) {'
new_sig = 'function verifyEmailVerificationToken({ verificationToken, email, purpose = "register" }) {'
if old_sig in text:
    text = text.replace(old_sig, new_sig, 1)
elif new_sig not in text:
    raise SystemExit('ERREUR: fonction verifyEmailVerificationToken introuvable.')

old_compare = 'data.purpose === "register" &&'
new_compare = 'data.purpose === purpose &&'
if old_compare in text:
    text = text.replace(old_compare, new_compare, 1)
elif new_compare not in text:
    raise SystemExit('ERREUR: contrôle purpose OTP introuvable.')

old_register_call = '''const otpVerified = verifyEmailVerificationToken({
      verificationToken,
      email: normalizedEmail,
    });'''
new_register_call = '''const otpVerified = verifyEmailVerificationToken({
      verificationToken,
      email: normalizedEmail,
      purpose: "register",
    });'''
if old_register_call in text:
    text = text.replace(old_register_call, new_register_call, 1)

reset_code = r'''
async function resetPassword(req, res) {
  try {
    const { email, newPassword, verificationToken } = req.body;

    if (!email || !newPassword || !verificationToken) {
      return res.status(400).json({
        error: "email, newPassword et verificationToken sont requis.",
      });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({
        error: "Le nouveau mot de passe doit contenir au moins 8 caractères.",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const otpVerified = verifyEmailVerificationToken({
      verificationToken,
      email: normalizedEmail,
      purpose: "password_reset",
    });

    if (!otpVerified) {
      return res.status(403).json({
        error: "Vérification OTP invalide ou expirée.",
      });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });

    if (!user) {
      return res.status(404).json({ error: "Compte OMNIPAY introuvable." });
    }

    const passwordHash = await hashPassword(String(newPassword));

    await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, user.id));

    return res.status(200).json({
      success: true,
      message: "Mot de passe modifié. Vous pouvez vous connecter.",
    });
  } catch (err) {
    console.error("PASSWORD_RESET_ERROR", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la modification du mot de passe.",
    });
  }
}
'''

if 'async function resetPassword(' not in text:
    marker = '\nmodule.exports = { register, login };'
    if marker not in text:
        raise SystemExit('ERREUR: export authController introuvable.')
    text = text.replace(marker, '\n' + reset_code + '\nmodule.exports = { register, login, resetPassword };', 1)
else:
    text = text.replace('module.exports = { register, login };', 'module.exports = { register, login, resetPassword };')

path.write_text(text, encoding='utf-8')

# 2) routes/auth.js
path = ROOT / 'routes' / 'auth.js'
text = path.read_text(encoding='utf-8')
text = text.replace(
    'const { register, login } = require("../authController.js");',
    'const { register, login, resetPassword } = require("../authController.js");'
)
if 'router.post("/reset-password", resetPassword);' not in text:
    text = text.replace(
        'router.post("/login", login);',
        'router.post("/login", login);\nrouter.post("/reset-password", resetPassword);'
    )
path.write_text(text, encoding='utf-8')

# 3) forgot-password.html
forgot_html = '''<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#07111f">
  <title>Mot de passe oublié | OMNIPAY</title>
  <style>
    :root{--bg:#050b16;--panel:#0d1829;--text:#f8fafc;--muted:#94a3b8;--line:#24344d;--teal:#14b8a6;--cyan:#5eead4;--amber:#f59e0b;--green:#22c55e}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 10% 0%,rgba(20,184,166,.22),transparent 34%),var(--bg)}
    .card{width:min(560px,100%);padding:28px;border:1px solid var(--line);border-radius:26px;background:linear-gradient(145deg,#12223a,#091321);box-shadow:0 24px 70px rgba(0,0,0,.3)}
    .brand{display:flex;align-items:center;gap:12px;margin-bottom:24px}.logo{display:grid;place-items:center;width:50px;height:50px;border-radius:16px;background:linear-gradient(135deg,#99f6e4,var(--teal));color:#022c2a;font-weight:950;font-size:24px}.brand h1{margin:0;font-size:22px}.muted{color:var(--muted)}
    .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:20px 0}.step{padding:10px;border:1px solid var(--line);border-radius:12px;text-align:center;color:var(--muted);font-size:12px}.step.active{color:var(--cyan);border-color:rgba(20,184,166,.45);background:rgba(20,184,166,.1)}
    .field{margin-top:14px}.field label{display:block;margin-bottom:7px;font-size:13px;font-weight:750}.field input{width:100%;padding:14px;border:1px solid #334155;border-radius:14px;outline:none;color:var(--text);background:#07111f}.field input:focus{border-color:var(--teal);box-shadow:0 0 0 4px rgba(20,184,166,.12)}
    .actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}.btn{min-height:48px;border:0;border-radius:14px;padding:13px;color:#fff;font-weight:850;cursor:pointer}.primary{background:linear-gradient(135deg,var(--teal),#0f8f84)}.secondary{background:#17263d;border:1px solid var(--line)}.btn:disabled{opacity:.5;cursor:not-allowed}.hidden{display:none!important}.message{min-height:24px;margin-top:14px;color:var(--amber);font-size:13px}.back{display:inline-block;margin-top:18px;color:var(--cyan);text-decoration:none;font-size:13px;font-weight:750}@media(max-width:560px){.actions,.steps{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main class="card">
    <div class="brand"><div class="logo">O</div><div><h1>OMNIPAY</h1><div class="muted">Récupération sécurisée du compte</div></div></div>
    <div class="steps"><div id="step1" class="step active">1. Email</div><div id="step2" class="step">2. Code OTP</div><div id="step3" class="step">3. Nouveau mot de passe</div></div>
    <form id="resetForm">
      <div class="field"><label for="email">Adresse email du compte</label><input id="email" type="email" autocomplete="email" required></div>
      <div class="actions"><button id="requestOtpBtn" class="btn secondary" type="button">Recevoir le code OTP</button><button id="verifyOtpBtn" class="btn secondary" type="button" disabled>Vérifier le code</button></div>
      <div id="otpField" class="field hidden"><label for="otpCode">Code OTP à 6 chiffres</label><input id="otpCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></div>
      <div id="passwordFields" class="hidden"><div class="field"><label for="newPassword">Nouveau mot de passe</label><input id="newPassword" type="password" minlength="8" autocomplete="new-password"></div><div class="field"><label for="confirmPassword">Confirmer le nouveau mot de passe</label><input id="confirmPassword" type="password" minlength="8" autocomplete="new-password"></div><button id="resetBtn" class="btn primary" style="width:100%;margin-top:16px" type="submit">Modifier mon mot de passe</button></div>
      <div id="message" class="message" aria-live="polite"></div>
    </form>
    <a class="back" href="/">Retour à la connexion</a>
  </main>
  <script src="/forgot-password.js"></script>
</body>
</html>
'''
(ROOT / 'public' / 'forgot-password.html').write_text(forgot_html, encoding='utf-8')

# 4) forgot-password.js
forgot_js = '''"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { challengeId: "", verificationToken: "", verifiedEmail: "" };
  function message(text, ok = false) { $("message").textContent = text; $("message").style.color = ok ? "#86efac" : "#fbbf24"; }
  async function api(path, body) { const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || data.message || "Requête impossible."); return data; }
  function step(number) { [1,2,3].forEach((i) => $("step" + i).classList.toggle("active", i === number)); }
  async function requestOtp() { const email = $("email").value.trim().toLowerCase(); if (!email) return message("Saisissez votre adresse email."); const button = $("requestOtpBtn"); button.disabled = true; message("Envoi du code OTP..."); try { const data = await api("/api/email-otp/request", { email, purpose: "password_reset" }); state.challengeId = data.challengeId; state.verificationToken = ""; state.verifiedEmail = ""; $("otpField").classList.remove("hidden"); $("verifyOtpBtn").disabled = false; $("passwordFields").classList.add("hidden"); step(2); message(data.message || "Code envoyé par email.", true); } catch (error) { message(error.message); } finally { button.disabled = false; } }
  async function verifyOtp() { const email = $("email").value.trim().toLowerCase(); const code = $("otpCode").value.trim(); if (!state.challengeId) return message("Demandez d'abord un code OTP."); if (!/^\\d{6}$/.test(code)) return message("Le code doit contenir 6 chiffres."); const button = $("verifyOtpBtn"); button.disabled = true; message("Vérification du code..."); try { const data = await api("/api/email-otp/verify", { challengeId: state.challengeId, email, purpose: "password_reset", code }); state.verificationToken = data.verificationToken; state.verifiedEmail = email; $("passwordFields").classList.remove("hidden"); step(3); message("Email vérifié. Choisissez un nouveau mot de passe.", true); } catch (error) { message(error.message); button.disabled = false; } }
  async function reset(event) { event.preventDefault(); const email = $("email").value.trim().toLowerCase(); const newPassword = $("newPassword").value; const confirmation = $("confirmPassword").value; if (!state.verificationToken || email !== state.verifiedEmail) return message("Vérifiez d'abord votre email avec le code OTP."); if (newPassword.length < 8) return message("Le mot de passe doit contenir au moins 8 caractères."); if (newPassword !== confirmation) return message("Les mots de passe ne correspondent pas."); const button = $("resetBtn"); button.disabled = true; message("Modification du mot de passe..."); try { const data = await api("/auth/reset-password", { email, newPassword, verificationToken: state.verificationToken }); message(data.message || "Mot de passe modifié.", true); setTimeout(() => { location.href = "/"; }, 1200); } catch (error) { message(error.message); button.disabled = false; } }
  $("requestOtpBtn").addEventListener("click", requestOtp);
  $("verifyOtpBtn").addEventListener("click", verifyOtp);
  $("resetForm").addEventListener("submit", reset);
  $("email").addEventListener("input", () => { const email = $("email").value.trim().toLowerCase(); if (state.verifiedEmail && email !== state.verifiedEmail) { state.verificationToken = ""; state.verifiedEmail = ""; $("passwordFields").classList.add("hidden"); message("Email modifié. Demandez un nouveau code OTP."); } });
})();
'''
(ROOT / 'public' / 'forgot-password.js').write_text(forgot_js, encoding='utf-8')

# 5) Dashboard V3 button now redirects to reset page
path = ROOT / 'public' / 'dashboard-v3.js'
text = path.read_text(encoding='utf-8')
old = 'byId("forgotPasswordBtn")?.addEventListener("click", () => alert("Récupération du mot de passe bientôt disponible."));'
new = 'byId("forgotPasswordBtn")?.addEventListener("click", () => { window.location.href = "/forgot-password.html"; });'
if old in text:
    text = text.replace(old, new, 1)
elif '/forgot-password.html' not in text:
    print('WARN: bouton mot de passe oublié non remplacé automatiquement.')
path.write_text(text, encoding='utf-8')

# 6) Registration now arrives at the V2 homepage
path = ROOT / 'public' / 'register-otp.js'
text = path.read_text(encoding='utf-8')
text = text.replace('location.href="/dashboard-v2.html"', 'location.href="/"')
text = text.replace("location.href='/dashboard-v2.html'", "location.href='/'")
path.write_text(text, encoding='utf-8')

print('PASSWORD_RESET_PATCH_OK')
print('BACKUP=' + str(BACKUP.relative_to(ROOT)))
print('NEXT=node --check authController.js && node --check public/forgot-password.js && node --check public/dashboard-v3.js')
