module.exports = (req, res) => {
  res.status(200).json({
    success: true,
    status: "OmniPay API is running",
    timestamp: new Date().toISOString()
  });
};
