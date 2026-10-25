"use strict";

async function login() {
  try {
    $("err").textContent = "";
    const response = await fetch("/api/admin-session/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: $("key").value,
        otp: ($("otp").value || "").trim()
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Connexion refusée.");
    $("key").value = "";
    $("otp").value = "";
    await load();
  } catch (error) {
    $("err").textContent = error.message;
  }
}

async function logout() {
  await fetch("/api/admin-session/logout", { method: "POST" }).catch(() => {});
  $("out").classList.add("hide");
  $("err").textContent = "Session administrateur fermée."; }
