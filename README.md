# Integração Foody Delivery ↔ Cardápio Web

## O que faz
- Recebe webhooks do Foody Delivery e atualiza o status no Cardápio Web
- Faz polling dos pedidos do Cardápio Web a cada 30 segundos

## Como fazer o deploy no Railway

1. Crie uma conta em railway.app
2. Clique em "New Project" → "GitHub Repository"
3. Faça upload desses arquivos em um repositório GitHub
4. O Railway detecta Node.js automaticamente e faz o deploy
5. Copie a URL gerada pelo Railway
6. Cole essa URL + /webhook/foody no painel do Foody Delivery em "Gatilhos"

## Endpoints
- GET  /               → Health check
- POST /webhook/foody  → Recebe eventos do Foody

## Mapeamento de status
| Foody          | Cardápio Web       |
|----------------|--------------------|
| accepted       | confirm            |
| collecting     | readyForPickup     |
| delivering     | dispatch           |
| delivered      | delivered          |
| cancelled      | requestCancellation|
