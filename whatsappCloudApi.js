// =====================================
// INTEGRAÇÃO COM O WHATSAPP BUSINESS CLOUD API (API oficial da Meta)
// =====================================
// Credenciais (Token de Acesso / Phone Number ID / App Secret) NÃO ficam em
// variável de ambiente — vêm da tabela `configuracoes` (mesmo padrão já
// usado pro Instagram), passadas como parâmetro em cada chamada, pra dar pra
// trocar pela tela de Configurações sem precisar de redeploy.
const https = require('https');

const GRAPH_API_VERSION = 'v21.0';

// Mesmo padrão de chamada usado em instagram.js/pacto.js: módulo https
// nativo direto, sem depender de lib de terceiros só pra fazer uma chamada
// REST simples. Tem timeout de segurança — sem isso, se a Graph API aceitar
// a conexão e nunca responder, a chamada fica pendurada pra sempre.
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
        req.on('timeout', () => req.destroy(new Error(`Timeout de ${GRAPH_REQUEST_TIMEOUT_MS / 1000}s ao chamar a Graph API do WhatsApp Business`)));
        if (payload) req.write(payload);
        req.end();
    });
}

// Manda uma mensagem de texto livre pro contato (telefone em formato E.164
// sem símbolos, ex: "5542999998888" — é o mesmo formato que já vem no
// webhook em mensagem.from). Fora da janela de 24h desde a última mensagem
// do cliente, a Meta rejeita texto livre (só aceita template aprovado) —
// essa Promise só rejeita normalmente, e quem chama trata isso como
// qualquer outra falha de envio, igual já acontece pro Instagram.
async function enviarMensagemWhatsappCloud(telefoneE164, texto, { accessToken, phoneNumberId } = {}) {
    if (!accessToken || !phoneNumberId) throw new Error('WhatsApp Business API não configurado: falta o Token de Acesso ou o Phone Number ID (ver Configurações).');
    return graphRequest('POST', `${phoneNumberId}/messages`, {
        accessToken,
        body: { messaging_product: 'whatsapp', to: telefoneE164, type: 'text', text: { body: texto, preview_url: false } },
    });
}

// Manda uma mensagem usando um template pré-aprovado pela Meta — único jeito
// de alcançar o contato fora da janela de 24h desde a última mensagem dele
// (texto livre é rejeitado nesse caso). `parametrosTexto` é um array na
// MESMA ordem das variáveis {{1}}, {{2}}... definidas no corpo do template
// aprovado (ver mensagens_personalizadas.template_whatsapp, que guarda essa
// ordem). Idioma sempre 'pt_BR' — mesmo usado na criação de todos os
// templates deste sistema.
async function enviarTemplateWhatsappCloud(telefoneE164, templateNome, parametrosTexto, { accessToken, phoneNumberId } = {}) {
    if (!accessToken || !phoneNumberId) throw new Error('WhatsApp Business API não configurado: falta o Token de Acesso ou o Phone Number ID (ver Configurações).');
    const parametros = (parametrosTexto || []).map(valor => ({ type: 'text', text: String(valor ?? '').trim() || '-' }));
    return graphRequest('POST', `${phoneNumberId}/messages`, {
        accessToken,
        body: {
            messaging_product: 'whatsapp',
            to: telefoneE164,
            type: 'template',
            template: {
                name: templateNome,
                language: { code: 'pt_BR' },
                ...(parametros.length > 0 ? { components: [{ type: 'body', parameters: parametros }] } : {}),
            },
        },
    });
}

module.exports = {
    enviarMensagemWhatsappCloud,
    enviarTemplateWhatsappCloud,
};
