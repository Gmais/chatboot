// =====================================
// CONSULTA AO GYMFIT (substitui as consultas de leitura que eram feitas na Pacto)
// =====================================
// Fala com /integrations/chatbot do GymFit (somente leitura, chave GYMFIT_API_KEY) e devolve os dados NO MESMO FORMATO que pacto.js
// devolvia (aluno.pessoa.nome, situacao.codigo === 'AT', parcelas com valor/vencida/dataVencimentoDt, contratos com vigenciaDe/
// vigenciaAteAjustada em epoch ms...), para o resto do chatbot continuar igual. Nomes das funções idênticos aos de pacto.js.
//
// Identificador do aluno = matrícula. O "código de pessoa" (aluno.pessoa.codigo) e o "código de cliente" (aluno.codigo) são a própria matrícula
// (número), então obterParcelasEmAberto(aluno.pessoa.codigo) e buscarAlunoPorCodigo(...) funcionam sem a Pacto.
//
// ATENÇÃO: o GymFit é a fonte; sem GYMFIT_API_KEY toda consulta falha com erro claro (o chatbot trata como "não consegui consultar").
// Nada novo para configurar: a chave é a MESMA GYMFIT_API_KEY que o GymFit já usa para falar com o chatbot (no GymFit é CHATBOOT_API_KEY), e o
// endereço padrão é o da API do GymFit (GYMFIT_URL só se precisar apontar para outro, ex.: testes).
const GYMFIT_BASE_URL = (process.env.GYMFIT_URL || 'https://gymfit-api-ten.vercel.app').replace(/\/+$/, '');
const GYMFIT_ACCESS_KEY = process.env.GYMFIT_API_KEY;
const GYMFIT_REQUEST_TIMEOUT_MS = 20000;

class GymfitNaoEncontrado extends Error {}
class GymfitErroDefinitivo extends Error {}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// GET com 1 nova tentativa para falha de rede ou 502/503/504 (a API do GymFit "acorda" na Vercel). 404 vira GymfitNaoEncontrado.
async function gymfitGet(path) {
    if (!GYMFIT_ACCESS_KEY) throw new GymfitErroDefinitivo('GymFit não configurado: defina GYMFIT_API_KEY.');
    let ultimoErro;
    for (let tentativa = 0; tentativa < 2; tentativa++) {
        if (tentativa > 0) await esperar(800);
        try {
            const res = await fetch(`${GYMFIT_BASE_URL}${path}`, {
                headers: { Authorization: `Bearer ${GYMFIT_ACCESS_KEY}`, Accept: 'application/json' },
                signal: AbortSignal.timeout(GYMFIT_REQUEST_TIMEOUT_MS)
            });
            if (res.status === 404) throw new GymfitNaoEncontrado('Aluno não encontrado no GymFit');
            if ([502, 503, 504].includes(res.status)) { ultimoErro = new Error(`GymFit indisponível (HTTP ${res.status})`); continue; }
            const texto = await res.text();
            let corpo = null;
            try { corpo = texto ? JSON.parse(texto) : null; } catch (_) { /* corpo não-JSON: segue com o texto cru na mensagem */ }
            if (!res.ok) throw new GymfitErroDefinitivo(corpo?.erro || texto || `Erro HTTP ${res.status} ao consultar o GymFit`);
            return corpo;
        } catch (e) {
            if (e instanceof GymfitNaoEncontrado || e instanceof GymfitErroDefinitivo) throw e; // resposta do GymFit (não repete)
            ultimoErro = e; // rede/timeout: tenta de novo uma vez
        }
    }
    throw ultimoErro;
}

// 'YYYY-MM-DD' -> epoch ms em America/Sao_Paulo (sem horário de verão desde 2019: -03:00). fimDoDia=true vale o último instante do dia.
const dataParaMs = (ymd, fimDoDia = false) => ymd ? new Date(`${String(ymd).slice(0, 10)}T${fimDoDia ? '23:59:59.999' : '00:00:00.000'}-03:00`).getTime() : null;
const dataBR = (ymd) => ymd ? String(ymd).slice(0, 10).split('-').reverse().join('/') : null;

const SITUACOES = {
    ativo: { codigo: 'AT', descricao: 'Ativo' },
    suspenso: { codigo: 'SU', descricao: 'Suspenso' },
    inativo: { codigo: 'IN', descricao: 'Inativo' }
};
const ROTULO_AFASTAMENTO = { ferias: 'férias', trancamento: 'trancamento', atestado: 'atestado' };

function converterAluno(a) {
    const base = SITUACOES[a.situacao] || SITUACOES.inativo;
    const situacao = a.situacao === 'suspenso' && a.afastamento
        ? { ...base, descricao: `Suspenso (${ROTULO_AFASTAMENTO[a.afastamento] || a.afastamento})` }
        : base;
    return {
        codigo: a.matricula,
        matricula: String(a.matricula).padStart(6, '0'),
        pessoa: {
            codigo: a.matricula,
            nome: a.nome,
            datanasc: a.nascimento || null,
            telefones: a.telefone ? [{ numero: a.telefone }] : []
        },
        situacao
    };
}

