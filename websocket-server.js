// Servidor WebSocket para Roleta ao Vivo
// Conecta-se ao WebSocket real em ws://177.93.108.140:8777

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000; const wss = new WebSocket.Server({ port: PORT });

console.log('🎰 Servidor WebSocket de Roleta rodando em port: ${PORT}');

// ============================================
// CARREGAR CONFIGURAÇÃO DA API
// ============================================

// Configuração da API
let API_CONFIG;
const configPath = path.join(__dirname, 'api-config.js');

if (fs.existsSync(configPath)) {
  console.log('📋 Carregando configuração de api-config.js');
  API_CONFIG = require('./api-config.js');
  
  if (!API_CONFIG.enabled) {
    console.error('❌ API está desabilitada no arquivo de configuração');
    console.error('💡 Configure enabled: true em api-config.js');
    process.exit(1);
  }
} else {
  console.error('❌ ERRO: api-config.js não encontrado!');
  console.error('💡 Copie api-config.example.js para api-config.js e configure seus dados da API');
  console.error('');
  console.error('Passos:');
  console.error('1. Copy-Item api-config.example.js api-config.js');
  console.error('2. Edite api-config.js com suas credenciais');
  console.error('3. Configure enabled: true');
  console.error('4. Reinicie o servidor');
  process.exit(1);
}

// Dados das roletas (serão carregados da API)
let availableRoulettes = [];
let rouletteHistory = {};

// Conexão com WebSocket da API real
let apiWebSocket = null;
let reconnectAttempts = 0;

// ============================================
// CONEXÃO COM WEBSOCKET DA API REAL
// ============================================

function connectToAPIWebSocket() {
  const wsUrl = API_CONFIG.websocketUrl || 'ws://177.93.108.140:8777';
  
  console.log(`🔌 Conectando ao WebSocket da API: ${wsUrl}`);
  
  try {
    apiWebSocket = new WebSocket(wsUrl);
    
    apiWebSocket.on('open', () => {
      console.log('✅ Conectado ao WebSocket da API!');
      reconnectAttempts = 0;
      
      // Solicitar lista de roletas ao conectar
      // Ajuste a mensagem de acordo com o protocolo da API
      try {
        apiWebSocket.send(JSON.stringify({ 
          type: 'get_roulettes',
          action: 'list_tables'
        }));
      } catch (error) {
        console.error('Erro ao solicitar roletas:', error);
      }
    });
    
    apiWebSocket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (API_CONFIG.verbose) {
          console.log('📨 Mensagem da API:', message);
        }
        
        // Verificar se é uma mensagem de roleta (tem game, game_type e results)
        if (message.game && message.game_type === 'roleta' && Array.isArray(message.results)) {
          const rouletteName = message.game;
          
          // Adicionar roleta à lista se ainda não existe
          if (!availableRoulettes.includes(rouletteName)) {
            availableRoulettes.push(rouletteName);
            console.log(`✅ Nova roleta descoberta: ${rouletteName}`);
            
            // Enviar lista atualizada para todos os clientes
            broadcastToClients({
              type: 'roulettes',
              data: availableRoulettes
            });
          }
          
          // Converter results (strings) para números
          const history = message.results.map(n => {
            if (n === '00') return 0; // Roleta americana
            const num = parseInt(n);
            return isNaN(num) || num < 0 || num > 36 ? 0 : num;
          });
          
          // Verificar se há novo número (comparar primeiro número do histórico)
          const oldHistory = rouletteHistory[rouletteName] || [];
          const newNumber = history[0];
          const isNewNumber = oldHistory.length === 0 || oldHistory[0] !== newNumber;
          
          // Atualizar histórico completo
          rouletteHistory[rouletteName] = history;
          
          // Se é novo número, notificar clientes
          if (isNewNumber && newNumber !== undefined) {
            console.log(`🎲 Novo número: ${newNumber} na ${rouletteName}`);
            
            broadcastToClients({
              type: 'result',
              roulette: rouletteName,
              number: newNumber,
              timestamp: Date.now()
            });
          }
        }
        
      } catch (error) {
        // Mensagem não é JSON, ignorar
        if (API_CONFIG.verbose) {
          console.log('📨 Mensagem da API (não-JSON):', data.toString().substring(0, 100));
        }
      }
    });
    
    apiWebSocket.on('error', (error) => {
      console.error('❌ Erro no WebSocket da API:', error.message);
    });
    
    apiWebSocket.on('close', (code, reason) => {
      console.log(`⚠️ WebSocket da API fechado. Código: ${code}, Motivo: ${reason}`);
      
      // Reconexão automática
      if (API_CONFIG.reconnect && reconnectAttempts < API_CONFIG.maxReconnectAttempts) {
        reconnectAttempts++;
        console.log(`🔄 Tentando reconectar (${reconnectAttempts}/${API_CONFIG.maxReconnectAttempts})...`);
        setTimeout(connectToAPIWebSocket, API_CONFIG.reconnectInterval);
      } else {
        console.error('❌ Máximo de tentativas de reconexão atingido');
        process.exit(1);
      }
    });
    
  } catch (error) {
    console.error('❌ Erro ao criar conexão WebSocket:', error.message);
    process.exit(1);
  }
}

