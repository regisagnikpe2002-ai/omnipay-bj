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
