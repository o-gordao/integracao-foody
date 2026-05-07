const express = require('express');
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// Armazena eventos recebidos em memória
const eventos = [];

// ========== WEBHOOK DO CARDÁPIO WEB ==========
app.post('/webhook/cardapio', (req, res) => {
  const evento = {
    recebidoEm: new Date().toISOString(),
    ...req.body
  };

  eventos.unshift(evento); // mais recente primeiro
  if (eventos.length > 200) eventos.pop(); // guarda os últimos 200

  console.log('\n🛒 Cardápio Web →', evento.eventType, '| Pedido:', evento.orderId);
  console.log(JSON.stringify(evento, null, 2));

  res.status(200).json({ received: true });
});

// ========== VER EVENTOS RECEBIDOS ==========
app.get('/eventos', (req, res) => {
  res.json({ total: eventos.length, eventos });
});

// ========== HEALTH CHECK ==========
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    servico: 'Receptor Cardápio Web',
    totalEventos: eventos.length,
    ultimoEvento: eventos[0] || null,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor na porta ${PORT}`);
  console.log(`📡 Aguardando webhooks em /webhook/cardapio`);
});
