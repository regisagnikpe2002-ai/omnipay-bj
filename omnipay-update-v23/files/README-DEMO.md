# OMNIPAY — Site DÉMO (séparé du site LIVE)

Règle : **le DÉMO et le LIVE ne se mélangent jamais.** Deux sites, deux bases de données, aucune clé commune.

| | LIVE | DÉMO |
|---|---|---|
| Adresse | www.omnipay-bj.com | demo.omnipay-bj.com (exemple) |
| Base de données | la vraie base Neon | un **nouveau projet Neon vide** (pas une « branche » du live : elle copierait les vrais clients) |
| `APP_MODE` | non défini (ou `live`) | `demo` |
| Clés (Brevo, MTN, PI-SPI, Binance, PayDunya…) | oui | **aucune** |
| Bandeau | aucun | « MODE DÉMO — données fictives » sur chaque écran |

## Créer le site démo
1. **Neon** : créer un NOUVEAU projet « omnipay-demo » (base vide). Copier son adresse de connexion (`DATABASE_URL`).
2. **Render** : New → Web Service → même dépôt GitHub. Nom : `omnipay-demo`. Variables d'environnement :
   - `APP_MODE=demo`
   - `DATABASE_URL=` l'adresse de la base DÉMO (jamais celle du live)
   - `ADMIN_KEY=` une clé **différente** de celle du live (32 caractères minimum)
   - `JWT_SECRET=` une valeur **différente** de celle du live
   - Ne mettre AUCUNE autre clé (pas de SMTP/Brevo, MTN, Binance, PayDunya, PI-SPI).
3. **Données fictives** : depuis votre ordinateur, dans le dossier du projet :
   ```
   APP_MODE=demo DEMO_SEED=yes DATABASE_URL='<adresse de la base DÉMO>' node scripts/seedDemo.js
   ```
   Le script **refuse** de tourner si la base contient un seul vrai utilisateur ou si `APP_MODE` n'est pas `demo`.
4. Comptes de démonstration (mot de passe : `Demo-2026!`, ou la valeur de `DEMO_PASSWORD`) :
   - clients : `demo.awa@demo.omnipay.test`, `demo.kofi@…`, `demo.mariam@…`
   - marchands : `demo.marchand1@demo.omnipay.test`, `demo.marchand2@…`
5. Facultatif : un sous-domaine `demo.omnipay-bj.com` (CNAME vers le service Render `omnipay-demo`).

## Ce que le mode démo garantit
- Toute connexion sortante vers un service réel (MTN, Moov, Celtiis, Ecobank, Binance hors cours publics, PayDunya, e-mail…) est **bloquée** par le serveur.
- Aucun e-mail n'est envoyé (les codes OTP s'affichent dans les journaux Render du site démo).
- Un bandeau orange rappelle « MODE DÉMO » sur chaque écran.

## Scénario de la vidéo (≈ 3 min, uniquement sur le site démo)
1. Connexion cliente → solde, envoi, reçu.
2. OMNICHECK : « Rédiger les ordres (IA) » → les retraits en attente deviennent des ordres.
3. Connexion marchand → « Passer en ligne » → prendre un ordre → payer → saisir la référence.
4. OMNICHECK : valider l'ordre de 250 000 F (double contrôle) → retrait clôturé.
5. Gestionnaire de fonds, Marchés, Défis, Objectif du mois.
Afficher en légende : « Démonstration — données fictives ». Les cours crypto de l'écran Marchés sont les vrais cours publics.
