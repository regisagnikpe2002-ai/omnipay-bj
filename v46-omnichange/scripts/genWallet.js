// À lancer UNE FOIS sur ton Mac, hors ligne si possible :  node scripts/genWallet.js
// Crée la phrase secrète (12 mots) de la trésorerie OMNIPAY et la clé PUBLIQUE (xpub) à mettre sur Render dans EX_XPUB.
// La phrase secrète NE VA JAMAIS sur Render, ni sur GitHub, ni dans un chat : papier + coffre.
const { Wallet, HDNodeWallet } = require("ethers");
const w = Wallet.createRandom();
const phrase = w.mnemonic.phrase;
const acc = HDNodeWallet.fromPhrase(phrase, undefined, "m/44'/60'/0'/0");
console.log("\nPHRASE SECRÈTE (à noter sur papier, ne la partage JAMAIS) :\n" + phrase);
console.log("\nEX_XPUB (clé publique, à mettre sur Render) :\n" + acc.neuter().extendedKey);
console.log("\nExemple, 1re adresse client : " + acc.deriveChild(1).address + "\n");
