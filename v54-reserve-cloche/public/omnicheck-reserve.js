/* OMNICHECK — carte « Fonds de réserve » (cible 500 000 000 FCFA). Ajoutée sans toucher au reste de la page : lit la clé admin saisie en haut. */
(function () {
  var $ = function (i) { return document.getElementById(i); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var f = function (n) { return Number(n || 0).toLocaleString("fr-FR").replace(/ | /g, " ") + " F"; };
  var KIND = { apport: "Apport", engagement: "Engagement", retour: "Retour", sortie: "Sortie" }, BK = { marchands: "Marchands", transferts: "Transferts", developpement: "Développement" };
  function H() { var k = $("key"), o = $("otp"); return { "x-admin-key": k ? k.value : "", "x-admin-otp": o ? (o.value || "").trim() : "", "content-type": "application/json" }; }
  async function api(p, body) {
    var r = await fetch(p, { method: body ? "POST" : "GET", headers: H(), body: body ? JSON.stringify(body) : undefined });
    var d = await r.json().catch(function () { return {}; }); if (!r.ok) throw new Error(d.error || d.message || "Erreur."); return d;
  }
  var card = document.createElement("div"); card.className = "card"; card.id = "rsv";
  card.innerHTML = '<h2>Fonds de réserve OMNIPAY</h2><p class="mut">Financement propre : marchands, transferts, nouveaux secteurs. Le fonds ne contient que l\'argent <b>réel</b> que vous y versez : enregistrez chaque apport avec sa référence (virement, compte). Rien n\'est créé automatiquement et aucun solde client n\'est touché.</p>'
    + '<div id="rsv_k"></div><table id="rsv_t"></table><div id="rsv_e" class="bad"></div>'
    + '<h2 style="margin-top:14px">Enregistrer un mouvement</h2><select id="rsv_kind" style="width:100%;padding:12px;margin-top:6px;border-radius:10px"><option value="apport">Apport (argent ajouté au fonds)</option><option value="engagement">Engagement (financement accordé)</option><option value="retour">Retour (remboursement reçu)</option><option value="sortie">Sortie du fonds</option></select>'
    + '<select id="rsv_b" style="width:100%;padding:12px;margin-top:6px;border-radius:10px"><option value="marchands">Usage : marchands</option><option value="transferts">Usage : transferts</option><option value="developpement">Usage : développement</option></select>'
    + '<input id="rsv_a" type="number" placeholder="Montant en FCFA" style="margin-top:6px"><input id="rsv_r" placeholder="Référence (n° virement, compte, contrat…)" style="margin-top:6px"><input id="rsv_n" placeholder="Note (facultatif)" style="margin-top:6px">'
    + '<button class="sec" onclick="rsvAdd()">Enregistrer</button> <button class="sec" onclick="rsvLoad()">Actualiser</button>'
    + '<h2 style="margin-top:14px">Réglages</h2><input id="rsv_tg" type="number" placeholder="Cible en FCFA" style="margin-top:6px"><input id="rsv_p" type="number" placeholder="% des commissions mis de côté" style="margin-top:6px"><button class="sec" onclick="rsvSet()">Enregistrer les réglages</button>'
    + '<h2 style="margin-top:14px">Journal</h2><div style="overflow-x:auto"><table id="rsv_j"></table></div>';
  var host = document.querySelector(".card") ; var all = document.querySelectorAll(".card"), anchor = null;
  for (var i = 0; i < all.length; i++) { var h2 = all[i].querySelector("h2"); if (h2 && /^Gestionnaire de fonds/.test(h2.textContent)) { anchor = all[i]; break; } }
  if (anchor) anchor.parentNode.insertBefore(card, anchor); else if (host) host.parentNode.appendChild(card); else document.body.appendChild(card);
  function tile(l, v, sub) { return '<div class="kp"><small>' + esc(l) + '</small><b>' + esc(v) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>'; }
  window.rsvLoad = async function () {
    var e = $("rsv_e"); e.textContent = "";
    try {
      var d = await api("/api/reserve/overview");
      $("rsv_k").innerHTML = '<div style="background:rgba(127,127,127,.2);border-radius:99px;height:16px;overflow:hidden;margin:8px 0"><div style="width:' + d.progressPct + '%;height:100%;background:#17c98f"></div></div><b>' + d.progressPct + ' %</b> de ' + f(d.target)
        + '<div class="k" style="margin-top:8px">' + tile("Constitué", f(d.funded)) + tile("Engagé", f(d.engaged)) + tile("Disponible", f(d.available)) + tile("Reste à constituer", f(d.remaining)) + '</div>';
      var proj = d.monthsToTarget === 0 ? "Cible atteinte." : d.monthsToTarget == null ? "Pas de commissions sur 30 jours : aucune projection." : "À ce rythme (" + d.setAsidePct + " % des commissions) : environ " + d.monthsToTarget + " mois.";
      $("rsv_t").innerHTML = '<tr><td>Commissions réelles (30 j)</td><td>' + f(d.commissions30d) + '</td></tr><tr><td>Mise de côté conseillée / mois (' + d.setAsidePct + ' %)</td><td>' + f(d.advisedMonthly) + '</td></tr><tr><td>Projection</td><td>' + esc(proj) + '</td></tr>'
        + Object.keys(BK).map(function (b) { return '<tr><td>Engagé · ' + BK[b] + '</td><td>' + f(d.byBucket[b]) + '</td></tr>'; }).join("");
      $("rsv_tg").value = d.target; $("rsv_p").value = d.setAsidePct;
      var j = await api("/api/reserve/entries");
      $("rsv_j").innerHTML = '<tr><th>Date</th><th>Type</th><th>Usage</th><th>Montant</th><th>Référence</th></tr>' + (j.entries.length ? j.entries.map(function (x) { return '<tr><td>' + esc(String(x.created_at).slice(0, 10)) + '</td><td>' + esc(KIND[x.kind] || x.kind) + '</td><td>' + esc(BK[x.bucket] || "") + '</td><td>' + f(x.amount) + '</td><td>' + esc(x.ref) + '</td></tr>'; }).join("") : '<tr><td colspan="5">Aucun mouvement.</td></tr>');
    } catch (x) { e.textContent = x.message; }
  };
  window.rsvAdd = async function () {
    try { await api("/api/reserve/entry", { kind: $("rsv_kind").value, bucket: $("rsv_b").value, amount: $("rsv_a").value, ref: $("rsv_r").value, note: $("rsv_n").value }); $("rsv_a").value = ""; $("rsv_r").value = ""; $("rsv_n").value = ""; await rsvLoad(); }
    catch (x) { $("rsv_e").textContent = x.message; }
  };
  window.rsvSet = async function () { try { await api("/api/reserve/settings", { target: $("rsv_tg").value, setAsidePct: $("rsv_p").value }); await rsvLoad(); } catch (x) { $("rsv_e").textContent = x.message; } };
  var k = $("key"); if (k) k.addEventListener("change", function () { rsvLoad(); }); setTimeout(function () { if (k && k.value) rsvLoad(); }, 800);
})();