// Função para broadcast para todos os clientes conectados
function broadcastToClients(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ============================================
// FUNÇÕES DE API REAL (FALLBACK HTTP)
// ============================================

// Função auxiliar para fazer requisições HTTP/HTTPS
function fetchFromAPI(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { ...API_CONFIG.headers, ...headers }
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (err) {
          reject(new Error('Resposta inválida da API'));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Timeout ao conectar à API'));
    });

    req.end();
  });
}

// Buscar lista de roletas da API
async function fetchRoulettesFromAPI() {
  try {
    const url = API_CONFIG.baseUrl + API_CONFIG.endpoints.roulettes;
    if (API_CONFIG.verbose) console.log(`📡 Buscando roletas da API: ${url}`);
    
    const response = await fetchFromAPI(url);
    
    // Usar função de parse configurável
    const roulettes = API_CONFIG.parseRoulettesResponse(response);
    
    if (Array.isArray(roulettes) && roulettes.length > 0) {
      console.log(`✅ ${roulettes.length} roletas carregadas da API`);
      return roulettes.map(r => typeof r === 'string' ? r : r.name || r.id || r.toString());
    }
    
    throw new Error('API não retornou roletas válidas');
  } catch (error) {
    console.error('❌ Erro ao buscar roletas da API:', error.message);
    throw error;
  }
}

// Buscar histórico de uma roleta da API
async function fetchHistoryFromAPI(rouletteName, limit = 500) {
  try {
    let url = API_CONFIG.baseUrl + API_CONFIG.endpoints.history.replace('{id}', encodeURIComponent(rouletteName));
    
    // Se a URL já não tiver o parâmetro limit, adicionar
    if (!url.includes('limit=')) {
      url += (url.includes('?') ? '&' : '?') + `limit=${limit}`;
    }
    
    if (API_CONFIG.verbose) console.log(`📡 Buscando histórico da API: ${url}`);
    
    const response = await fetchFromAPI(url);
    
    // Usar função de parse configurável
    const history = API_CONFIG.parseHistoryResponse(response);
    
    if (Array.isArray(history) && history.length > 0) {
      console.log(`✅ ${history.length} números carregados da API para ${rouletteName}`);
      // Garantir que são números e estão no range 0-36
      return history.map(n => {
        const num = typeof n === 'number' ? n : parseInt(n);
        return isNaN(num) || num < 0 || num > 36 ? 0 : num;
      }).slice(0, limit);
    }
    
    throw new Error('API não retornou histórico válido');
  } catch (error) {
    console.error(`❌ Erro ao buscar histórico da API para ${rouletteName}:`, error.message);
    throw error;
  }
}

// Inicializar dados da API ao iniciar servidor
async function initializeFromAPI() {
  console.log('🔄 Inicializando conexão com WebSocket da API...');
  
  try {
    // Conectar ao WebSocket da API real
    connectToAPIWebSocket();
    
    // Aguardar um pouco para o WebSocket conectar e receber dados iniciais
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Se não recebeu roletas pelo WebSocket, tentar via HTTP (se baseUrl configurado)
    if (availableRoulettes.length === 0 && API_CONFIG.baseUrl) {
      console.log('⚠️ Tentando buscar roletas via HTTP como fallback...');
      const apiRoulettes = await fetchRoulettesFromAPI();
      
      if (!apiRoulettes || apiRoulettes.length === 0) {
        throw new Error('Nenhuma roleta retornada pela API');
      }
      
      availableRoulettes = apiRoulettes;
      console.log(`✅ ${availableRoulettes.length} roletas carregadas via HTTP`);
      
      // Buscar histórico de cada roleta
      for (const roulette of availableRoulettes) {
        const history = await fetchHistoryFromAPI(roulette, 500);
        rouletteHistory[roulette] = history;
      }
    }
    
    console.log('✅ Inicialização completa - Conectado à API real');
  } catch (error) {
    console.error('❌ Erro na inicialização:', error.message);
    console.error('');
    console.error('Continuando com conexão WebSocket...');
    console.error('Aguardando dados do WebSocket da API real.');
  }
}

