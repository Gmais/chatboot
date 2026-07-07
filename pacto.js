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
function pactoRequest(method, path, { params, body } = {}) {
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
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                const responseBody = data ? JSON.parse(data) : null;
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(responseBody?.meta?.message || data || `Erro HTTP ${res.statusCode}`));
                    return;
                }
                resolve(responseBody);
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
// PAGAMENTO — LINK PIX VIA CAIXA EM ABERTO (EXPERIMENTAL, NÃO CONFIRMADO PELA PACTO)
// =====================================
// Encadeamento hipotético levantado a partir da doc pública
// (api-docs.pactosolucoes.com.br), NÃO confirmado com o suporte/gerente de
// conta da Pacto:
//   1) POST /pagamento/realizarCobrancaOnline -> retorna transacaoId
//   2) GET  /pix/visualizar/{token}           -> usa o transacaoId como token
// Antes de usar em produção: validar esse encadeamento com a Pacto e testar
// contra uma parcela de homologação. O formato de resposta de
// /pix/visualizar/{token} não está documentado com exemplo — o campo "pix"
// devolvido abaixo pode precisar de ajuste após o primeiro teste real.
const PACTO_CONVENIO_PIX_SANTANDER = process.env.PACTO_CONVENIO_PIX_SANTANDER;

async function gerarLinkPagamentoPixSantander({ movparcela, nrParcelas = 1, convenio = PACTO_CONVENIO_PIX_SANTANDER } = {}) {
    if (!convenio) throw new Error('gerarLinkPagamentoPixSantander: defina PACTO_CONVENIO_PIX_SANTANDER no .env ou informe "convenio".');
    if (!movparcela) throw new Error('gerarLinkPagamentoPixSantander: "movparcela" é obrigatório.');

    const cobranca = await pactoRequest('POST', '/pagamento/realizarCobrancaOnline', {
        params: { convenio, movparcela, nrParcelas }
    });

    const transacaoId = cobranca?.retorno?.transacaoId;
    if (cobranca?.retorno?.status !== 'sucesso' || !transacaoId) {
        throw new Error(`Falha ao realizar cobrança online: ${JSON.stringify(cobranca)}`);
    }

    const pix = await pactoRequest('GET', `/pix/visualizar/${transacaoId}`);
    return { transacaoId, valor: cobranca.retorno.valor, pix };
}

// Variante para obter o QR Code em vez do link de visualização.
async function gerarQrCodePixSantander(opcoes) {
    const { transacaoId, valor } = await gerarLinkPagamentoPixSantander(opcoes);
    const qrcode = await pactoRequest('GET', `/pix/qrcode/${transacaoId}`);
    return { transacaoId, valor, qrcode };
}

module.exports = {
    buscarAlunoPorMatricula, buscarAlunoPorCodigo, obterParcelasEmAberto,
    criarCliente, matricularAluno,
    gerarLinkPagamentoPixSantander, gerarQrCodePixSantander
};
