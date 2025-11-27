// Servidor WebSocket para Roleta ao Vivo
// Refatorado para isolar histórico por roleta, persistir lançamentos
// e implementar o protocolo subscribe/unsubscribe/get_history.

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const wss = new WebSocket.Server({ port: 3000 });

console.log('🎰 Servidor WebSocket de Roleta rodando em ws://localhost:3000');

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

async function persistEntries(rouletteId, entries) {
    if (!supabaseAdmin || !entries.length) {
        return;
    }
    try {
        const payload = entries.map(entry => ({
            roulette_id: rouletteId,
            value: entry.value,
            occurred_at: new Date(entry.timestamp).toISOString()
        }));
        const { error } = await supabaseAdmin.from('roulette_history').insert(payload, { returning: 'minimal' });
        if (error) {
            console.error('❌ Falha ao persistir entradas no Supabase:', error.message);
        }
    } catch (err) {
        console.error('❌ Erro inesperado ao persistir histórico:', err);
    }
}

async function hydrateFromStore(rouletteId) {
    if (!supabaseAdmin) {
        return;
    }

    if (apiHydrationPromises.has(rouletteId)) {
        return apiHydrationPromises.get(rouletteId);
    }

    const promise = (async () => {
        try {
            const { data, error } = await supabaseAdmin
                .from('roulette_history')
                .select('value, occurred_at')
                .eq('roulette_id', rouletteId)
                .order('occurred_at', { ascending: false })
                .limit(MAX_CACHE_LENGTH);

            if (error) {
                console.error('❌ Erro ao carregar histórico do Supabase:', error.message);
                return;
            }

            if (Array.isArray(data) && data.length) {
                const entries = data.map(row => ({
                    value: row.value,
                    timestamp: new Date(row.occurred_at).getTime()
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
        const offset = alreadyCached;
        const { data, error } = await supabaseAdmin
            .from('roulette_history')
            .select('value, occurred_at')
            .eq('roulette_id', rouletteId)
            .order('occurred_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            console.error('❌ Erro ao expandir histórico persistido:', error.message);
            return [];
        }

        return data.map(row => ({ value: row.value, timestamp: new Date(row.occurred_at).getTime() }));
    } catch (err) {
        console.error('❌ Exceção ao buscar histórico adicional:', err);
        return [];
    }
}

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

            try {
                apiWebSocket.send(JSON.stringify({ type: 'get_roulettes', action: 'list_tables' }));
            } catch (error) {
                console.error('Erro ao solicitar roletas:', error);
            }
        });

        apiWebSocket.on('message', async raw => {
            try {
                const message = JSON.parse(raw.toString());

                if (API_CONFIG.verbose) {
                    console.log('📨 Mensagem da API:', message);
                }

                if (message.game && message.game_type === 'roleta' && Array.isArray(message.results)) {
                    await processApiHistory(message.game, message.results);
                }
            } catch (error) {
                if (API_CONFIG.verbose) {
                    console.log('📨 Mensagem da API (não-JSON ou inválida):', raw.toString().substring(0, 100));
                }
            }
        });

        apiWebSocket.on('error', error => {
            console.error('❌ Erro no WebSocket da API:', error.message);
        });

        apiWebSocket.on('close', (code, reason) => {
            console.log(`⚠️ WebSocket da API fechado. Código: ${code}, Motivo: ${reason}`);

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

    await hydrateFromStore(rouletteId);

    const normalizedNumbers = numbers.map(n => {
        if (n === '00') return 37;
        const parsed = parseInt(n, 10);
        return Number.isNaN(parsed) ? 0 : Math.max(0, Math.min(parsed, 37));
    });

    const existing = inMemoryHistory.get(rouletteId) || [];
    const existingValues = existing.map(entry => entry.value);

    const overlapIndex = findOverlap(normalizedNumbers, existingValues);
    const now = Date.now();
    const newEntries = [];

    for (let i = 0; i < overlapIndex; i += 1) {
        const timestamp = now - i * 1000; // diferença mínima para preservar ordem
        newEntries.push({ value: normalizedNumbers[i], timestamp });
    }

    if (!existing.length && normalizedNumbers.length && newEntries.length === 0) {
        // Primeiro carregamento: considerar todo o histórico recebido.
        for (let i = 0; i < normalizedNumbers.length; i += 1) {
            const timestamp = now - i * 1000;
            newEntries.push({ value: normalizedNumbers[i], timestamp });
        }
    }

    if (newEntries.length) {
        // Inserimos na frente do cache mantendo o limite.
        const updatedHistory = [...newEntries, ...existing].slice(0, MAX_CACHE_LENGTH);
        inMemoryHistory.set(rouletteId, updatedHistory);
        rouletteMeta.set(rouletteId, { lastTimestamp: updatedHistory[0].timestamp });

        await persistEntries(rouletteId, [...newEntries].reverse()); // persiste em ordem cronológica

        const latest = newEntries[0];
        broadcastToSubscribers(rouletteId, {
            type: 'result',
            roulette: rouletteId,
            number: latest.value,
            timestamp: latest.timestamp
        });
    }
}

function findOverlap(incoming, existingValues) {
    if (!existingValues.length) {
        return incoming.length;
    }

    for (let index = 0; index < incoming.length; index += 1) {
        let matches = true;
        for (let offset = 0; offset < existingValues.length; offset += 1) {
            const incomingValue = incoming[index + offset];
            const existingValue = existingValues[offset];
            if (incomingValue === undefined || incomingValue !== existingValue) {
                matches = false;
                break;
            }
        }
        if (matches) {
            return index;
        }
    }
    return incoming.length;
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

        case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
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

    console.log(`📊 Cache tem ${current.length} números, mas precisa de ${limit}. Buscando mais...`);

    // Primeiro: tentar buscar do Supabase (armazenamento persistente)
    const missing = limit - current.length;
    const olderEntries = await fetchOlderFromStore(rouletteId, current.length, missing);
    
    if (olderEntries.length > 0) {
        const merged = [...current, ...olderEntries].slice(0, MAX_CACHE_LENGTH);
        inMemoryHistory.set(rouletteId, merged);
        console.log(`💾 ${olderEntries.length} números carregados do Supabase. Total: ${merged.length}`);
    }

    // Segundo: se ainda não tiver o suficiente, buscar da API Fly.io
    const afterSupabase = inMemoryHistory.get(rouletteId) || [];
    if (afterSupabase.length < limit) {
        console.log(`🚀 Buscando ${limit} números da API Fly.io para ${rouletteId}...`);
        
        try {
            // Usar a API Fly.io para preencher histórico
            const flyApiUrl = process.env.FLY_API_URL || 'https://roulette-history-api.fly.dev';
            const apiNumbers = await fetchFromFlyApi(flyApiUrl, rouletteId, limit);
            
            if (apiNumbers && apiNumbers.length > 0) {
                // Converter números da API para formato interno
                const now = Date.now();
                const entries = apiNumbers.map((num, index) => ({
                    value: num,
                    timestamp: now - (index * 1000)
                }));
                
                inMemoryHistory.set(rouletteId, entries.slice(0, MAX_CACHE_LENGTH));
                console.log(`✅ ${entries.length} números carregados da API Fly.io`);
                
                // Persistir no Supabase para próximas consultas
                await persistEntries(rouletteId, [...entries].reverse());
            }
        } catch (error) {
            console.error(`❌ Erro ao buscar histórico da API Fly.io: ${error.message}`);
        }
    }
}

async function fetchFromFlyApi(baseUrl, rouletteId, limit) {
    return new Promise((resolve, reject) => {
        const url = `${baseUrl}/api/history/${encodeURIComponent(rouletteId)}?limit=${limit}`;
        
        https.get(url, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.success && Array.isArray(json.numbers)) {
                        resolve(json.numbers);
                    } else {
                        resolve([]);
                    }
                } catch (err) {
                    console.error(`❌ Erro ao parsear resposta da API Fly.io: ${err.message}`);
                    resolve([]);
                }
            });
        }).on('error', (error) => {
            console.error(`❌ Erro de conexão com API Fly.io: ${error.message}`);
            reject(error);
        });
    });
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
