// Servidor WebSocket para Roleta ao Vivo
// Refatorado para isolar histórico por roleta, persistir lançamentos
// e implementar o protocolo subscribe/unsubscribe/get_history.

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Railway define a porta via variável de ambiente PORT
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

console.log(`🎰 Servidor WebSocket de Roleta rodando na porta ${PORT}`);

// ============================================
// CARREGAR CONFIGURAÇÃO DA API
// ============================================

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
  process.exit(1);
}

// ============================================
// SUPABASE (PERSISTÊNCIA)
// ============================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
let supabaseAdmin = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false }
    });
    console.log('🗄️  Persistência Supabase habilitada para roulette_history');
} else {
    console.warn('⚠️ Supabase não configurado (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY). Historico persistido apenas em memória.');
}

// ============================================
// MEMÓRIA E ESTRUTURAS DO SERVIDOR
// ============================================

const MAX_CACHE_LENGTH = 500;
const DEFAULT_HISTORY_LIMIT = 500;
const inMemoryHistory = new Map(); // rouletteId -> [{ value, timestamp }]
const availableRoulettes = new Set();
const rouletteMeta = new Map(); // rouletteId -> { lastTimestamp }
const subscriptionMap = new Map(); // ws -> Set(rouletteId)
const apiHydrationPromises = new Map(); // evita race conditions

let apiWebSocket = null;
let reconnectAttempts = 0;

// ============================================
// LISTA DE ROLETAS PERMITIDAS (mesma do frontend)
// Apenas estas roletas terão números salvos no banco de dados
// ============================================

const ALLOWED_ROULETTES = {
  'Playtech': [
    'mega fire blaze roulette live',
    'roleta brasileira'
  ],
  'Evolution Gaming': [
    'lightning',
    'xxxtreme',
    'immersive',
    'auto-roulette',
    'vip roulette',
    'speed',
    'roulette macao',
    'ao vivo',
    'relampago'
  ],
  'Pragmatic Play': [
    'mega roulette',
    'auto mega',
    'roleta brasileira pragmatic',
    'pragmatic',
    'power up'
  ],
  'Ezugi': [
    'ruby',
    'rapida',
    'azure'
  ]
};

// Normalizar nome da roleta para comparação
function normalizeRouletteName(name) {
  return (name || '').toLowerCase().trim();
}

// Verificar se roleta está na lista permitida
function isAllowedRoulette(rouletteId) {
  const normalized = normalizeRouletteName(rouletteId);
  
  // Buscar em todos os provedores
  for (const provider in ALLOWED_ROULETTES) {
    const allowedList = ALLOWED_ROULETTES[provider];
    for (const allowed of allowedList) {
      if (normalized.includes(allowed.toLowerCase())) {
        return true;
      }
    }
  }
  
  return false;
}

// Normalização centralizada garante consistência entre cache, storage e clientes.
function normalizeRouletteId(raw) {
    return (raw || '').trim().toLowerCase();
}

function buildHistoryPayload(rouletteId, history) {
    const numbers = history.map(entry => entry.value);
    const entries = history.map(entry => ({ number: entry.value, timestamp: entry.timestamp }));
    return {
        type: 'history',
        roulette: rouletteId,
        data: numbers,
        entries
    };
}

function ensureSubscriptionEntry(ws) {
    if (!subscriptionMap.has(ws)) {
        subscriptionMap.set(ws, new Set());
    }
    return subscriptionMap.get(ws);
}

function broadcastToSubscribers(rouletteId, message) {
    const payload = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState !== WebSocket.OPEN) return;
        const subs = subscriptionMap.get(client);
        if (subs && subs.has(rouletteId)) {
            client.send(payload);
        }
    });
}

function registerRoulette(rouletteIdRaw) {
    const rouletteId = normalizeRouletteId(rouletteIdRaw);
    if (!rouletteId) {
        return null;
    }
    if (!availableRoulettes.has(rouletteId)) {
        availableRoulettes.add(rouletteId);
        // Notificamos todos os clientes sobre novas roletas descobertas.
        const listPayload = {
            type: 'roulettes',
            data: Array.from(availableRoulettes.values())
        };
        const serialized = JSON.stringify(listPayload);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(serialized);
            }
        });
        console.log(`✅ Nova roleta descoberta e registrada: ${rouletteId}`);
    }
    return rouletteId;
}

