#!/bin/bash
# Génère UN NOUVEAU secret de double authentification, localement (rien n'est envoyé nulle part).
# 1) Lancez :  bash nouveau_2fa.sh      2) Dans Google Authenticator : « + » → « Saisir une clé de configuration » → collez le secret.
# 3) Sur Render → Environment : ADMIN_TOTP_SECRET = ce même secret (sans espace ni guillemets) → Save.
node -e '
const c=require("crypto"),A="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let s="";const b=c.randomBytes(20);
let bits="";for(const x of b)bits+=x.toString(2).padStart(8,"0");for(let i=0;i<bits.length;i+=5)s+=A[parseInt(bits.slice(i,i+5).padEnd(5,"0"),2)];
console.log("\nSecret (32 caractères) :\n\n   "+s+"\n\nNom du compte à saisir dans l application : OMNICHECK\n")'
