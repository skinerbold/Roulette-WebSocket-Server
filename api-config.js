// ============================================
// CONFIGURAÇÃO DA API DE ROLETAS
// ============================================
// 
// Configuração para conectar ao WebSocket real em ws://177.93.108.140:8777
//

module.exports = {
  // API habilitada
  enabled: true,
  
  // URL base da API (vazia pois usaremos WebSocket direto)
  baseUrl: '',
  
  // WebSocket da API real
  websocketUrl: 'ws://177.93.108.140:8777',
  
  // Endpoints da API (caso haja REST API também)
  endpoints: {
    roulettes: '/api/roulettes',
    history: '/api/roulettes/{id}/history',
    realtime: '/api/roulettes/{id}/stream'
  },
  
  // Headers para autenticação (se necessário)
  headers: {
    'Content-Type': 'application/json',
    // 'Authorization': 'Bearer SEU_TOKEN_AQUI',
    // 'API-Key': 'SUA_CHAVE_AQUI',
  },
  
  // ============================================
  // FUNÇÕES DE PARSE DAS RESPOSTAS
  // ============================================
  
  /**
   * Parse da resposta de lista de roletas
   * A API envia mensagens individuais para cada roleta com: { game, key, game_type, results }
   */
  parseRoulettesResponse: (response) => {
    // A API não envia lista de roletas de uma vez
    // Cada roleta chega em mensagem separada com estrutura:
    // { game: "Nome", key: "id", game_type: "roleta", results: [...] }
    
    // Esta função será usada para identificar se a mensagem contém dados de uma roleta
    if (response.game && response.game_type === 'roleta' && Array.isArray(response.results)) {
      // Retornar o nome da roleta para adicionar à lista
      return [response.game];
    }
    
    return [];
  },
  
  /**
   * Parse da resposta de histórico de números
   * Formato: { game: "Nome", key: "id", game_type: "roleta", results: ["5", "13", "34", ...] }
   */
  parseHistoryResponse: (response) => {
    // Verificar se é uma mensagem de roleta com histórico
    if (response.game && response.game_type === 'roleta' && Array.isArray(response.results)) {
      // Converter strings para números e garantir range 0-36
      return response.results.map(n => {
        // Tratar "00" da roleta americana como 37 (ou 0)
        if (n === '00') return 0; // Ou use 37 se quiser diferenciar
        const num = parseInt(n);
        return isNaN(num) || num < 0 || num > 36 ? 0 : num;
      });
    }
    
    return [];
  },
  
  /**
   * Parse de mensagem de novo número da roleta
   * Formato: { game: "Nome", key: "id", game_type: "roleta", results: ["novo_numero"] }
   */
  parseNewNumberMessage: (message) => {
    // Quando um novo número é adicionado, a API envia a lista completa atualizada
    // O primeiro número do array 'results' é sempre o mais recente
    if (message.game && message.game_type === 'roleta' && Array.isArray(message.results) && message.results.length > 0) {
      const latestNumber = message.results[0];
      const num = latestNumber === '00' ? 0 : parseInt(latestNumber);
      
      return {
        number: isNaN(num) || num < 0 || num > 36 ? 0 : num,
        roulette: message.game
      };
    }
    
    return null;
  },
  
  // ============================================
  // CONFIGURAÇÕES ADICIONAIS
  // ============================================
  
  // Timeout para requisições HTTP (em milissegundos)
  timeout: 10000,
  
  // Intervalo de polling para atualização de dados (se necessário)
  pollingInterval: 5000,
  
  // Reconexão automática do WebSocket
  reconnect: true,
  reconnectInterval: 3000,
  maxReconnectAttempts: 10,
  
  // Log detalhado (útil para debug)
  verbose: true
};
