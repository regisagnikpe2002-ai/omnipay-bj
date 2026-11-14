"use strict";
// OMNIPAY — PHOTO DE PROFIL du client (image réduite à 256 px par l'application, ≤ 60 Ko). Vérifie le vrai format du fichier (JPEG / PNG / WebP).
// GET /api/profile/photo → { photo: "data:image/jpeg;base64,…" | null } · POST /api/profile/photo { image } · DELETE /api/profile/photo
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const sql = () => neon(process.env.DATABASE_URL);
const router = express.Router();
const MAX = 60 * 1024; // le corps JSON du serveur est limité à 100 Ko
let ready = false;
async function ensure() { if (ready) return; await sql()`CREATE TABLE IF NOT EXISTS user_photos (user_id uuid PRIMARY KEY, data text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`; ready = true; }

function parse(s) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ""));
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || buf.length > MAX) return null;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff, png = buf.slice(0, 4).toString("hex") === "89504e47", webp = buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
  const okType = (m[1] === "image/jpeg" && jpg) || (m[1] === "image/png" && png) || (m[1] === "image/webp" && webp);
  return okType ? m[0] : null;
}
router.get("/photo", requireAuth, async (req, res) => {
  try { await ensure(); const [r] = await sql()`SELECT data FROM user_photos WHERE user_id = ${req.user.userId}::uuid`; res.set("Cache-Control", "private, no-store"); res.json({ photo: r ? r.data : null }); }
  catch (e) { console.error("PHOTO_GET", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});
router.post("/photo", requireAuth, async (req, res) => {
  try {
    await ensure(); const img = parse(req.body && req.body.image);
    if (!img) return res.status(400).json({ error: "Image invalide (JPEG, PNG ou WebP, 60 Ko maximum)." });
    await sql()`INSERT INTO user_photos (user_id, data) VALUES (${req.user.userId}::uuid, ${img}) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
    res.json({ message: "Photo enregistrée." });
  } catch (e) { console.error("PHOTO_SET", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});
router.delete("/photo", requireAuth, async (req, res) => {
  try { await ensure(); await sql()`DELETE FROM user_photos WHERE user_id = ${req.user.userId}::uuid`; res.json({ message: "Photo supprimée." }); }
  catch (e) { console.error("PHOTO_DEL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});
module.exports = router; module.exports._parse = parse;
