# Session administrateur OMNIPAY

Fichiers inclus :
- `lib/adminSessionToken.js`
- `lib/adminShield.js`
- `routes/adminSession.js`

Dans `server.js`, montez la route avant les routes administratives :

```js
mount("/api/admin-session", "./routes/adminSession", "Session admin unique");
```

Variables Render :

```env
ADMIN_SESSION_SECRET=<au moins 32 caracteres aleatoires>
ADMIN_SESSION_TTL_SECONDS=28800
```

Endpoints :
- `POST /api/admin-session/login` avec `{ "key": "...", "otp": "123456" }`
- `GET /api/admin-session/me`
- `POST /api/admin-session/logout`

Après connexion, le navigateur envoie automatiquement un cookie `HttpOnly`, `Secure`, `SameSite=Strict`. Les routes existantes continuent à utiliser leurs contrôles `ADMIN_KEY`, injectés côté serveur pour une session valide.