// ============================================
// PERSISTÊNCIA SUPABASE
// ============================================

// Cache para rastrear último número persistido por roleta (evita duplicatas)
const lastPersistedNumber = new Map(); // rouletteId -> { number, timestamp }

/**
 * Persiste UM ÚNICO número usando a função RPC update_roulette_history
 * Esta função já implementa a lógica de shift de posições (1-500)
 * 🎯 APENAS ROLETAS PERMITIDAS são salvas no banco
 */
async function persistSingleNumber(rouletteId, number, timestamp) {
    if (!supabaseAdmin) {
        return false;
    }
    
    // 🎯 FILTRO: Verificar se roleta está na lista permitida
    if (!isAllowedRoulette(rouletteId)) {
        // Silenciosamente ignorar - não logar para evitar spam
        return false;
    }
    
    // Verificar se já persistiu este número recentemente (evita duplicatas)
    const lastPersisted = lastPersistedNumber.get(rouletteId);
    if (lastPersisted && lastPersisted.number === number && 
        Math.abs(lastPersisted.timestamp - timestamp) < 5000) {
        console.log(`⏭️ Número ${number} já persistido recentemente para ${rouletteId}, ignorando`);
        return false;
    }
    
    try {
        // Converter para Unix timestamp em milissegundos (bigint)
        const timestampMs = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
        
        const { data, error } = await supabaseAdmin.rpc('update_roulette_history', {
            p_roulette_id: rouletteId,
            p_number: number,
            p_timestamp: timestampMs
        });
        
        if (error) {
            console.error(`❌ Erro ao persistir número ${number} para ${rouletteId}:`, error.message);
            return false;
        }
        
        // Atualizar cache de último número persistido
        lastPersistedNumber.set(rouletteId, { number, timestamp });
        
        console.log(`💾 Número ${number} persistido para ${rouletteId} via RPC`);
        return true;
    } catch (err) {
        console.error('❌ Erro inesperado ao persistir número:', err);
        return false;
    }
}

/**
 * @deprecated Use persistSingleNumber para novos números
 * Mantido para compatibilidade com carga inicial do histórico
 */
async function persistEntries(rouletteId, entries) {
    if (!supabaseAdmin || !entries.length) {
        return;
    }
    
    // Para carga inicial, persistir apenas o número mais recente
    // Os outros serão carregados da API quando necessário
    const latestEntry = entries[entries.length - 1]; // último = mais recente na ordem cronológica
    if (latestEntry) {
        await persistSingleNumber(rouletteId, latestEntry.value, latestEntry.timestamp);
    }
}

async function hydrateFromStore(rouletteId) {
    if (!supabaseAdmin) {
        return;
    }

    // 🔧 FIX: Não hidratar se já temos dados em memória!
    // Os dados em memória são a fonte da verdade durante a execução
    const existingHistory = inMemoryHistory.get(rouletteId);
    if (existingHistory && existingHistory.length > 0) {
        console.log(`⏭️ Cache de ${rouletteId} já tem ${existingHistory.length} números em memória, não sobrescrevendo.`);
        return;
    }

    if (apiHydrationPromises.has(rouletteId)) {
        return apiHydrationPromises.get(rouletteId);
    }

    const promise = (async () => {
        try {
            // ATUALIZADO: Sem coluna position - usar timestamp DESC (mais recente primeiro)
            const { data, error } = await supabaseAdmin
                .from('roulette_history')
                .select('number, timestamp')
                .eq('roulette_id', rouletteId)
                .order('timestamp', { ascending: false }) // mais recente primeiro
                .limit(MAX_CACHE_LENGTH);

            if (error) {
                console.error('❌ Erro ao carregar histórico do Supabase:', error.message);
                return;
            }

            if (Array.isArray(data) && data.length) {
                // Mapear para formato interno (value, timestamp)
                // timestamp já está em BIGINT (milissegundos) no banco
                const entries = data.map(row => ({
                    value: row.number,
                    timestamp: typeof row.timestamp === 'number' ? row.timestamp : new Date(row.timestamp).getTime()
                }));
                inMemoryHistory.set(rouletteId, entries);
                rouletteMeta.set(rouletteId, { lastTimestamp: entries[0].timestamp });
                console.log(`💾 Cache de ${rouletteId} hidratado com ${entries.length} lançamentos persistidos.`);
            }
        } finally {
            apiHydrationPromises.delete(rouletteId);
        }
    })();

    apiHydrationPromises.set(rouletteId, promise);
    return promise;
}

