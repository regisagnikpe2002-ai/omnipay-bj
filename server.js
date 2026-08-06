const express = require('express');
const app = express();
const authRoutes = require('./routes/auth');

app.use(express.json());

// Routes
app.use('/auth', authRoutes);

// Port Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OMNIPAY backend running on port ${PORT}`);
});
