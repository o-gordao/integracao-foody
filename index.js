const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ========== CONFIGURAÇÕES ==========
const FOODY_BASE_URL = 'https://app.foodydelivery.com/opendelivery/api';
const FOODY_CLIENT_ID = '55f235c3cb394f40a187d37c18fe3541';
const FOODY_CLIENT_SECRET = 'c8bbe437e68b4516b0e0d031bb7fc882';

const CARDAPIO_BASE_URL = 'https://integracao.cardapioweb.com/api/open_delivery';
const CARDAPIO_CLIENT_ID = 'ec2b9f5d-3313-49a7-ac0d-d688f49ab684';
const CARDAPIO_CLIENT_SECRET = '4a95ae0b-5bdb-40c2-bdb3-101bd22fe98b';

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

// ========== MAPEAMENTO DE STATUS ==========
// Status do Foody → Status do Open Delivery para o Cardápio Web
const STATUS_MAP = {
  'accepted':    'confirm',
  'collecting':  'readyForPickup',
  'delivering':  'dispatch',
  'delivered':   'delivered',
  'cancelled':   'requestCancellation',
};

// ========== WEBHOOK — recebe eventos do Foody ==========
app.post('/webhook/foody', async (req, res) => {
  console.log('\n📦 Webhook recebido do Foody:', JSON.stringify(req.body, null, 2));

  // Responde 200 imediatamente para o Foody não desativar o webhook
  res.status(200).json({ received: true });

  try {
    const body = req.body;
    const orderId = body.reference || body.orderId || body.order_id;
    const foodyStatus = body.status || body.eventType;

    if (!orderId || !foodyStatus) {
      console.log('⚠️ Evento sem orderId ou status, ignorando.');
      return;
    }

    console.log(`🔄 Pedido ${orderId} → Status Foody: ${foodyStatus}`);

    const action = STATUS_MAP[foodyStatus?.toLowerCase()];
    if (!action) {
      console.log(`⚠️ Status "${foodyStatus}" sem mapeamento, ignorando.`);
      return;
    }

    const token = await getCardapioToken();
    const url = `${CARDAPIO_BASE_URL}/v1/orders/${orderId}/${action}`;

    let payload = {};
    if (action === 'dispatch' && body.courier) {
      payload = {
        deliveryTrackingInfo: {
          courier: {
            name: body.courier.name || 'Entregador',
            phone: body.courier.phone || '',
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

    console.log(`✅ Status "${action}" enviado para Cardápio Web — Pedido ${orderId}`);
  } catch (err) {
    console.error('❌ Erro ao processar webhook:', err?.response?.data || err.message);
  }
});

// ========== POLLING — busca pedidos do Cardápio Web e envia ao Foody ==========
async function pollCardapioOrders() {
  try {
    const token = await getCardapioToken();
    const res = await axios.get(`${CARDAPIO_BASE_URL}/v1/events:polling`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (res.status === 204 || !res.data?.length) return;

    console.log(`\n🔔 ${res.data.length} evento(s) do Cardápio Web`);

    for (const event of res.data) {
      if (event.eventType === 'CREATED') {
        console.log(`📋 Novo pedido: ${event.orderId}`);
      }
      console.log(`  → Evento: ${event.eventType} | Pedido: ${event.orderId}`);
    }

    // Confirma recebimento dos eventos
    const eventIds = res.data.map(e => e.eventId);
    await axios.post(`${CARDAPIO_BASE_URL}/v1/events/acknowledgment`,
      { eventIds },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log('✅ Eventos confirmados');
  } catch (err) {
    if (err?.response?.status !== 204) {
      console.error('❌ Erro no polling:', err?.response?.data || err.message);
    }
  }
}

// ========== HEALTH CHECK ==========
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Integração Foody ↔ Cardápio Web',
    timestamp: new Date().toISOString()
  });
});

// ========== INICIA SERVIDOR ==========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook/foody`);

  // Polling a cada 30 segundos
  pollCardapioOrders();
  setInterval(pollCardapioOrders, 30000);
});