async function fetchOlderFromStore(rouletteId, alreadyCached, limit) {
    if (!supabaseAdmin) {
        return [];
    }
    try {
        // ATUALIZADO: Sem coluna position - usar offset/limit com ordenação por timestamp
        const { data, error } = await supabaseAdmin
            .from('roulette_history')
            .select('number, timestamp')
            .eq('roulette_id', rouletteId)
            .order('timestamp', { ascending: false }) // mais recente primeiro
            .range(alreadyCached, alreadyCached + limit - 1);

        if (error) {
            console.error('❌ Erro ao expandir histórico persistido:', error.message);
            return [];
        }

        // Mapear para formato interno
        // timestamp já está em BIGINT (milissegundos) no banco
        return data.map(row => ({ 
            value: row.number,
            timestamp: typeof row.timestamp === 'number' ? row.timestamp : new Date(row.timestamp).getTime()
        }));
    } catch (err) {
        console.error('❌ Exceção ao buscar histórico adicional:', err);
        return [];
    }
}

// ============================================
// CONEXÃO COM WEBSOCKET DA API REAL
// ============================================

let apiConnectionStatus = 'disconnected';
let lastApiMessageTime = null;
let apiMessageCount = 0;
let apiHealthCheckInterval = null;

// Verificar saúde da conexão da API a cada 30 segundos
function startApiHealthCheck() {
    if (apiHealthCheckInterval) {
        clearInterval(apiHealthCheckInterval);
    }
    
    apiHealthCheckInterval = setInterval(() => {
        const now = Date.now();
        const timeSinceLastMessage = lastApiMessageTime ? now - lastApiMessageTime : null;
        const readyState = apiWebSocket ? apiWebSocket.readyState : 'null';
        const readyStateText = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][readyState] || readyState;
        
        console.log(`\n🏥 ============ API HEALTH CHECK ============`);
        console.log(`   📡 Status: ${apiConnectionStatus}`);
        console.log(`   🔗 ReadyState: ${readyStateText} (${readyState})`);
        console.log(`   📨 Mensagens recebidas: ${apiMessageCount}`);
        console.log(`   ⏰ Última mensagem: ${timeSinceLastMessage ? Math.floor(timeSinceLastMessage / 1000) + 's atrás' : 'NUNCA'}`);
        console.log(`   🎰 Roletas conhecidas: ${availableRoulettes.size}`);
        console.log(`   👥 Clientes conectados: ${wss.clients.size}`);
        console.log(`   🧮 Tentativas de reconexão: ${reconnectAttempts}`);
        
        // Se passou mais de 2 minutos sem mensagens e está "conectado", reconectar
        if (apiConnectionStatus === 'connected' && timeSinceLastMessage && timeSinceLastMessage > 120000) {
            console.warn('⚠️⚠️⚠️ API TRAVADA: 2+ minutos sem mensagens - FORÇANDO RECONEXÃO!');
            if (apiWebSocket) {
                try {
                    apiWebSocket.close();
                } catch (e) {
                    console.error('Erro ao fechar WS:', e);
                }
            }
            setTimeout(() => connectToAPIWebSocket(), 1000);
        }
        
        // Se está OPEN mas não conectado no status, corrigir
        if (readyState === 1 && apiConnectionStatus !== 'connected') {
            console.warn('⚠️ ReadyState é OPEN mas status não é connected - corrigindo...');
            apiConnectionStatus = 'connected';
        }
    }, 30000); // A cada 30 segundos
}

