// =====================================
// INTEGRAÇÃO COM A AGENDA DE AVALIAÇÃO FÍSICA (Planeta Corpo — Supabase)
// =====================================
const AGENDA_SUPABASE_URL = process.env.AGENDA_SUPABASE_URL;
const AGENDA_ANON_KEY = process.env.AGENDA_ANON_KEY;
const AGENDA_LOGIN_NOME = process.env.AGENDA_LOGIN_NOME;
const AGENDA_LOGIN_SENHA = process.env.AGENDA_LOGIN_SENHA;

// Resolve o e-mail interno da conta a partir do "nome" de login (Supabase
// Auth exige e-mail, mas esse sistema loga por nome — confirmado ao vivo:
// find_user_email_by_name devolve a string do e-mail direto, sem wrapper)
// e autentica na sequência. Chamado do zero a cada varredura (a varredura
// roda no máximo 1x/dia + cliques manuais — bem mais espaçado que o TTL de
// ~1h do token — então não vale a complexidade de cachear/renovar via
// refresh_token; login novo a cada chamada é mais simples e igualmente barato).
async function agendaLogin() {
    if (!AGENDA_SUPABASE_URL || !AGENDA_ANON_KEY || !AGENDA_LOGIN_NOME || !AGENDA_LOGIN_SENHA) {
        throw new Error('Integração Agenda de Avaliação não configurada (faltam variáveis de ambiente AGENDA_*).');
    }

    const resEmail = await fetch(`${AGENDA_SUPABASE_URL}/rest/v1/rpc/find_user_email_by_name`, {
        method: 'POST',
        headers: { apikey: AGENDA_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ _name: AGENDA_LOGIN_NOME })
    });
    if (!resEmail.ok) throw new Error(`Falha ao resolver e-mail da conta ${AGENDA_LOGIN_NOME} (HTTP ${resEmail.status}).`);
    const email = await resEmail.json();
    if (!email || typeof email !== 'string') throw new Error(`Não foi possível resolver o e-mail da conta ${AGENDA_LOGIN_NOME}.`);

    const resLogin = await fetch(`${AGENDA_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: AGENDA_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: AGENDA_LOGIN_SENHA })
    });
    if (!resLogin.ok) throw new Error(`Falha no login da Agenda de Avaliação (HTTP ${resLogin.status}).`);
    const dados = await resLogin.json();
    if (!dados.access_token) throw new Error('Login na Agenda de Avaliação não retornou access_token.');
    return dados.access_token;
}

// Busca as avaliações agendadas de um dia (padrão: hoje, fuso America/Sao_Paulo,
// status "agendado,confirmado" — os únicos que ainda fazem sentido confirmar).
async function buscarAgendaDoDia({ date, status } = {}) {
    const accessToken = await agendaLogin();
    const url = new URL(`${AGENDA_SUPABASE_URL}/functions/v1/chatbot-agenda-do-dia`);
    if (date) url.searchParams.set('date', date);
    if (status) url.searchParams.set('status', status);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
        let mensagem = `Falha ao buscar agenda do dia (HTTP ${res.status}).`;
        try {
            const corpo = await res.json();
            if (corpo?.message) mensagem = corpo.message;
        } catch (_) {}
        throw new Error(mensagem);
    }
    return res.json();
}

module.exports = { buscarAgendaDoDia };
