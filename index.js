const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ========== PERSISTÊNCIA DO MAPA EM DISCO ==========
const MAP_FILE = path.join(process.cwd(), 'order_map.json'); // persiste entre restarts

function salvarMapa() {
  try {
    fs.writeFileSync(MAP_FILE, JSON.stringify({ orderMap, foodyUidMap }, null, 2));
  } catch(e) {
    console.error('❌ Erro ao salvar mapa:', e.message);
  }
}

function carregarMapa() {
  try {
    if (fs.existsSync(MAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
      Object.assign(orderMap, data.orderMap || {});
      Object.assign(foodyUidMap, data.foodyUidMap || {});
      console.log(`📂 Mapa carregado: ${Object.keys(orderMap).length} pedidos`);
    }
  } catch(e) {
    console.error('❌ Erro ao carregar mapa:', e.message);
  }
}

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
// foodyDisplayId → foodyUid          ex: "11348" → "6c55676f-..."
const foodyUidMap = {};
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

// ========== BUSCA PEDIDO NO CARDÁPIO WEB POR DISPLAY ID ==========
async function findCardapioOrderByDisplayId(displayId) {
  try {
    const token = await getCardapioToken();
    // Busca eventos recentes (até 100 eventos)
    const res = await axios.get(`${CARDAPIO_BASE_URL}/v1/events:polling`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!Array.isArray(res.data)) return null;

    // Para cada evento CREATED, busca os detalhes do pedido
    const createdEvents = res.data.filter(e => e.eventType === 'CREATED');
    for (const event of createdEvents) {
      try {
        const orderRes = await axios.get(`${CARDAPIO_BASE_URL}/v1/orders/${event.orderId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const order = orderRes.data;
        if (String(order.displayId) === String(displayId)) {
          // Encontrou! Salva no mapa
          orderMap[displayId] = event.orderId;
          salvarMapa();
          console.log(`🔧 Remapeado: Foody #${displayId} → Cardápio Web ${event.orderId}`);
          return event.orderId;
        }
      } catch {}
    }
  } catch(e) {
    console.error('❌ Erro ao buscar pedido no Cardápio Web:', e.message);
  }
  return null;
}

// ========== MAPEAMENTO DE STATUS ==========
const STATUS_MAP = {
  'open':       'confirm',
  'accepted':   'confirm',
  'ready':      'dispatch',      // para DELIVERY, pular readyForPickup e ir direto para dispatch
  'collecting': 'dispatch',
  'dispatched': 'dispatch',
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
    // Salva o uid para uso futuro
    foodyUidMap[foodyDisplayId] = uid;

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
            salvarMapa();
            console.log(`🗺️ Mapeado: Foody #${displayId} → Cardápio Web ${event.orderId}`);
          }
        } catch (e) {
          console.error('❌ Erro ao buscar pedido:', e?.response?.data || e.message);
        }
      }
    }

    // Confirma eventos — tenta um por um para não travar em eventos não confirmaveis
    let confirmados = 0;
    for (const event of res.data) {
      try {
        await axios.post(`${CARDAPIO_BASE_URL}/v1/events/acknowledgment`,
          [{ eventId: event.eventId }],
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        confirmados++;
      } catch(e) {
        console.log(`⚠️ Evento ${event.eventId} (${event.eventType}) não pode ser confirmado, ignorando.`);
      }
    }
    if (confirmados > 0) console.log(`✅ ${confirmados} evento(s) confirmados`);

  } catch (err) {
    if (err?.response?.status !== 204) {
      const msg = err?.response?.data?.title || err?.response?.data || err.message || '';
      console.error('❌ Erro no polling:', msg);
      // Se rate limited, espera 2 minutos antes de tentar de novo
      if (String(msg).toLowerCase().includes('retry')) {
        console.log('⏳ Rate limited — aguardando 2 minutos...');
        await new Promise(r => setTimeout(r, 120000));
      }
    }
  }
}

// ========== SYNC ENTREGADORES — busca todos pedidos do Foody ==========
async function syncCouriers() {
  console.log('\n🔄 Sincronizando entregadores...');
  let synced = 0;

  // Tenta buscar por UIDs já conhecidos
  for (const [displayId, uid] of Object.entries(foodyUidMap)) {
    try {
      const res = await axios.get(`${FOODY_API_URL}/orders/${uid}`, {
        headers: { Authorization: FOODY_API_TOKEN }
      });
      const foodyOrder = res.data;
      const cardapioId = orderMap[displayId];
      if (foodyOrder.courier && cardapioId) {
        courierMap[cardapioId] = {
          nome: foodyOrder.courier.courierName || '',
          telefone: foodyOrder.courier.courierPhone || '',
          tipo: foodyOrder.courier.courierType || '',
          taxaEntregador: foodyOrder.courierFee || 0,
          taxaCliente: foodyOrder.deliveryFee || 0,
          despatchDate: foodyOrder.despatchDate || null,
          foodyDisplayId: displayId,
          foodyUid: uid,
        };
        synced++;
        console.log(`  ✅ #${displayId} → ${foodyOrder.courier.courierName}`);
      }
    } catch(e) {
      console.log(`  ⚠️ Falha ao buscar #${displayId}: ${e.message}`);
    }
  }

  // Tenta buscar pedidos do Foody que ainda não temos uid (tenta lista por data)
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await axios.get(`${FOODY_API_URL}/orders`, {
      headers: { Authorization: FOODY_API_TOKEN },
      params: { date: today }
    });
    if (Array.isArray(res.data)) {
      for (const fo of res.data) {
        const displayId = fo.id;
        const uid = fo.uid;
        if (displayId && uid) {
          foodyUidMap[displayId] = uid;
          const cardapioId = orderMap[displayId];
          if (fo.courier && cardapioId) {
            courierMap[cardapioId] = {
              nome: fo.courier.courierName || '',
              telefone: fo.courier.courierPhone || '',
              tipo: fo.courier.courierType || '',
              taxaEntregador: fo.courierFee || 0,
              taxaCliente: fo.deliveryFee || 0,
              despatchDate: fo.despatchDate || null,
              foodyDisplayId: displayId,
              foodyUid: uid,
            };
            synced++;
          }
        }
      }
    }
  } catch(e) {
    console.log('  ℹ️ Endpoint de lista do Foody não disponível:', e.message);
  }

  console.log(`✅ Sync concluído: ${synced} entregador(es) atualizados`);
  return synced;
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

// Retorna mapa de uids do Foody
app.get('/foody-uids', (req, res) => res.json({ foodyUidMap }));

// Força sincronização dos entregadores
app.get('/sync', async (req, res) => {
  try {
    const synced = await syncCouriers();
    res.json({ ok: true, synced, courierMap });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Recebe uid do Foody manualmente para mapear
app.post('/mapear-uid', (req, res) => {
  const { foodyDisplayId, foodyUid } = req.body;
  if (!foodyDisplayId || !foodyUid) return res.status(400).json({ error: 'foodyDisplayId e foodyUid são obrigatórios' });
  foodyUidMap[foodyDisplayId] = foodyUid;
  console.log(`🗺️ UID mapeado manualmente: Foody #${foodyDisplayId} → ${foodyUid}`);
  res.json({ ok: true, foodyDisplayId, foodyUid });
});

// ========== START ==========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor na porta ${PORT}`);
  carregarMapa(); // restaura mapa salvo em disco
  pollCardapioOrders();
  setInterval(pollCardapioOrders, 60000); // 60 segundos para evitar rate limit
});