function connectToAPIWebSocket() {
    const wsUrl = API_CONFIG.websocketUrl || 'ws://177.93.108.140:8777';

    console.log(`🔌 Conectando ao WebSocket da API: ${wsUrl}`);
    apiConnectionStatus = 'connecting';

    try {
        apiWebSocket = new WebSocket(wsUrl);

        apiWebSocket.on('open', () => {
            console.log('✅ Conectado ao WebSocket da API!');
            apiConnectionStatus = 'connected';
            reconnectAttempts = 0;
            lastApiMessageTime = Date.now();

            // Iniciar health check
            startApiHealthCheck();

            try {
                apiWebSocket.send(JSON.stringify({ type: 'get_roulettes', action: 'list_tables' }));
                console.log('📤 Solicitação de lista de roletas enviada para API');
            } catch (error) {
                console.error('Erro ao solicitar roletas:', error);
            }
        });

        apiWebSocket.on('message', async raw => {
            lastApiMessageTime = Date.now();
            apiMessageCount++;
            
            try {
                const message = JSON.parse(raw.toString());

                // Log periódico de status
                if (apiMessageCount % 100 === 0) {
                    console.log(`📊 API Status: ${apiMessageCount} mensagens recebidas, última: ${new Date(lastApiMessageTime).toISOString()}`);
                }

                if (API_CONFIG.verbose) {
                    console.log('📨 Mensagem da API:', message);
                }

                if (message.game && message.game_type === 'roleta' && Array.isArray(message.results)) {
                    await processApiHistory(message.game, message.results);
                } else {
                    // Log de mensagens não processadas (para debug)
                    if (apiMessageCount <= 10) {
                        console.log(`📨 Mensagem API #${apiMessageCount}:`, JSON.stringify(message).substring(0, 200));
                    }
                }
            } catch (error) {
                if (API_CONFIG.verbose) {
                    console.log('📨 Mensagem da API (não-JSON ou inválida):', raw.toString().substring(0, 100));
                }
            }
        });

        apiWebSocket.on('error', error => {
            console.error('❌ Erro no WebSocket da API:', error.message);
            apiConnectionStatus = 'error';
        });

        apiWebSocket.on('close', (code, reason) => {
            console.log(`⚠️ WebSocket da API fechado. Código: ${code}, Motivo: ${reason}`);
            apiConnectionStatus = 'disconnected';

            if (API_CONFIG.reconnect && reconnectAttempts < API_CONFIG.maxReconnectAttempts) {
                reconnectAttempts += 1;
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

async function processApiHistory(rawRouletteId, numbers) {
    const rouletteId = registerRoulette(rawRouletteId);
    if (!rouletteId) {
        return;
    }

    // Primeiro: hidratar do banco de dados (fonte da verdade)
    await hydrateFromStore(rouletteId);

    const normalizedNumbers = numbers.map(n => {
        if (n === '00') return 37;
        const parsed = parseInt(n, 10);
        return Number.isNaN(parsed) ? 0 : Math.max(0, Math.min(parsed, 37));
    });

    if (normalizedNumbers.length === 0) {
        return;
    }

    const existing = inMemoryHistory.get(rouletteId) || [];
    const now = Date.now();
    const latestIncoming = normalizedNumbers[0]; // Número mais recente da API

    // ============================================
    // LÓGICA CORRIGIDA: Detectar APENAS o número mais recente
    // A API sempre envia ~60 números, mas só nos interessa o primeiro (mais recente)
    // ============================================
    
    // Verificar se já processamos este número
    const latestExisting = existing[0]?.value;
    
    if (latestIncoming === latestExisting) {
        // Número mais recente é igual ao que já temos - não há novidade
        return;
    }
    
    // Se chegou aqui, temos um número NOVO
    const newEntry = { value: latestIncoming, timestamp: now };
    
    // Atualizar cache em memória (adicionar no início)
    const updatedHistory = [newEntry, ...existing].slice(0, MAX_CACHE_LENGTH);
    inMemoryHistory.set(rouletteId, updatedHistory);
    rouletteMeta.set(rouletteId, { lastTimestamp: now });
    
    // PERSISTIR o número no banco de dados
    await persistSingleNumber(rouletteId, latestIncoming, now);
    
    // Broadcast para clientes inscritos
    broadcastToSubscribers(rouletteId, {
        type: 'result',
        roulette: rouletteId,
        number: latestIncoming,
        timestamp: now
    });
    
    console.log(`🎲 ${rouletteId}: Novo número ${latestIncoming} (total em memória: ${updatedHistory.length})`);
}

// ============================================
// FUNÇÕES DE API REAL (FALLBACK HTTP)
// ============================================

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

        const req = protocol.request(options, res => {
            let data = '';

            res.on('data', chunk => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(new Error('Resposta inválida da API'));
                }
            });
        });

        req.on('error', reject);

        req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error('Timeout ao conectar à API'));
        });

        req.end();
    });
}

