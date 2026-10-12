"use strict";

function requireGatewayAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Authentification requise"
    });
  }

  if (req.user.kycStatus !== "verified") {
    return res.status(403).json({
      success: false,
      message: "KYC requis"
    });
  }

  next();
}

module.exports = {
  requireGatewayAccess
};
