// =====================================
// INTEGRAÇÃO COM A API DE MENSAGENS DO INSTAGRAM (Meta Graph API)
// =====================================
// Credenciais (Page Access Token / App Secret) NÃO ficam em variável de
// ambiente — vêm da tabela `configuracoes` (mesmo padrão já usado pra chave
// da OpenAI), passadas como parâmetro em cada chamada, pra dar pra trocar
// pela tela de Configurações sem precisar de redeploy.
const https = require('https');
const crypto = require('crypto');

const GRAPH_API_VERSION = 'v21.0';

// Mesmo padrão de chamada usado em pacto.js: módulo https nativo direto, sem
// depender de lib de terceiros só pra fazer uma chamada REST simples. Tem
// timeout de segurança — sem isso, se a Graph API aceitar a conexão e nunca
// responder, a chamada fica pendurada pra sempre (foi exatamente o bug já
// corrigido em pacto.js nesta mesma base de código).
const GRAPH_REQUEST_TIMEOUT_MS = 20000;

function graphRequest(method, path, { params, body, accessToken } = {}) {
    const url = new URL(path, `https://graph.facebook.com/${GRAPH_API_VERSION}/`);
    Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, value));
    if (accessToken) url.searchParams.set('access_token', accessToken);
    const payload = body ? JSON.stringify(body) : null;

    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method,
            timeout: GRAPH_REQUEST_TIMEOUT_MS,
            headers: {
                Accept: 'application/json',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = data ? JSON.parse(data) : null; } catch (_) { /* corpo de erro às vezes não é JSON */ }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(parsed?.error?.message || data || `Erro HTTP ${res.statusCode}`));
                    return;
                }
                resolve(parsed);
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error(`Timeout de ${GRAPH_REQUEST_TIMEOUT_MS / 1000}s ao chamar a Graph API do Instagram`)));
        if (payload) req.write(payload);
        req.end();
    });
}

// Manda uma mensagem de texto pro contato do Instagram (igsid = Instagram-
// Scoped ID, vem do webhook). Se o cliente estiver fora da janela de 24h
// desde a última mensagem dele (regra da própria Meta, não nossa), a Graph
// API rejeita — essa Promise só rejeita normalmente, e quem chama (robô,
// automação) trata isso como qualquer outra falha de envio.
async function enviarMensagemInstagram(igsid, texto, accessToken) {
    if (!accessToken) throw new Error('Instagram não configurado: falta o Page Access Token (ver Configurações).');
    return graphRequest('POST', 'me/messages', {
        accessToken,
        body: { recipient: { id: igsid }, message: { text: texto } },
    });
}

// Nome de exibição do contato do Instagram — mesmo papel do "pushname" do
// WhatsApp, usado só pra preencher o nome do lead/conversa. Cacheado em
// memória (nome raramente muda) com fallback pro próprio igsid se a chamada
// falhar, igual ao padrão "nome || telefone" já usado no resto do sistema.
const nomeUsuarioCache = new Map();
async function obterNomeUsuarioInstagram(igsid, accessToken) {
    if (nomeUsuarioCache.has(igsid)) return nomeUsuarioCache.get(igsid);
    try {
        const resultado = await graphRequest('GET', igsid, { params: { fields: 'name,username' }, accessToken });
        const nome = resultado?.name || resultado?.username || igsid;
        nomeUsuarioCache.set(igsid, nome);
        return nome;
    } catch (e) {
        console.error(`Erro ao buscar nome do usuário Instagram ${igsid}:`, e.message);
        return igsid;
    }
}

// Confere a assinatura HMAC-SHA256 que a Meta manda em X-Hub-Signature-256,
// calculada sobre o CORPO CRU da requisição (antes de qualquer JSON.parse) —
// sem isso, qualquer um que descobrisse a URL do webhook poderia forjar
// eventos (criar leads falsos, fazer a IA responder à toa, etc.).
function verificarAssinaturaWebhook(rawBody, assinaturaHeader, appSecret) {
    if (!assinaturaHeader || !appSecret) return false;
    const esperada = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const bufAssinatura = Buffer.from(assinaturaHeader);
    const bufEsperada = Buffer.from(esperada);
    if (bufAssinatura.length !== bufEsperada.length) return false;
    return crypto.timingSafeEqual(bufAssinatura, bufEsperada);
}

module.exports = {
    enviarMensagemInstagram,
    obterNomeUsuarioInstagram,
    verificarAssinaturaWebhook,
};
