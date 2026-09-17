const { eq, or } = require("drizzle-orm");
const { db } = require("./db/index.js");
const { users, wallets } = require("./db/schema.js");
const {
  hashPassword,
  comparePassword,
  signAccessToken,
  signRefreshToken,
} = require("./lib/auth-utils.js");

async function register(req, res) {
  try {
    const { email, phone, password, firstName, lastName } = req.body;

    if (!email || !phone || !password) {
      return res.status(400).json({ error: "email, phone et password sont requis." });
    }

    const existing = await db.query.users.findFirst({
      where: or(eq(users.email, email), eq(users.phone, phone)),
    });
    if (existing) {
      return res.status(409).json({ error: "Un compte existe déjà avec cet email ou ce numéro." });
    }

    const passwordHash = await hashPassword(password);

    const [user] = await db
      .insert(users)
      .values({
        email,
        phone,
        passwordHash,
        firstName,
        lastName,
      })
      .returning();

    await db.insert(wallets).values({
      userId: user.id,
      balance: "0",
      currency: "XOF",
    });

    const payload = { userId: user.id, role: user.role };
    return res.status(201).json({
      user: { id: user.id, email: user.email, phone: user.phone },
      accessToken: signAccessToken(payload),
      refreshToken: signRefreshToken(payload),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur serveur lors de l'inscription." });
  }
}

async function login(req, res) {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ error: "identifier et password sont requis." });
    }

    const user = await db.query.users.findFirst({
      where: or(eq(users.email, identifier), eq(users.phone, identifier)),
    });
    if (!user) {
      return res.status(401).json({ error: "Identifiants invalides." });
    }

    const valid = await comparePassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Identifiants invalides." });
    }

    const payload = { userId: user.id, role: user.role };
    return res.status(200).json({
      user: { id: user.id, email: user.email, phone: user.phone, role: user.role },
      accessToken: signAccessToken(payload),
      refreshToken: signRefreshToken(payload),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur serveur lors de la connexion." });
  }
}

module.exports = { register, login };