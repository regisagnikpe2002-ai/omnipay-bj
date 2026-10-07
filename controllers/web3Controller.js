const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { getAddress, verifyMessage } = require("ethers");

function getSql() {
  return neon(process.env.DATABASE_URL);
}

function normalizeAddress(address) {
  return getAddress(String(address || "").trim());
}

function allowedChain(chainId) {
  const allowed =
    (process.env.WEB3_ALLOWED_CHAIN_IDS || "8453")
      .split(",")
      .map((x) => Number(x.trim()));

  return allowed.includes(Number(chainId));
}

async function createWalletChallenge(req, res) {
  const sql = getSql();

  try {
    const userId = req.user?.userId;
    const walletAddress = normalizeAddress(
      req.body?.walletAddress
    );
    const chainId = Number(req.body?.chainId);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Utilisateur non authentifié.",
      });
    }

    if (!allowedChain(chainId)) {
      return res.status(400).json({
        success: false,
        error: "Réseau blockchain non autorisé.",
      });
    }

    const existing = await sql`
      SELECT user_id
      FROM web3_wallets
      WHERE wallet_address = ${walletAddress}
      LIMIT 1
    `;

    if (
      existing.length > 0 &&
      existing[0].user_id !== userId
    ) {
      return res.status(409).json({
        success: false,
        error: "Ce portefeuille est déjà lié à un autre compte.",
      });
    }

    const challengeId = crypto.randomUUID();
    const nonce = crypto.randomBytes(32).toString("hex");

    const nonceHash = crypto
      .createHash("sha256")
      .update(nonce)
      .digest("hex");

    const expiresAt = new Date(
      Date.now() + 5 * 60 * 1000
    );

    const message = [
      "OMNIPAY - Vérification du portefeuille",
      "",
      "Cette signature ne déclenche aucune transaction.",
      "Aucun frais blockchain ne sera prélevé.",
      "",
      `Utilisateur : ${userId}`,
      `Adresse : ${walletAddress}`,
      `Réseau : ${chainId}`,
      `Nonce : ${nonce}`,
      `Expiration : ${expiresAt.toISOString()}`,
    ].join("\n");

    await sql.transaction([
      sql`
        UPDATE web3_challenges
        SET consumed_at = NOW()
        WHERE user_id = ${userId}
          AND consumed_at IS NULL
      `,
      sql`
        INSERT INTO web3_challenges (
          id,
          user_id,
          wallet_address,
          chain_id,
          nonce_hash,
          message,
          expires_at
        )
        VALUES (
          ${challengeId},
          ${userId},
          ${walletAddress},
          ${chainId},
          ${nonceHash},
          ${message},
          ${expiresAt}
        )
      `,
    ]);

    return res.status(201).json({
      success: true,
      challengeId,
      message,
      expiresIn: 300,
    });
  } catch (error) {
    console.error(
      "WEB3_CHALLENGE_ERROR",
      error.message
    );

    return res.status(400).json({
      success: false,
      error: "Impossible de créer le challenge.",
    });
  }
} 

module.exports = {
  getSql,
  normalizeAddress,
  allowedChain,
  createWalletChallenge,
};
