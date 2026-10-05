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

// Muda o status de UM agendamento direto na tabela appointments (PostgREST)
// — a conta do robô é admin na Agenda (enxerga a agenda de todos os
// professores na função de leitura acima, o que só admin consegue), e a
// política "Admins full access appointments" já libera o UPDATE; updated_at
// é atualizado sozinho por trigger do lado de lá. Só mexe em quem ainda está
// "agendado" ou "confirmado": um agendamento já realizado/cancelado/faltou
// nunca é sobrescrito por uma resposta atrasada do aluno. Devolve a linha
// atualizada, ou null quando nada bateu (status já mudou, id sumiu, ou a
// conta perdeu a permissão — o RLS não dá erro, só não atualiza nada).
async function atualizarStatusAgendamento(appointmentId, novoStatus) {
    const accessToken = await agendaLogin();
    const url = new URL(`${AGENDA_SUPABASE_URL}/rest/v1/appointments`);
    url.searchParams.set('id', `eq.${appointmentId}`);
    url.searchParams.set('status', 'in.(agendado,confirmado)');
    const res = await fetch(url, {
        method: 'PATCH',
        headers: {
            apikey: AGENDA_ANON_KEY,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
        },
        body: JSON.stringify({ status: novoStatus }),
    });
    if (!res.ok) {
        let mensagem = `Falha ao atualizar o agendamento na Agenda (HTTP ${res.status}).`;
        try {
            const corpo = await res.json();
            if (corpo?.message) mensagem = corpo.message;
        } catch (_) {}
        throw new Error(mensagem);
    }
    const linhas = await res.json();
    return Array.isArray(linhas) && linhas.length > 0 ? linhas[0] : null;
}

// GET simples no PostgREST da Agenda com o token de quem chama — usado pela
// cobrança do MQV, que faz duas leituras seguidas e reaproveita um login só.
async function agendaGet(accessToken, tabela, params) {
    const url = new URL(`${AGENDA_SUPABASE_URL}/rest/v1/${tabela}`);
    Object.entries(params).forEach(([chave, valor]) => url.searchParams.set(chave, valor));
    const res = await fetch(url, { headers: { apikey: AGENDA_ANON_KEY, Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
        let mensagem = `Falha ao ler ${tabela} na Agenda (HTTP ${res.status}).`;
        try {
            const corpo = await res.json();
            if (corpo?.message) mensagem = corpo.message;
        } catch (_) {}
        throw new Error(mensagem);
    }
    return res.json();
}

// MQVs respondidos desde `desdeIso`, com a matrícula e o WhatsApp do
// cadastro da Avaliação Física (clients) de cada um — o MQV é ligado a esse
// cadastro, não ao aluno da agenda (profiles); quem chama cruza os dois pela
// matrícula/WhatsApp, igual a própria Agenda faz (src/lib/agenda-match.ts).
async function buscarMQVsRecentes(desdeIso, accessToken = null) {
    const token = accessToken || await agendaLogin();
    const linhas = await agendaGet(token, 'mqv_responses', {
        select: 'created_at,client:clients(pacto_matricula,whatsapp)',
        created_at: `gte.${desdeIso}`,
        order: 'created_at.desc',
        limit: '2000',
    });
    return (linhas || []).map(r => ({
        created_at: r.created_at,
        matricula: r.client?.pacto_matricula ?? null,
        whatsapp: r.client?.whatsapp ?? null,
    }));
}

// Status/data/hora ATUAIS de alguns agendamentos — a lista local só é
// atualizada de hora em hora, e um cancelamento/remarcação feito na Agenda
// nesse meio tempo não pode receber cobrança.
async function buscarAgendamentosPorIds(ids, accessToken = null) {
    if (!ids.length) return [];
    const token = accessToken || await agendaLogin();
    return agendaGet(token, 'appointments', { select: 'id,status,date,time', id: `in.(${ids.join(',')})` });
}

module.exports = { agendaLogin, buscarAgendaDoDia, atualizarStatusAgendamento, buscarMQVsRecentes, buscarAgendamentosPorIds };
