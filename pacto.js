// =====================================
// INTEGRAÇÃO COM A API DA PACTO SOLUÇÕES
// =====================================
const https = require('https');
const PACTO_BASE_URL = process.env.PACTO_API_BASE_URL;
const PACTO_API_KEY = process.env.PACTO_API_KEY;
const PACTO_EMPRESA_CODIGO = Number(process.env.PACTO_EMPRESA_CODIGO || 1);

// Usa o módulo https nativo em vez de fetch: o gateway da Pacto retorna 500
// (sem corpo) para requisições feitas via undici/fetch, mas responde
// normalmente a clientes http/1.1 "tradicionais" como curl ou https.request.
function pactoRequest(method, path, { params, body, headers } = {}) {
    const url = new URL(path, PACTO_BASE_URL);
    Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, value));
    const payload = body ? JSON.stringify(body) : null;

    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method,
            headers: {
                Authorization: `Bearer ${PACTO_API_KEY}`,
                Accept: '*/*',
                'User-Agent': 'curl/8.18.0',
                ...headers,
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                // Erro do gateway/Tomcat da Pacto às vezes vem como página HTML, não
                // JSON (ex: "Required request parameter 'pessoa'..."). Fazer
                // JSON.parse ANTES de checar o status code derrubava o processo
                // inteiro (SyntaxError não tratado dentro do callback do 'end' não
                // vira rejeição de Promise — é uma exceção não capturada de verdade,
                // crashava o servidor todo no meio de uma varredura de inadimplentes).
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    let mensagemErro = data || `Erro HTTP ${res.statusCode}`;
                    try {
                        const parsed = data ? JSON.parse(data) : null;
                        mensagemErro = parsed?.meta?.message || mensagemErro;
                    } catch (_) {
                        // corpo de erro não é JSON — usa o texto cru mesmo
                    }
                    reject(new Error(mensagemErro));
                    return;
                }
                try {
                    resolve(data ? JSON.parse(data) : null);
                } catch (e) {
                    reject(new Error(`Resposta da Pacto não é JSON válido: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const pactoGet = (path, params) => pactoRequest('GET', path, { params });
const pactoPost = (path, body) => pactoRequest('POST', path, { body });

// Busca o cadastro do aluno pelo número de matrícula.
// Retorna o primeiro resultado encontrado, ou null se não houver aluno com essa matrícula.
async function buscarAlunoPorMatricula(matricula) {
    const { content } = await pactoGet('/v1/cliente', { matricula, page: 0, size: 10 });
    if (!Array.isArray(content) || content.length === 0) return null;
    return content[0];
}

// Busca o cadastro do aluno pelo código interno de cliente (aluno.codigo).
async function buscarAlunoPorCodigo(codigo) {
    const { content } = await pactoGet(`/v1/cliente/${codigo}`);
    return content;
}

// Consulta as parcelas em aberto (débitos) de um aluno, a partir do código da pessoa
// (campo aluno.pessoa.codigo retornado por buscarAlunoPorMatricula/buscarAlunoPorCodigo).
async function obterParcelasEmAberto(codigoPessoa) {
    const { content } = await pactoGet('/cliente/obterParcelasEmAberto', { pessoa: codigoPessoa });
    return Array.isArray(content) ? content : [];
}

// Cria um novo cliente (cadastro). Não informe "codigo" — a API usa a ausência
// dele para diferenciar criação de atualização. Retorna o cliente já com
// matrícula e código gerados pela Pacto.
async function criarCliente({ nome, celular, cpf, email, cep, sexo, rg, bairro, dataNascimento }) {
    const { content } = await pactoPost('/v1/cliente', {
        nome,
        celular,
        cpf,
        email,
        cep,
        sexo,
        rg,
        bairro,
        dataNascimento,
        empresa: { codigo: PACTO_EMPRESA_CODIGO }
    });
    return Array.isArray(content) ? content[0] : content;
}

// Matricula um aluno já cadastrado em um contrato/plano. É preciso informar
// codigoMatricula (ou codigoChaveEstrangeira) do cliente retornado por
// criarCliente/buscarAlunoPorMatricula. Datas no formato DD/MM/YYYY.
async function matricularAluno({
    codigoMatricula, codigoChaveEstrangeira, consultor,
    dataCadastro, dataInicio, dataFinal, duracao,
    modalidades, valorContrato, valorMatricula, idExterno
}) {
    return pactoRequest('POST', '/importacao/contrato', {
        params: { empresa: PACTO_EMPRESA_CODIGO },
        body: {
            codigoMatricula, codigoChaveEstrangeira, consultor,
            dataCadastro, dataInicio, dataFinal, duracao,
            modalidades, valorContrato, valorMatricula, idExterno
        }
    });
}

// =====================================
// PAGAMENTO — COBRANÇA ONLINE VIA CAIXA EM ABERTO (Pix Santander)
// =====================================
// POST /pagamento/realizarCobrancaOnline é confirmado no Swagger oficial
// (api-docs.pactosolucoes.com.br, seção "Pagamento"): aceita convenio,
// movparcela e nrParcelas como query params. Exemplo de resposta documentado:
// { retorno: { status: "sucesso", transacaoId, valor } }.
//
// O QUE NÃO ESTÁ CONFIRMADO: se a resposta real traz também um link/QR Code
// do Pix, já que o exemplo do Swagger só mostra esses 3 campos — é comum a
// resposta real trazer mais campos do que o exemplo mínimo documentado.
// Não existe (pelo menos não achamos) um endpoint separado tipo
// "/pix/visualizar/{transacaoId}" — a seção Pix da doc é só "PIX Automático"
// (autorização de débito recorrente), uma feature diferente desta.
//
// Por isso esta função só faz a chamada e devolve a resposta CRUA, sem supor
// nenhum campo além do documentado. Use a rota /api/pacto/teste-pix ou o
// comando /testepix no WhatsApp com uma parcela de teste pra ver o JSON real
// e então decidir onde está o link/QR Code (ou se precisa de outro endpoint).
const PACTO_CONVENIO_PIX_SANTANDER = process.env.PACTO_CONVENIO_PIX_SANTANDER;

async function gerarLinkPagamentoPixSantander({ movparcela, nrParcelas = 1, convenio = PACTO_CONVENIO_PIX_SANTANDER } = {}) {
    if (!convenio) throw new Error('gerarLinkPagamentoPixSantander: defina PACTO_CONVENIO_PIX_SANTANDER no .env ou informe "convenio".');
    if (!movparcela) throw new Error('gerarLinkPagamentoPixSantander: "movparcela" é obrigatório.');

    return pactoRequest('POST', '/pagamento/realizarCobrancaOnline', {
        params: { convenio, movparcela, nrParcelas }
    });
}

// =====================================
// CRM — CARTEIRA DO DIA (fila de atendimento por consultor)
// =====================================
// Confirmado contra a API real da Pacto (controller carteira-dia-controller):
// todos os endpoints abaixo foram testados e retornaram dados/erros de
// negócio coerentes, não "rota não encontrada". A listagem individual de
// contatos (nomes/telefones dentro de cada categoria) ainda não foi
// localizada — por enquanto só temos o resumo por categoria (Faltosos,
// Grupo de Risco, Leads Hoje, etc.), não os contatos em si.
function empresaHeader(empresa) {
    return { empresaId: String(empresa || PACTO_EMPRESA_CODIGO) };
}

// Lista os colaboradores disponíveis para assumir uma carteira do dia.
async function listarColaboradoresCrm() {
    const { content } = await pactoRequest('GET', '/carteira-dia/colaboradores-substitutos', {
        headers: empresaHeader()
    });
    return Array.isArray(content) ? content : [];
}

// Abre (ou confirma que já existe) a carteira do dia de um colaborador.
// A API devolve HTTP 500 (!) quando a carteira já foi aberta hoje, mesmo
// isso sendo um caso esperado/idempotente — tratamos essa mensagem
// específica como sucesso em vez de propagar erro.
async function abrirCarteiraDia({ dia, codigoColaboradorResponsavel, usarEstudio = false, empresa } = {}) {
    if (!dia) throw new Error('abrirCarteiraDia: "dia" é obrigatório (formato YYYY-MM-DD).');
    if (!codigoColaboradorResponsavel) throw new Error('abrirCarteiraDia: "codigoColaboradorResponsavel" é obrigatório.');
    try {
        return await pactoRequest('POST', '/carteira-dia/calcular-meta-dia', {
            headers: empresaHeader(empresa),
            body: { dia, codigoColaboradorResponsavel, usarEstudio }
        });
    } catch (e) {
        if (e.message && e.message.includes('já foi cadastrada')) return { jaAberta: true };
        throw e;
    }
}

// Consulta o resumo (por categoria) da carteira do dia mais recente de um colaborador.
async function consultarCarteiraDia({ codigoColaborador, empresa } = {}) {
    if (!codigoColaborador) throw new Error('consultarCarteiraDia: "codigoColaborador" é obrigatório.');
    const { content } = await pactoRequest('GET', '/carteira-dia/ultima-abertura', {
        headers: empresaHeader(empresa),
        params: { codigoColaborador }
    });
    return content;
}

module.exports = {
    buscarAlunoPorMatricula, buscarAlunoPorCodigo, obterParcelasEmAberto,
    criarCliente, matricularAluno,
    gerarLinkPagamentoPixSantander,
    listarColaboradoresCrm, abrirCarteiraDia, consultarCarteiraDia
};