async function fetchRoulettesFromAPI() {
    const url = API_CONFIG.baseUrl + API_CONFIG.endpoints.roulettes;
    if (API_CONFIG.verbose) console.log(`📡 Buscando roletas da API: ${url}`);

    const response = await fetchFromAPI(url);
    const roulettes = API_CONFIG.parseRoulettesResponse(response);

    if (Array.isArray(roulettes) && roulettes.length > 0) {
        console.log(`✅ ${roulettes.length} roletas carregadas da API`);
        return roulettes.map(r => (typeof r === 'string' ? r : r.name || r.id || r.toString()));
    }

    throw new Error('API não retornou roletas válidas');
}

async function fetchHistoryFromAPI(rouletteName, limit = DEFAULT_HISTORY_LIMIT) {
    let url = API_CONFIG.baseUrl + API_CONFIG.endpoints.history.replace('{id}', encodeURIComponent(rouletteName));

    if (!url.includes('limit=')) {
        url += (url.includes('?') ? '&' : '?') + `limit=${limit}`;
    }

    if (API_CONFIG.verbose) console.log(`📡 Buscando histórico da API: ${url}`);

    const response = await fetchFromAPI(url);
    const history = API_CONFIG.parseHistoryResponse(response);

    if (Array.isArray(history) && history.length > 0) {
        console.log(`✅ ${history.length} números carregados da API para ${rouletteName}`);
        return history.map(n => {
            if (n === '00') return 37;
            const num = typeof n === 'number' ? n : parseInt(n, 10);
            return Number.isNaN(num) ? 0 : Math.max(0, Math.min(num, 37));
        }).slice(0, limit);
    }

    throw new Error('API não retornou histórico válido');
}

async function initializeFromAPI() {
    console.log('🔄 Inicializando conexão com WebSocket da API...');

    try {
        connectToAPIWebSocket();

        await new Promise(resolve => setTimeout(resolve, 2000));

        if (!availableRoulettes.size && API_CONFIG.baseUrl) {
            console.log('⚠️ Tentando buscar roletas via HTTP como fallback...');
            const apiRoulettes = await fetchRoulettesFromAPI();

            apiRoulettes.forEach(roulette => registerRoulette(roulette));

            for (const roulette of apiRoulettes) {
                const numbers = await fetchHistoryFromAPI(roulette, MAX_CACHE_LENGTH);
                await processApiHistory(roulette, numbers);
            }
        }

        console.log('✅ Inicialização completa - Conectado à API real');
    } catch (error) {
        console.error('❌ Erro na inicialização:', error.message);
        console.error('Continuando com conexão WebSocket...');
    }
}

// ============================================
// WEBSOCKET SERVER (CLIENTES)
// ============================================

wss.on('connection', ws => {
    console.log('✅ Novo cliente conectado');

    ensureSubscriptionEntry(ws);

    ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
    ws.send(JSON.stringify({ type: 'roulettes', data: Array.from(availableRoulettes.values()) }));

    ws.on('message', async raw => {
        try {
            const data = JSON.parse(raw.toString());
            await handleClientMessage(ws, data);
        } catch (err) {
            console.error('❌ Erro ao processar mensagem do cliente:', err);
            ws.send(JSON.stringify({ type: 'error', error: 'Mensagem inválida' }));
        }
    });

    ws.on('close', () => {
        subscriptionMap.delete(ws);
        console.log('🔌 Cliente desconectado');
    });

    ws.on('error', error => {
        console.error('❌ Erro no WebSocket do cliente:', error);
    });
});

wss.on('error', error => {
    console.error('❌ Erro no servidor:', error);
});

