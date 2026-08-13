const express = require('express');
const app = express();
const cors = require('cors');

app.use(cors());
app.use(express.json());

const authRoutes = require('./routes/auth');

app.use('/auth', authRoutes);

app.get('/', (req, res) => {
    res.send('OMNIPAY API fonctionne ✓');
});

// Render impose son propre port
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`OMNIPAY backend running on port ${PORT}`);
});
