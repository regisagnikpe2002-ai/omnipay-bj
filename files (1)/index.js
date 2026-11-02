// Connecteurs mobile money. Chaque connecteur expose la meme interface :
//   collect({ phone, amount, reference }) -> { providerRef }   (demande de paiement au client)
//   disburse({ phone, amount, reference }) -> { providerRef }  (envoi d'argent vers le client)
// A completer avec la documentation officielle de chaque API (sandbox d'abord).

function notImplemented(name) {
  return async () => { throw new Error(`Connecteur ${name} a implementer (voir sa documentation API)`); };
}

const mock = {
  collect: async ({ reference }) => ({ providerRef: `mock_${reference}` }),
  disburse: async ({ reference }) => ({ providerRef: `mock_out_${reference}` }),
};

const connectors = {
  mock,
  mtn:     { collect: notImplemented('MTN'),     disburse: notImplemented('MTN') },
  moov:    { collect: notImplemented('Moov'),    disburse: notImplemented('Moov') },
  celtiis: { collect: notImplemented('Celtiis'), disburse: notImplemented('Celtiis') },
};

module.exports = {
  get(provider) {
    if (provider === 'mock' && process.env.NODE_ENV === 'production') return null;
    return connectors[provider] || null;
  },
};
