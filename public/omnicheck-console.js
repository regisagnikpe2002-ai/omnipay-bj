/* OMNICHECK — « Console paiements » : remplace les commandes du terminal. Lit la clé admin saisie en haut de la page. */
(function () {
  var $ = function (i) { return document.getElementById(i); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var f = function (n) { return Number(n || 0).toLocaleString("fr-FR") + " F"; };
  function H() { var k = $("key"), o = $("otp"); return { "x-admin-key": k ? k.value : "", "x-admin-otp": o ? (o.value || "").trim() : "", "content-type": "application/json" }; }
  async function api(p, body) {
    var r = await fetch(p, { method: body ? "POST" : "GET", headers: H(), body: body ? JSON.stringify(body) : undefined });
    var d = await r.json().catch(function () { return {}; }); if (!r.ok) throw new Error(d.error || d.message || "Erreur."); return d;
  }
  var card = document.createElement("div"); card.className = "card"; card.id = "pcs";
  card.innerHTML = '<h2>Console paiements</h2><p class="mut">Vérifiez vos fournisseurs, envoyez ou remboursez un retrait, testez l\'e-mail. Tout se fait ici, sans terminal. Saisissez d\'abord la clé administrateur en haut.</p>'
    + '<div class="row"><button class="sec" onclick="pcsStatus()">Vérifier les fournisseurs</button><button class="sec" onclick="pcsStuck()">Retraits en attente</button></div>'
    + '<div id="pcs_s" style="margin-top:10px"></div>'
    + '<h2 style="margin-top:14px">Retraits à traiter</h2><div id="pcs_w"><p class="mut">Cliquez sur « Retraits en attente ».</p></div>'
    + '<h2 style="margin-top:14px">Test de l\'e-mail du code</h2><input id="pcs_m" type="email" placeholder="Votre adresse e-mail" style="margin-top:6px"><button class="sec" onclick="pcsMail()">Envoyer un mail de test</button>'
    + '<div id="pcs_e" class="bad" style="margin-top:8px"></div>';
  var all = document.querySelectorAll(".card"), anchor = null;
  for (var i = 0; i < all.length; i++) { var h2 = all[i].querySelector("h2"); if (h2 && /^Gestionnaire de fonds/.test(h2.textContent)) { anchor = all[i]; break; } }
  if (anchor) anchor.parentNode.insertBefore(card, anchor); else document.body.appendChild(card);
  function line(ok, label, txt) { return '<div style="display:flex;gap:8px;margin:5px 0"><span>' + (ok === true ? "✅" : ok === false ? "❌" : "⚪") + '</span><div><b>' + esc(label) + '</b><br><small>' + esc(txt) + '</small></div></div>'; }
  function err(x) { $("pcs_e").textContent = x && x.message || String(x); }
  window.pcsStatus = async function () {
    $("pcs_e").textContent = ""; var out = "";
    try { var d = await api("/api/fedapay/admin/status"); out += line(d.configured && d.env === "live", "FedaPay", (d.configured ? "clé présente" : "clé absente") + " · mode " + d.env + " · plafond " + f(d.capXof) + " · retraits : " + d.payouts.en_cours + " en cours, " + d.payouts.reussis + " réussis, " + d.payouts.echoues + " échoués" + (d.payouts.incertains ? ", " + d.payouts.incertains + " à vérifier" : "")); } catch (x) { out += line(false, "FedaPay", x.message); }
    try { var p = await api("/api/pawapay/admin/status"); out += line(!!p.tokenOk, "PawaPay", (p.configured ? "clé présente" : "clé absente") + " · mode " + p.env + (p.tokenOk ? " · jeton accepté" : " · jeton refusé" + (p.error ? " (" + p.error + ")" : "")) + " · dépôts en attente : " + p.pending_deposits); } catch (x) { out += line(false, "PawaPay", x.message); }
    try { var o = await api("/api/otp/admin/status"); out += line(!!o.email && !o.lastError, "Code de confirmation", "e-mail " + (o.email ? "actif" : "inactif") + " · SMS " + (o.sms ? "actif" : "inactif") + (o.lastError ? " · dernière erreur : " + o.lastError.message : " · aucune erreur")); } catch (x) { out += line(false, "Code de confirmation", x.message); }
    $("pcs_s").innerHTML = out;
  };
  window.pcsStuck = async function () {
    $("pcs_e").textContent = "";
    try {
      var d = await api("/api/ops/stuck"), L = d.withdrawals || [];
      $("pcs_w").innerHTML = (d.autoPayout ? '<p class="mut">Envoi automatique : activé.</p>' : '<p class="mut">Envoi automatique : désactivé.</p>') + (L.length ? L.map(function (w) {
        var pay = (w.metadata && w.metadata.payout) || {};
        return '<div class="kp" style="margin:8px 0"><b>' + f(w.amount) + '</b> · ' + esc(String(w.operator || "").toUpperCase()) + ' · ' + esc(w.phone) + '<br><small>' + esc((w.first_name || "") + " " + (w.last_name || "")) + ' · ' + esc(String(w.created_at).slice(0, 16).replace("T", " ")) + ' · statut : ' + esc(w.status) + '</small>'
          + (pay.detail ? '<br><small>Dernier essai : ' + esc(pay.route || "") + ' · ' + esc(pay.result || "") + ' · ' + esc(pay.detail) + '</small>' : '')
          + '<div class="row" style="margin-top:6px"><button class="sec" onclick="pcsSend(\'' + esc(w.id) + '\')">Envoyer</button><button class="sec" onclick="pcsRefund(\'' + esc(w.id) + '\')">Rembourser</button></div></div>';
      }).join("") : '<p class="mut">Aucun retrait en attente.</p>');
    } catch (x) { err(x); }
  };
  window.pcsSend = async function (id) {
    if (!confirm("Envoyer ce retrait maintenant au fournisseur ? De l'argent réel sera payé.")) return;
    try { var r = await api("/api/ops/withdraw/" + id + "/send", {}); alert("Résultat : " + r.result + (r.route ? " (" + r.route + ")" : "") + (r.detail ? "\n" + r.detail : "")); await pcsStuck(); await pcsStatus(); } catch (x) { err(x); }
  };
  window.pcsRefund = async function (id) {
    if (!confirm("Rembourser ce retrait au client ? L'argent revient sur son solde.")) return;
    try { var r = await api("/api/ops/refund", { ids: [id], note: "Remboursé depuis la console OMNICHECK" }); alert("Remboursé : " + (r.refundedCount || 0) + " retrait(s)."); await pcsStuck(); } catch (x) { err(x); }
  };
  window.pcsMail = async function () {
    $("pcs_e").textContent = "";
    try { var m = ($("pcs_m").value || "").trim(); if (!m) throw new Error("Saisissez une adresse e-mail."); await api("/api/otp/admin/test", { email: m }); $("pcs_e").style.color = "#17c98f"; $("pcs_e").textContent = "Mail de test envoyé à " + m + "."; } catch (x) { $("pcs_e").style.color = ""; err(x); }
  };
})();
