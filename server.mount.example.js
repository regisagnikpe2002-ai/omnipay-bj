// À ajouter dans server.js APRÈS app.use(express.json()) et AVANT la route 404.
const connectorRoutes = require("../routes/connectors");
const omnipayPaymentRoutes = require("../routes/omnipayPayments");
const piSpiRoutes = require("../routes/piSpi");
const connectorErrors = require("../middleware/connectorErrors");

app.use("/api/connectors", connectorRoutes);
app.use("/api/omnipay/payments", omnipayPaymentRoutes);
app.use("/api/omnipay/pi-spi", piSpiRoutes);

// À placer après toutes les routes, mais avant app.listen().
app.use(connectorErrors);
