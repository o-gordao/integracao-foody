const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ========== CORS (permite acesso do painel HTML local) ==========
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// ========== CONFIGURAÇÕES ==========
const FOODY_BASE_URL = 'https://app.foodydelivery.com/opendelivery/api';
const FOODY_API_URL  = 'https://app.foodydelivery.com/rest/1.2';
const FOODY_CLIENT_ID     = '55f235c3cb394f40a187d37c18fe3541';
const FOODY_CLIENT_SECRET = 'c8bbe437e68b4516b0e0d031bb7fc882';
const FOODY_API_TOKEN     = '94b8482d28c9443f83aebbf3bfb297ff';

const CARDAPIO_BASE_URL    = 'https://integracao.cardapioweb.com/api/open_delivery';
const CARDAPIO_CLIENT_ID   = 'ec2b9f5d-3313-49a7-ac0d-d688f49ab684';
const CARDAPIO_CLIENT_SECRET = '4a95ae0b-5bdb-40c2-bdb3-101bd22fe98b';

// ========== MAPAS ==========
// foodyDisplayId → cardapioOrderId   ex: "11348" → "214564677"
const orderMap = {};
// cardapioOrderId → dados do entregador do Foody
const courierMap = {};

let foodyToken = null, foodyTokenExpiry = null;
let cardapioToken = null, cardapioTokenExpiry = null;

// ========== TOKENS ==========
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

async function getCardapioToken() {
  if (cardapioToken && Date.now() < cardapioTokenExpiry) return cardapioToken;
  const p = new URLSearchParams();
  p.append('grant_type', 'client_credentials');
  p.append('client_id', CARDAPIO_CLIENT_ID);
  p.append('client_secret', CARDAPIO_CLIENT_SECRET);
  const res = await axios.post(`${CARDAPIO_BASE_URL}/oauth/token`, p);
  cardapioToken = res.data.access_token;
  cardapioTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  console.log('✅ Token Cardápio Web renovado');
  return cardapioToken;
}

// ========== MAPEAMENTO DE STATUS ==========
const STATUS_MAP = {
  'open':       'confirm',
  'accepted':   'confirm',
  'ready':      'readyForPickup',
  'collecting': 'readyForPickup',
  'dispatched': 'readyForPickup',
  'ongoing':    'dispatch',
  'delivering': 'dispatch',
  'delivered':  'delivered',
  'closed':     'delivered',
  'cancelled':  'requestCancellation',
  'canceled':   'requestCancellation',
};

// ========== WEBHOOK — recebe eventos do Foody ==========
app.post('/webhook/foody', async (req, res) => {
  console.log('\n📦 Webhook Foody:', JSON.stringify(req.body, null, 2));
  res.status(200).json({ received: true });

  try {
    const { uid, status } = req.body;
    if (!uid) { console.log('⚠️ Sem uid.'); return; }

    const foodyStatus = (status || '').toLowerCase();
    const action = STATUS_MAP[foodyStatus];
    if (!action) { console.log(`⚠️ Status "${foodyStatus}" sem mapeamento.`); return; }

    // Busca pedido no Foody pela API v1.2
    const foodyRes = await axios.get(`${FOODY_API_URL}/orders/${uid}`, {
      headers: { Authorization: FOODY_API_TOKEN }
    });
    const foodyOrder = foodyRes.data;
    const foodyDisplayId = foodyOrder.id;

    // Salva dados do entregador no courierMap
    const cardapioOrderId = orderMap[foodyDisplayId];
    if (foodyOrder.courier && cardapioOrderId) {
      courierMap[cardapioOrderId] = {
        nome: foodyOrder.courier.courierName || '',
        telefone: foodyOrder.courier.courierPhone || '',
        tipo: foodyOrder.courier.courierType || '',
        taxaEntregador: foodyOrder.courierFee || 0,
        taxaCliente: foodyOrder.deliveryFee || 0,
        despatchDate: foodyOrder.despatchDate || null,
        deliveredDate: foodyOrder.deliveredDate || null,
        foodyDisplayId,
        foodyUid: uid,
      };
      console.log(`🚴 Entregador salvo: ${foodyOrder.courier.courierName} → Pedido ${cardapioOrderId}`);
    }

    if (!cardapioOrderId) { console.log(`⚠️ Pedido "${foodyDisplayId}" não mapeado.`); return; }

    console.log(`🔄 Foody #${foodyDisplayId} → Cardápio Web ${cardapioOrderId} → "${action}"`);

    const token = await getCardapioToken();
    let payload = {};
    if (action === 'dispatch') {
      payload = { deliveryTrackingInfo: { courier: {
        name: foodyOrder.courier?.courierName || 'Entregador Foody',
        phone: foodyOrder.courier?.courierPhone || '',
      }}};
    }
    if (action === 'requestCancellation') {
      payload = { cancellationCode: 'RESTAURANT_CANCELLED', description: 'Cancelado via Foody Delivery' };
    }

    await axios.post(`${CARDAPIO_BASE_URL}/v1/orders/${cardapioOrderId}/${action}`, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    console.log(`✅ Ação "${action}" enviada — Pedido ${cardapioOrderId}`);

  } catch (err) {
    console.error('❌ Erro webhook:', err?.response?.data || err.message);
  }
});

// ========== POLLING — busca eventos do Cardápio Web ==========
async function pollCardapioOrders() {
  try {
    const token = await getCardapioToken();
    const res = await axios.get(`${CARDAPIO_BASE_URL}/v1/events:polling`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (res.status === 204 || !res.data?.length) return;
    console.log(`\n🔔 ${res.data.length} evento(s) do Cardápio Web`);

    for (const event of res.data) {
      console.log(`  → ${event.eventType} | Pedido: ${event.orderId}`);
      if (event.eventType === 'CREATED' && event.orderId) {
        try {
          const orderRes = await axios.get(`${CARDAPIO_BASE_URL}/v1/orders/${event.orderId}`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          const displayId = orderRes.data.displayId;
          if (displayId) {
            orderMap[displayId] = event.orderId;
            console.log(`🗺️ Mapeado: Foody #${displayId} → Cardápio Web ${event.orderId}`);
          }
        } catch (e) {
          console.error('❌ Erro ao buscar pedido:', e?.response?.data || e.message);
        }
      }
    }

    // Confirma eventos
    const eventIds = res.data.map(e => ({ eventId: e.eventId }));
    await axios.post(`${CARDAPIO_BASE_URL}/v1/events/acknowledgment`, eventIds, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    console.log('✅ Eventos confirmados');

  } catch (err) {
    if (err?.response?.status !== 204) {
      console.error('❌ Erro no polling:', err?.response?.data || err.message);
    }
  }
}

// ========== ROTAS ==========
app.get('/', (req, res) => res.json({
  status: 'online',
  service: 'Integração Foody ↔ Cardápio Web',
  timestamp: new Date().toISOString(),
  pedidosMapeados: Object.keys(orderMap).length
}));

// Retorna mapa de pedidos
app.get('/mapa', (req, res) => res.json({ orderMap, total: Object.keys(orderMap).length }));

// Retorna dados dos entregadores por pedido do Cardápio Web
app.get('/entregadores', (req, res) => res.json({ courierMap }));

// Retorna dados de um pedido específico com entregador
app.get('/pedido/:cardapioId', (req, res) => {
  const id = req.params.cardapioId;
  const courier = courierMap[id] || null;
  res.json({ cardapioOrderId: id, courier });
});

// ========== START ==========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor na porta ${PORT}`);
  pollCardapioOrders();
  setInterval(pollCardapioOrders, 30000);
});