// Busca o cadastro do aluno pela matrícula. Retorna null se não houver aluno com essa matrícula.
async function buscarAlunoPorMatricula(matricula) {
    const numero = String(matricula ?? '').replace(/\D/g, '');
    if (!numero) return null;
    try {
        return converterAluno(await gymfitGet(`/integrations/chatbot/alunos/${numero}`));
    } catch (e) {
        if (e instanceof GymfitNaoEncontrado) return null;
        throw e;
    }
}

// Vínculos antigos guardam códigos da Pacto, que não valem no GymFit: por isso o fluxo do WhatsApp busca pela matrícula do vínculo.
// Esta função aceita a matrícula (que é o "código" do aluno no GymFit).
async function buscarAlunoPorCodigo(codigo) {
    return buscarAlunoPorMatricula(codigo);
}

// Parcelas em aberto (não pagas) — mesmo formato da Pacto: valor em reais, dataVencimento "DD/MM/AAAA", dataVencimentoDt em epoch ms.
async function obterParcelasEmAberto(codigoPessoa) {
    const numero = String(codigoPessoa ?? '').replace(/\D/g, '');
    if (!numero) return [];
    try {
        const { parcelas } = await gymfitGet(`/integrations/chatbot/alunos/${numero}/parcelas`);
        return (parcelas || []).map(p => ({
            descricao: p.descricao,
            valor: p.valor_centavos / 100,
            dataVencimento: dataBR(p.vencimento),
            dataVencimentoDt: dataParaMs(p.vencimento),
            vencida: !!p.vencida
        }));
    } catch (e) {
        if (e instanceof GymfitNaoEncontrado) return [];
        throw e;
    }
}

// Contratos ativos (vigente + renovações já lançadas). situacao 'AT' em todos (o GymFit só devolve os ativos); vigenciaAteAjustada = último
// instante do dia de término (já inclui bônus/férias/trancamento).
async function contratosDoAluno(matricula) {
    const numero = String(matricula ?? '').replace(/\D/g, '');
    if (!numero) return { aluno: null, contratos: [] };
    try {
        const r = await gymfitGet(`/integrations/chatbot/alunos/${numero}/contratos`);
        return { aluno: r.aluno || null, contratos: r.contratos || [] };
    } catch (e) {
        if (e instanceof GymfitNaoEncontrado) return { aluno: null, contratos: [] };
        throw e;
    }
}

async function obterContratosPorMatricula(matricula) {
    const { aluno, contratos } = await contratosDoAluno(matricula);
    return contratos.map(c => ({
        codigo: c.id,
        situacao: 'AT',
        vigenciaDe: dataParaMs(c.inicio),
        vigenciaAteAjustada: dataParaMs(c.fim, true),
        descricaoPlano: c.plano,
        pessoaDTO: { nome: aluno },
        // extras do GymFit, usados por obterDetalheContrato/obterOperacoesContrato
        _carenciaDias: c.dias_ferias_permitidos,
        _operacoes: c.operacoes || []
    }));
}

// O GymFit já devolveu tudo junto em obterContratosPorMatricula: guardamos por alguns segundos para o fluxo "contratos -> operações -> detalhe"
// (montarContextoContratoIA) não precisar chamar 3 vezes.
const cacheContratos = new Map(); // codigoContrato -> { em, contrato }
const CACHE_CONTRATO_MS = 60 * 1000;
const guardarContratos = (lista) => { const em = Date.now(); for (const c of lista) cacheContratos.set(c.codigo, { em, contrato: c }); };
const contratoDoCache = (codigo) => {
    const x = cacheContratos.get(codigo);
    return x && Date.now() - x.em < CACHE_CONTRATO_MS ? x.contrato : null;
};

const obterContratosPorMatriculaComCache = async (matricula) => {
    const lista = await obterContratosPorMatricula(matricula);
    guardarContratos(lista);
    return lista;
};

// Detalhe de um contrato: só o que o chatbot usa (contratoDuracao.carencia = dias de férias que o plano permite).
async function obterDetalheContrato(codigoContrato) {
    const c = contratoDoCache(codigoContrato);
    if (!c) return null;
    return { codigo: c.codigo, contratoDuracao: { carencia: c._carenciaDias ?? null } };
}

const TIPOS_OPERACAO = { ferias: 'Férias', trancamento: 'Trancamento', atestado: 'Atestado', bonus: 'Bônus' };

// Operações lançadas no contrato (férias, trancamento, atestado, bônus) — mesmos campos da Pacto.
async function obterOperacoesContrato(codigoContrato) {
    const c = contratoDoCache(codigoContrato);
    if (!c) return [];
    return c._operacoes.map(o => ({
        tipoOperacao: o.tipo,
        tipoOperacaoApresentar: TIPOS_OPERACAO[o.tipo] || o.tipo,
        diasOperacao: o.dias,
        dataInicioEfetivacaoOperacao: dataParaMs(o.inicio),
        dataFimEfetivacaoOperacao: dataParaMs(o.fim)
    }));
}

module.exports = {
    buscarAlunoPorMatricula, buscarAlunoPorCodigo, obterParcelasEmAberto,
    obterContratosPorMatricula: obterContratosPorMatriculaComCache,
    obterDetalheContrato, obterOperacoesContrato
};