async function handleClientMessage(ws, message) {
    switch (message.type) {
        case 'get_roulettes':
            ws.send(JSON.stringify({ type: 'roulettes', data: Array.from(availableRoulettes.values()) }));
            break;

        case 'subscribe': {
            const rouletteId = normalizeRouletteId(message.roulette);
            const limit = Number(message.limit) || DEFAULT_HISTORY_LIMIT;

            if (!rouletteId) {
                ws.send(JSON.stringify({ type: 'error', error: 'Roulette inválida' }));
                return;
            }

            registerRoulette(rouletteId);
            const subs = ensureSubscriptionEntry(ws);
            subs.add(rouletteId);

            await hydrateFromStore(rouletteId);

            await ensureHistoryLength(rouletteId, limit);

            const history = (inMemoryHistory.get(rouletteId) || []).slice(0, limit);
            ws.send(JSON.stringify(buildHistoryPayload(rouletteId, history)));
            break;
        }

        case 'unsubscribe': {
            const rouletteId = normalizeRouletteId(message.roulette);
            if (!rouletteId) return;
            const subs = ensureSubscriptionEntry(ws);
            subs.delete(rouletteId);
            break;
        }

        case 'get_history': {
            const rouletteId = normalizeRouletteId(message.roulette);
            const limit = Number(message.limit) || DEFAULT_HISTORY_LIMIT;

            if (!rouletteId) {
                ws.send(JSON.stringify({ type: 'error', error: 'Roulette inválida' }));
                return;
            }

            await hydrateFromStore(rouletteId);
            await ensureHistoryLength(rouletteId, limit);

            const history = (inMemoryHistory.get(rouletteId) || []).slice(0, limit);
            ws.send(JSON.stringify(buildHistoryPayload(rouletteId, history)));
            break;
        }

        case 'get_all_history': {
            // Enviar histórico de TODAS as roletas conhecidas
            console.log(`📤 Cliente solicitou histórico de todas as roletas (${availableRoulettes.size} roletas)`);
            
            for (const rouletteId of availableRoulettes.values()) {
                await hydrateFromStore(rouletteId);
                const history = (inMemoryHistory.get(rouletteId) || []).slice(0, DEFAULT_HISTORY_LIMIT);
                
                if (history.length > 0) {
                    ws.send(JSON.stringify(buildHistoryPayload(rouletteId, history)));
                }
            }
            break;
        }

        case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;

        case 'status':
            // Retorna status do servidor para diagnóstico
            ws.send(JSON.stringify({
                type: 'status',
                apiConnection: apiConnectionStatus,
                lastApiMessage: lastApiMessageTime ? new Date(lastApiMessageTime).toISOString() : null,
                apiMessageCount: apiMessageCount,
                roulettesCount: availableRoulettes.size,
                clientsConnected: wss.clients.size,
                uptime: process.uptime(),
                timestamp: Date.now()
            }));
            break;

        default:
            console.log('⚠️ Tipo de mensagem desconhecido:', message.type);
            ws.send(JSON.stringify({ type: 'error', error: `Comando desconhecido: ${message.type}` }));
    }
}

async function ensureHistoryLength(rouletteId, limit) {
    const current = inMemoryHistory.get(rouletteId) || [];

    if (current.length >= limit) {
        return;
    }

    console.log(`📊 Cache tem ${current.length} números, mas precisa de ${limit}. Buscando mais do Supabase...`);

    // APENAS buscar do Supabase (armazenamento persistente)
    // NÃO usar API Fly.io - o histórico deve ser construído apenas com números individuais
    const missing = limit - current.length;
    const olderEntries = await fetchOlderFromStore(rouletteId, current.length, missing);
    
    if (olderEntries.length > 0) {
        const merged = [...current, ...olderEntries].slice(0, MAX_CACHE_LENGTH);
        inMemoryHistory.set(rouletteId, merged);
        console.log(`💾 ${olderEntries.length} números carregados do Supabase. Total: ${merged.length}`);
    } else {
        console.log(`📊 Supabase não tem mais números para ${rouletteId}. Total disponível: ${current.length}`);
        console.log(`   💡 O histórico será construído automaticamente conforme novos números chegam.`);
    }
}

// ============================================
// INICIALIZAÇÃO
// ============================================

initializeFromAPI().then(() => {
    console.log('🚀 Servidor pronto para aceitar conexões');
});

// ============================================
// ENCERRAMENTO GRACIOSO
// ============================================

process.on('SIGINT', () => {
    console.log('\n🛑 Encerrando servidor...');
    wss.close(() => {
        console.log('✅ Servidor encerrado');
        process.exit(0);
    });
});
