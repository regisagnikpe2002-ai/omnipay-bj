"use strict";
// OMNIPAY — GÉNÉRATEUR D'ADRESSES CRYPTO (clé PUBLIQUE étendue uniquement : aucune clé privée sur le serveur).
// À partir de EX_XPUB, dérive pour chaque client des adresses uniques : EVM (ETH, BNB/BSC, Polygon…), TRON, Bitcoin (bech32), Litecoin (bech32), Dogecoin, XRP.
// Les fonds arrivent sur des adresses dont SEUL OMNIPAY détient la phrase secrète (papier + coffre) ; les clients ne reçoivent que l'adresse publique.
const { HDNodeWallet, ripemd160, sha256, getBytes, hexlify } = require("ethers");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RIPPLE = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const b = (x) => Buffer.from(getBytes(x));
const sha = (buf) => b(sha256(buf));
const hash160 = (pub) => b(ripemd160(sha256(pub)));

function base58(buf, alpha) {
  let n = BigInt("0x" + (buf.toString("hex") || "0")), out = "";
  while (n > 0n) { out = alpha[Number(n % 58n)] + out; n /= 58n; }
  for (const x of buf) { if (x === 0) out = alpha[0] + out; else break; }
  return out;
}
function base58check(version, payload, alpha = B58) {
  const raw = Buffer.concat([Buffer.from(version), payload]), chk = sha(sha(raw)).subarray(0, 4);
  return base58(Buffer.concat([raw, chk]), alpha);
}
function base58decode(str) {
  let n = 0n; for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error("base58"); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  let buf = Buffer.from(hex, "hex"); let z = 0; for (const c of str) { if (c === B58[0]) z++; else break; }
  return Buffer.concat([Buffer.alloc(z), buf]);
}
// bech32 (BIP-173), version 0 : bc1q… (Bitcoin) / ltc1q… (Litecoin)
const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l", GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(v) { let c = 1; for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= GEN[i]; } return c >>> 0; }
const hrpExp = (h) => [...h].map((c) => c.charCodeAt(0) >> 5).concat([0], [...h].map((c) => c.charCodeAt(0) & 31));
function bech32(hrp, prog20) {
  const data = [0], acc = []; let a = 0, bits = 0;
  for (const x of prog20) { a = (a << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; acc.push((a >> bits) & 31); } a &= (1 << bits) - 1; }
  if (bits) acc.push((a << (5 - bits)) & 31);
  const d = data.concat(acc), pm = polymod(hrpExp(hrp).concat(d, [0, 0, 0, 0, 0, 0])) ^ 1;
  const chk = [0, 1, 2, 3, 4, 5].map((i) => (pm >>> (5 * (5 - i))) & 31);
  return hrp + "1" + d.concat(chk).map((x) => CH[x]).join("");
}

// Adresse d'une clé publique compressée (hex 0x02…/0x03…) pour un type donné.
function fromPub(pubHex, kind, evmAddress) {
  const pub = b(pubHex), h = hash160(pub);
  switch (kind) {
    case "evm": return evmAddress;
    case "tron": return base58check([0x41], Buffer.from(evmAddress.slice(2), "hex"));
    case "btc": return bech32("bc", h);
    case "ltc": return bech32("ltc", h);
    case "doge": return base58check([0x1e], h);
    case "xrp": return base58check([0x00], h, RIPPLE);
    default: throw new Error("type d'adresse inconnu");
  }
}
const tronToHex = (addr) => base58decode(addr).subarray(0, 21).toString("hex"); // 41 + 20 octets (comme dans les réponses TronGrid)

let ROOT = null, ROOT_FOR = null;
function root(xpub) {
  if (ROOT && ROOT_FOR === xpub) return ROOT;
  const n = HDNodeWallet.fromExtendedKey(xpub);
  if (n.privateKey) throw new Error("EX_XPUB doit être une clé publique (xpub), jamais une clé privée");
  ROOT = n; ROOT_FOR = xpub; return n;
}
function address(xpub, index, kind) {
  const c = root(xpub).deriveChild(index);
  return fromPub(c.publicKey, kind, c.address);
}
module.exports = { address, fromPub, bech32, base58check, base58decode, tronToHex, hash160, RIPPLE };
