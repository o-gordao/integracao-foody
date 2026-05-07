const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ========== CONFIGURAÇÕES ==========
const CARDAPIO_BASE_URL      = 'https://integracao.cardapioweb.com/api/open_delivery';
const CARDAPIO_CLIENT_ID     = 'ec2b9f5d-3313-49a7-ac0d-d688f49ab684';
const CARDAPIO_CLIENT_SECRET = '4a95ae0b-5bdb-40c2-bdb3-101bd22fe98b';

// ========== TOKEN ==========
let token = null, tokenExpiry = null;

async function getToken() {
  if (token && Date.now() < tokenExpiry) return token;
  const p = new URLSearchParams();
  p.append('grant_type', 'client_credentials');
  p.append('client_id', CARDAPIO_CLIENT_ID);
  p.append('client_secret', CARDAPIO_CLIENT_SECRET);
  const res = await axios.post(`${CARDAPIO_BASE_URL}/oauth/token`, p);
  token = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  console.log('✅ Token renovado');
  return token;
}

// ========== ARMAZENA EVENTOS ==========
const eventos = [];

// ========== POLLING ==========
async function polling() {
  try {
    const t = await getToken();
    const res = await axios.get(`${CARDAPIO_BASE_URL}/v1/events:polling`, {
      headers: { Authorization: `Bearer ${t}` }
    });

    if (res.status === 204 || !res.data?.length) {
      console.log(`[${new Date().toLocaleTimeString('pt-BR')}] 📭 Sem eventos novos`);
      return;
    }

    console.log(`\n[${new Date().toLocaleTimeString('pt-BR')}] 🔔 ${res.data.length} evento(s):`);

    for (const ev of res.data) {
      console.log(`  → ${ev.eventType} | Pedido: ${ev.orderId} | ${ev.createdAt}`);
      eventos.unshift({ recebidoEm: new Date().toISOString(), ...ev });
      if (eventos.length > 200) eventos.pop();
    }

    // Confirma eventos
    let ok = 0;
    for (const ev of res.data) {
      try {
        await axios.post(`${CARDAPIO_BASE_URL}/v1/events/acknowledgment`,
          [{ eventId: ev.eventId }],
          { headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } }
        );
        ok++;
      } catch(e) {}
    }
    if (ok > 0) console.log(`  ✅ ${ok} confirmado(s)`);

  } catch(err) {
    const msg = err?.response?.data?.title || err?.response?.data || err.message || '';
    console.error(`[${new Date().toLocaleTimeString('pt-BR')}] ❌ Erro: ${msg}`);
  }
}

// ========== ROTAS ==========
app.get('/', (req, res) => res.json({
  status: 'online',
  servico: 'Polling Cardápio Web',
  totalEventos: eventos.length,
  ultimoEvento: eventos[0] || null,
  timestamp: new Date().toISOString()
}));

app.get('/eventos', (req, res) => {
  const tipo = req.query.tipo;
  const limit = parseInt(req.query.limit) || 100;
  const filtrados = tipo ? eventos.filter(e => e.eventType === tipo) : eventos;
  res.json({ total: filtrados.length, eventos: filtrados.slice(0, limit) });
});

// ========== START ==========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor na porta ${PORT}`);
  console.log(`⏱️ Polling a cada 15 segundos`);
  polling();
  setInterval(polling, 15000);
});
