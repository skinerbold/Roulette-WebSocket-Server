# 🎰 Roulette WebSocket Server

WebSocket server para o **Roulette Analyzer** - Transmite dados de roletas em tempo real.

## 🚀 Deploy no Railway

Este servidor está configurado para rodar no [Railway.app](https://railway.app).

### Configuração

O servidor se conecta automaticamente à API de roletas em:
- **API WebSocket**: `ws://177.93.108.140:8777`
- **Porta**: Definida pela variável `PORT` do Railway (automática)

### Recursos

- ✅ Conexão com API real de 60+ roletas
- ✅ Transmissão de dados em tempo real
- ✅ Detecção automática de novas roletas
- ✅ Broadcast para múltiplos clientes
- ✅ Sem simulação de dados (100% real)

### Endpoints

- **WebSocket**: `wss://seu-app.railway.app`
- **Health Check**: Disponível na porta configurada

## 📡 Mensagens Suportadas

### Cliente → Servidor

```json
// Obter lista de roletas
{ "type": "get_roulettes" }

// Se inscrever em uma roleta
{ "type": "subscribe", "roulette": "Speed Roulette", "limit": 500 }

// Requisitar histórico
{ "type": "request_history", "limit": 500 }

// Ping (heartbeat)
{ "type": "ping" }
```

### Servidor → Cliente

```json
// Lista de roletas disponíveis
{ "type": "roulettes", "data": ["Speed Roulette", "Lightning Roulette", ...] }

// Histórico de números
{ "type": "history", "data": [5, 13, 34, 22, ...] }

// Novo número (tempo real)
{ "type": "result", "roulette": "Speed Roulette", "number": 17, "timestamp": 1234567890 }

// Confirmação de conexão
{ "type": "connected", "timestamp": 1234567890 }

// Pong (resposta ao ping)
{ "type": "pong", "timestamp": 1234567890 }
```

## 🔧 Desenvolvimento Local

```bash
npm install
npm start
```

Servidor iniciará em `ws://localhost:3000`

## 📊 Logs

O servidor emite logs detalhados:
- `🎰` Servidor iniciado
- `✅` Conectado à API
- `🎲` Novo número detectado
- `📤` Dados enviados ao cliente
- `🔌` Cliente conectado/desconectado

## ⚠️ Importante

- Não simula dados - apenas retransmite da API real
- Mantém histórico de até 500 números por roleta
- Suporta múltiplos clientes simultâneos
- Reconexão automática à API em caso de queda
