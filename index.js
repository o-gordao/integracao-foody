const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ========== CONFIGURAÇÕES ==========
const CARDAPIO_BASE_URL      = 'https://integracao.cardapioweb.com/api/open_delivery';
const CARDAPIO_CLIENT_ID     = 'ec2b9f5d-3313-49a7-ac0d-d688f49ab684';
const CARDAPIO_CLIENT_SECRET = '4a95ae0b-5bdb-40c2-bdb3-101bd22fe98b';

// ========== CONFIGURAÇÕES FOODY ==========
const FOODY_BASE_URL  = 'https://app.foodydelivery.com/opendelivery/api';
const FOODY_API_URL   = 'https://app.foodydelivery.com/rest/1.2';
const FOODY_CLIENT_ID     = '55f235c3cb394f40a187d37c18fe3541';
const FOODY_CLIENT_SECRET = 'c8bbe437e68b4516b0e0d031bb7fc882';
const FOODY_API_TOKEN     = '94b8482d28c9443f83aebbf3bfb297ff';

// ========== MAPAS ==========
const fs = require('fs');
const path = require('path');
const MAP_FILE = path.join(process.cwd(), 'order_map.json');
const orderMap    = {}; // foodyDisplayId → cardapioOrderId
const foodyUidMap = {}; // foodyDisplayId → foodyUid
const courierMap  = {}; // cardapioOrderId → entregador

function salvarMapa() {
  try { fs.writeFileSync(MAP_FILE, JSON.stringify({ orderMap, foodyUidMap, courierMap }, null, 2)); } catch(e) {}
}
function carregarMapa() {
  try {
    if (fs.existsSync(MAP_FILE)) {
      const d = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
      Object.assign(orderMap, d.orderMap || {});
      Object.assign(foodyUidMap, d.foodyUidMap || {});
      Object.assign(courierMap, d.courierMap || {});
      console.log(`📂 Mapa carregado: ${Object.keys(orderMap).length} pedidos | ${Object.keys(courierMap).length} entregadores`);
    }
  } catch(e) {}
}

// ========== STATUS MAP ==========
const STATUS_MAP = {
  'open': 'confirm', 'accepted': 'confirm',
  'ready': 'dispatch', 'collecting': 'dispatch',
  'dispatched': 'dispatch', 'ongoing': 'dispatch', 'delivering': 'dispatch',
  'delivered': 'delivered', 'closed': 'delivered',
  'cancelled': 'requestCancellation', 'canceled': 'requestCancellation',
};

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

// ========== TOKEN FOODY ==========
let foodyToken = null, foodyTokenExpiry = null;
async function getFoodyToken() {
  if (foodyToken && Date.now() < foodyTokenExpiry) return foodyToken;
  const p = new URLSearchParams();
  p.append('grant_type', 'client_credentials');
  p.append('client_id', FOODY_CLIENT_ID);
  p.append('client_secret', FOODY_CLIENT_SECRET);
  const res = await axios.post(`${FOODY_BASE_URL}/oauth/token`, p);
  foodyToken = res.data.access_token;
  foodyTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  console.log('✅ Token Foody renovado');
  return foodyToken;
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

      // Mapeia pedidos novos
      if (ev.eventType === 'CREATED' && ev.orderId && !Object.values(orderMap).includes(ev.orderId)) {
        try {
          const orderRes = await axios.get(`${CARDAPIO_BASE_URL}/v1/orders/${ev.orderId}`, {
            headers: { Authorization: `Bearer ${t}` }
          });
          const displayId = String(orderRes.data.displayId || '');
          if (displayId) {
            orderMap[displayId] = ev.orderId;
            salvarMapa();
            console.log(`  🗺️ Mapeado: Foody #${displayId} → Cardápio Web ${ev.orderId}`);
          }
        } catch(e) {}
      }
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
    if (String(msg).toLowerCase().includes('retry')) {
      console.log('⏳ Rate limit — aguardando 5 minutos...');
      await new Promise(r => setTimeout(r, 300000));
    }
  }
}

// ========== WEBHOOK FOODY ==========
app.post('/webhook/foody', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const { uid, status, event } = req.body;
    if (!uid) return;
    console.log(`\n📦 Foody: event=${event} status=${status} uid=${uid}`);

    // Busca pedido na API v1.2
    const foodyRes = await axios.get(`${FOODY_API_URL}/orders/${uid}`, {
      headers: { Authorization: FOODY_API_TOKEN }
    });
    const foodyOrder = foodyRes.data;
    const foodyDisplayId = foodyOrder.id;
    foodyUidMap[foodyDisplayId] = uid;
    salvarMapa();

    // Salva entregador
    const cardapioId = orderMap[foodyDisplayId];
    if (foodyOrder.courier && cardapioId) {
      courierMap[cardapioId] = {
        nome: foodyOrder.courier.courierName || '',
        telefone: foodyOrder.courier.courierPhone || '',
        taxaEntregador: foodyOrder.courierFee || 0,
        taxaCliente: foodyOrder.deliveryFee || 0,
      };
    }

    // Pedido novo — só registra
    if (event === 'order_created' || (status||'').toLowerCase() === 'open') {
      console.log(`🆕 Foody #${foodyDisplayId} criado — aguardando mapeamento`);
      return;
    }

    // Atualização de status
    const foodyStatus = (status || '').toLowerCase();
    const action = STATUS_MAP[foodyStatus];
    if (!action) { console.log(`⚠️ Status "${foodyStatus}" sem mapeamento`); return; }

    const finalId = orderMap[foodyDisplayId];
    if (!finalId) { console.log(`⚠️ Foody #${foodyDisplayId} não mapeado ainda`); return; }

    console.log(`🔄 Foody #${foodyDisplayId} → Cardápio Web ${finalId} → "${action}"`);
    const t = await getToken();
    let payload = {};
    if (action === 'dispatch') payload = { deliveryTrackingInfo: { courier: {
      name: foodyOrder.courier?.courierName || 'Entregador Foody',
      phone: foodyOrder.courier?.courierPhone || '',
    }}};
    if (action === 'requestCancellation') payload = { cancellationCode: 'RESTAURANT_CANCELLED', description: 'Cancelado via Foody' };

    await axios.post(`${CARDAPIO_BASE_URL}/v1/orders/${finalId}/${action}`, payload, {
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
    });
    console.log(`✅ Ação "${action}" enviada — Pedido ${finalId}`);

  } catch(err) {
    const s = err?.response?.status;
    if (s === 422) { console.log(`ℹ️ Pedido já em status final`); }
    else { console.error('❌ Erro webhook Foody:', err?.response?.data || err.message); }
  }
});

// ========== ROTAS ==========
app.get('/', (req, res) => res.json({
  status: 'online',
  servico: 'Integração Foody ↔ Cardápio Web',
  totalEventos: eventos.length,
  pedidosMapeados: Object.keys(orderMap).length,
  ultimoEvento: eventos[0] || null,
  timestamp: new Date().toISOString()
}));

app.get('/mapa', (req, res) => res.json({ orderMap, total: Object.keys(orderMap).length }));
app.get('/entregadores', (req, res) => res.json({ courierMap }));
app.get('/foody-uids', (req, res) => res.json({ foodyUidMap }));

app.get('/foody/order/:uid', async (req, res) => {
  try {
    const r = await axios.get(`${FOODY_API_URL}/orders/${req.params.uid}`, {
      headers: { Authorization: FOODY_API_TOKEN }
    });
    res.json(r.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
  console.log(`⏱️ Polling a cada 1 minuto`);
  carregarMapa();
  polling();
  setInterval(polling, 60000); // 1 minuto
});
