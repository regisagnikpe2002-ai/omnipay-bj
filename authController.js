const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// REGISTER
exports.register = async (req, res) => {
    const { nom, email, password } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        const sql = "INSERT INTO utilisateurs (nom, email, password) VALUES (?, ?, ?)";
        db.query(sql, [nom, email, hashedPassword], (err, result) => {
            if (err) return res.status(500).json({ error: err });
            res.json({ message: "Utilisateur enregistré avec succès" });
        });
    } catch (error) {
        res.status(500).json({ error });
    }
};

// LOGIN
exports.login = (req, res) => {
    const { email, password } = req.body;

    const sql = "SELECT * FROM utilisateurs WHERE email = ?";
    db.query(sql, [email], async (err, results) => {
        if (err) return res.status(500).json({ error: err });
        if (results.length === 0) return res.status(404).json({ message: "Utilisateur introuvable" });

        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) return res.status(401).json({ message: "Mot de passe incorrect" });

        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });

        res.json({ message: "Connexion réussie", token });
    });
};