// ============================================
// FUNÇÕES AUXILIARES
// ============================================

// Função para gerar um novo número da API (quando houver atualização em tempo real)
async function fetchLatestNumberFromAPI(rouletteName) {
  try {
    // Esta função pode ser expandida para usar WebSocket ou polling da API
    // Por enquanto, busca o histórico mais recente
    const history = await fetchHistoryFromAPI(rouletteName, 1);
    if (history && history.length > 0) {
      return history[0];
    }
    throw new Error('Nenhum número retornado');
  } catch (error) {
    console.error(`❌ Erro ao buscar número mais recente para ${rouletteName}:`, error.message);
    throw error;
  }
}

// ============================================
// INICIALIZAÇÃO
// ============================================

// Inicializar dados da API antes de aceitar conexões
initializeFromAPI().then(() => {
  console.log('🚀 Servidor pronto para aceitar conexões');
});

// ============================================
// WEBSOCKET SERVER
// ============================================

wss.on('connection', (ws) => {
  console.log('✅ Novo cliente conectado');
  
  let currentRoulette = null;

  // Enviar confirmação de conexão
  ws.send(JSON.stringify({
    type: 'connected',
    timestamp: Date.now()
  }));

  // Enviar lista de roletas automaticamente
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'roulettes',
      data: availableRoulettes
    }));
    console.log('📤 Lista de roletas enviada');
  }, 100);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('📨 Mensagem recebida:', data);

      switch (data.type) {
        case 'get_roulettes':
          // Enviar lista de roletas disponíveis
          ws.send(JSON.stringify({
            type: 'roulettes',
            data: availableRoulettes
          }));
          console.log('📤 Lista de roletas enviada');
          break;

        case 'subscribe':
          // Cliente se inscreveu em uma roleta
          currentRoulette = data.roulette;
          const limit = data.limit || 500;
          
          console.log(`📌 Cliente inscrito na ${currentRoulette}`);
          
          // Enviar histórico da roleta
          if (rouletteHistory[currentRoulette]) {
            ws.send(JSON.stringify({
              type: 'history',
              data: rouletteHistory[currentRoulette].slice(0, limit)
            }));
            console.log(`📤 Histórico enviado: ${limit} números da ${currentRoulette}`);
          } else {
            // Se não tiver histórico ainda, enviar array vazio
            ws.send(JSON.stringify({
              type: 'history',
              data: []
            }));
            console.log(`⚠️ Sem histórico ainda para ${currentRoulette}, aguardando dados da API`);
          }
          break;

        case 'request_history':
          // Enviar histórico da roleta atual ou da primeira disponível
          const roulette = currentRoulette || availableRoulettes[0];
          const historyLimit = data.limit || 500;
          
          if (rouletteHistory[roulette]) {
            ws.send(JSON.stringify({
              type: 'history',
              data: rouletteHistory[roulette].slice(0, historyLimit)
            }));
            console.log(`📤 Histórico enviado: ${historyLimit} números`);
          }
          break;

        case 'ping':
          // Responder ao heartbeat
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }));
          break;

        default:
          console.log('⚠️ Tipo de mensagem desconhecido:', data.type);
      }
    } catch (err) {
      console.error('❌ Erro ao processar mensagem:', err);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Mensagem inválida'
      }));
    }
  });

  ws.on('close', () => {
    console.log('🔌 Cliente desconectado');
  });

  ws.on('error', (error) => {
    console.error('❌ Erro no WebSocket:', error);
  });
});

wss.on('error', (error) => {
  console.error('❌ Erro no servidor:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Encerrando servidor...');
  wss.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});
