const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ========== CONFIGURAÇÕES ==========
const FOODY_BASE_URL = 'https://app.foodydelivery.com/opendelivery/api';
const FOODY_API_URL = 'https://app.foodydelivery.com/rest/1.2';
const FOODY_CLIENT_ID = '55f235c3cb394f40a187d37c18fe3541';
const FOODY_CLIENT_SECRET = 'c8bbe437e68b4516b0e0d031bb7fc882';
const FOODY_API_TOKEN = '94b8482d28c9443f83aebbf3bfb297ff'; // token API v1.2

const CARDAPIO_BASE_URL = 'https://integracao.cardapioweb.com/api/open_delivery';
const CARDAPIO_CLIENT_ID = 'ec2b9f5d-3313-49a7-ac0d-d688f49ab684';
const CARDAPIO_CLIENT_SECRET = '4a95ae0b-5bdb-40c2-bdb3-101bd22fe98b';

// ========== MAPA DE PEDIDOS ==========
// Guarda: foodyDisplayId (ex: "11348") → cardapioOrderId (ex: "214564677")
const orderMap = {};

// Cache de tokens
let foodyToken = null;
let foodyTokenExpiry = null;
let cardapioToken = null;
let cardapioTokenExpiry = null;

// ========== FUNÇÕES DE TOKEN ==========
async function getFoodyToken() {
  if (foodyToken && foodyTokenExpiry && Date.now() < foodyTokenExpiry) return foodyToken;
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', FOODY_CLIENT_ID);
  params.append('client_secret', FOODY_CLIENT_SECRET);
  const res = await axios.post(`${FOODY_BASE_URL}/oauth/token`, params);
  foodyToken = res.data.access_token;
  foodyTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  console.log('✅ Token Foody renovado');
  return foodyToken;
}

async function getCardapioToken() {
  if (cardapioToken && cardapioTokenExpiry && Date.now() < cardapioTokenExpiry) return cardapioToken;
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', CARDAPIO_CLIENT_ID);
  params.append('client_secret', CARDAPIO_CLIENT_SECRET);
  const res = await axios.post(`${CARDAPIO_BASE_URL}/oauth/token`, params);
  cardapioToken = res.data.access_token;
  cardapioTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  console.log('✅ Token Cardápio Web renovado');
  return cardapioToken;
}

// ========== BUSCA PEDIDO NO FOODY PELA API v1.2 ==========
async function getFoodyOrder(uid) {
  const res = await axios.get(`${FOODY_API_URL}/orders/${uid}`, {
    headers: { Authorization: FOODY_API_TOKEN }
  });
  return res.data;
}

// ========== MAPEAMENTO DE STATUS ==========
const STATUS_MAP = {
  'accepted':   'confirm',
  'collecting': 'readyForPickup',
  'ongoing':    'dispatch',
  'delivering': 'dispatch',
  'dispatched': 'dispatch',
  'delivered':  'delivered',
  'cancelled':  'requestCancellation',
  'canceled':   'requestCancellation',
};

// ========== WEBHOOK — recebe eventos do Foody ==========
app.post('/webhook/foody', async (req, res) => {
  console.log('\n📦 Webhook recebido do Foody:', JSON.stringify(req.body, null, 2));

  // Responde 200 imediatamente
  res.status(200).json({ received: true });

  try {
    const body = req.body;
    const uid = body.uid;
    const foodyStatus = (body.status || '').toLowerCase();

    if (!uid) { console.log('⚠️ Webhook sem uid, ignorando.'); return; }
    if (!foodyStatus) { console.log('⚠️ Webhook sem status, ignorando.'); return; }

    const action = STATUS_MAP[foodyStatus];
    if (!action) {
      console.log(`⚠️ Status "${foodyStatus}" sem mapeamento, ignorando.`);
      return;
    }

    // Busca pedido no Foody para pegar o displayId (ex: "11348")
    console.log(`🔍 Buscando pedido no Foody: ${uid}`);
    const foodyOrder = await getFoodyOrder(uid);
    const foodyDisplayId = foodyOrder.id;
    console.log(`📋 Foody displayId: ${foodyDisplayId}`);

    // Busca o ID do Cardápio Web no mapa
    const cardapioOrderId = orderMap[foodyDisplayId];
    if (!cardapioOrderId) {
      console.log(`⚠️ Pedido "${foodyDisplayId}" não mapeado. Mapa atual: ${JSON.stringify(orderMap)}`);
      return;
    }

    console.log(`🔄 Foody #${foodyDisplayId} → Cardápio Web ${cardapioOrderId} → "${action}"`);

    const token = await getCardapioToken();
    const url = `${CARDAPIO_BASE_URL}/v1/orders/${cardapioOrderId}/${action}`;

    let payload = {};
    if (action === 'dispatch') {
      payload = {
        deliveryTrackingInfo: {
          courier: {
            name: foodyOrder.courier?.courierName || 'Entregador Foody',
            phone: foodyOrder.courier?.courierPhone || '',
          }
        }
      };
    }
    if (action === 'requestCancellation') {
      payload = { cancellationCode: 'RESTAURANT_CANCELLED', description: 'Cancelado via Foody Delivery' };
    }

    await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    console.log(`✅ Ação "${action}" enviada para Cardápio Web — Pedido ${cardapioOrderId}`);

  } catch (err) {
    console.error('❌ Erro ao processar webhook:', err?.response?.data || err.message);
  }
});

// ========== POLLING — busca eventos do Cardápio Web e mapeia pedidos ==========
async function pollCardapioOrders() {
  try {
    const token = await getCardapioToken();
    const res = await axios.get(`${CARDAPIO_BASE_URL}/v1/events:polling`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (res.status === 204 || !res.data?.length) return;

    console.log(`\n🔔 ${res.data.length} evento(s) do Cardápio Web`);

    for (const event of res.data) {
      console.log(`  → Evento: ${event.eventType} | Pedido: ${event.orderId}`);

      // Quando chega pedido novo, busca detalhes para mapear com o Foody
      if (event.eventType === 'CREATED' && event.orderId) {
        try {
          const orderRes = await axios.get(`${CARDAPIO_BASE_URL}/v1/orders/${event.orderId}`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          const order = orderRes.data;
          const displayId = order.displayId; // ex: "11348"
          if (displayId) {
            orderMap[displayId] = event.orderId;
            console.log(`🗺️ Mapeado: Foody #${displayId} → Cardápio Web ${event.orderId}`);
          }
        } catch (e) {
          console.error('❌ Erro ao buscar detalhes do pedido:', e?.response?.data || e.message);
        }
      }
    }

    // Confirma recebimento — array direto
    const eventIds = res.data.map(e => e.eventId);
    await axios.post(
      `${CARDAPIO_BASE_URL}/v1/events/acknowledgment`,
      eventIds,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log('✅ Eventos confirmados');

  } catch (err) {
    if (err?.response?.status !== 204) {
      console.error('❌ Erro no polling:', err?.response?.data || err.message);
    }
  }
}

// ========== VER MAPA DE PEDIDOS ==========
app.get('/mapa', (req, res) => {
  res.json({ orderMap, total: Object.keys(orderMap).length });
});

// ========== HEALTH CHECK ==========
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Integração Foody ↔ Cardápio Web',
    timestamp: new Date().toISOString(),
    pedidosMapeados: Object.keys(orderMap).length
  });
});

// ========== INICIA SERVIDOR ==========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 Webhook URL: /webhook/foody`);
  pollCardapioOrders();
  setInterval(pollCardapioOrders, 30000);
});
