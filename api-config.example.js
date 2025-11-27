// ============================================
// CONFIGURAÇÃO DA API DE ROLETAS - EXEMPLO
// ============================================
// 
// Copie este arquivo para api-config.js e configure conforme necessário
//

module.exports = {
  // API habilitada
  enabled: true,
  
  // URL base da API (vazia pois usaremos WebSocket direto)
  baseUrl: '',
  
  // WebSocket da API real (CONFIGURE AQUI SEU WEBSOCKET EXTERNO)
  websocketUrl: 'ws://SEU_IP:PORTA',
  
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
   */
  parseRoulettesResponse: (response) => {
    if (response.game && response.game_type === 'roleta' && Array.isArray(response.results)) {
      return [response.game];
    }
    return [];
  },
  
  /**
   * Parse da resposta de histórico
   */
  parseHistoryResponse: (response) => {
    if (Array.isArray(response.results)) {
      return response.results.map(r => ({
        number: r.result,
        color: r.color || 'green',
        timestamp: r.timestamp || Date.now()
      }));
    }
    return [];
  }
};
