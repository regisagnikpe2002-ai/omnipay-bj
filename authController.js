// Route protégée : renvoie les infos de l'utilisateur connecté
async function me(req, res) {
    try {
        const user = await findUserByEmail(req.user.email);

        if (!user) {
            return res.status(404).json({ message: 'Utilisateur introuvable' });
        }

        res.json({
            id: user.id,
            email: user.email,
            nom: user.nom,
            role: user.role
        });
    } catch (error) {
        console.error('Erreur me:', error);
        res.status(500).json({ message: 'Erreur serveur' });
    }
}

module.exports = { register, login, me };
