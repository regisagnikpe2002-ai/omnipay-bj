module.exports = (err, req, res, next) => {
  console.error('Erreur OMNIPAY:', err);
  res.status(500).json({ erreur: 'Erreur interne du serveur' });
};
