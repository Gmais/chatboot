// =====================================
// PATCH (deve rodar ANTES de qualquer require do whatsapp-web.js)
// Ignora erro "already exists" ao registrar funções do Puppeteer.
// Ocorre quando whatsapp-web.js reexpõe os mesmos bindings (ex: onAddMessageEvent,
// onAuthAppStateChangedEvent) durante reinicializações internas do Store.
//
// Já tentamos duas variações "mais espertas" disso (upsert via
// removeExposedFunction) — uma causou crash loop, outra quebrou o pareamento
// (celular linkava mas o robô nunca recebia o evento). Esta é a versão
// ORIGINAL, simples, que comprovadamente funcionou (conectou e trocou
// mensagens de verdade). Fica como está — não mexer sem motivo forte.
// =====================================
try {
    const wwebPup = require('./node_modules/whatsapp-web.js/src/util/Puppeteer');
    const _orig = wwebPup.exposeFunctionIfAbsent;
    wwebPup.exposeFunctionIfAbsent = async (page, name, func) => {
        try {
            await _orig(page, name, func);
        } catch (e) {
            if (!e.message || !e.message.includes('already exists')) throw e;
            // Ignora silenciosamente - binding da sessão anterior ainda funciona para receber eventos
        }
    };
    console.log('✅ Patch aplicado (removeBinding via CDP).');
} catch (_) {}

// =====================================
// PATCH 2 — CAUSA RAIZ do "conecta mas para de receber mensagem depois de um tempo"
// whatsapp-web.js religa TODOS os listeners (attachEventListeners, incluindo
// onAddMessageEvent) toda vez que a página dispara 'framenavigated' — o que
// acontece várias vezes sozinho, sem que a gente peça, enquanto o WhatsApp Web
// resincroniza em segundo plano. Cada religação corre o risco de colidir com
// a anterior (fica no ar entre remover e recriar o binding no Puppeteer) e
// deixar o robô sem NENHUM listener funcional de mensagem — sem erro, sem log,
// só silêncio. Como nosso processo nunca reaproveita o mesmo Client após um
// logout de verdade (sempre reinicia o container), os listeners só PRECISAM
// ser ligados uma vez por processo. Trava attachEventListeners para rodar só
// na primeira vez e ignorar as reinicializações redundantes seguintes.
// =====================================
try {
    const ClientClass = require('./node_modules/whatsapp-web.js/src/Client');
    const _origAttach = ClientClass.prototype.attachEventListeners;
    ClientClass.prototype.attachEventListeners = async function (...args) {
        if (this._listenersJaAnexados) return;
        try {
            await _origAttach.apply(this, args);
            this._listenersJaAnexados = true; // só marca como feito se realmente completou sem erro
        } catch (e) {
            console.error('🧨 [attachEventListeners falhou]', e.message);
            throw e;
        }
    };
    console.log('✅ Patch 2 aplicado (attachEventListeners roda só 1x por processo).');
} catch (_) {}

// =====================================
// IMPORTAÇÕES
// =====================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const qrcode = require('qrcode');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const multer = require('multer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const OpenAI = require('openai');
const moment = require('moment-timezone');
const { buscarAlunoPorMatricula, buscarAlunoPorCodigo, obterParcelasEmAberto, criarCliente, matricularAluno, gerarLinkPagamentoPixSantander, listarColaboradoresCrm, abrirCarteiraDia, consultarCarteiraDia } = require('./pacto');

// =====================================
// REDE DE SEGURANÇA — exceção não tratada nunca derruba o servidor inteiro
// =====================================
// Já aconteceu de verdade: um erro de rede (Pacto devolveu HTML de erro onde
// o código esperava JSON) virou uma exceção não capturada dentro de um
// callback assíncrono (res.on('end', ...)) — isso não é "erro tratado" nem
// vira rejeição de Promise, é uma exceção de verdade que sobe até o topo do
// processo Node e mata TUDO, inclusive a sessão do WhatsApp e o servidor
// HTTP, no meio de uma varredura de inadimplentes. Mesma filosofia do fix
// anterior pro crash do Puppeteer (site não pode cair por causa de UM erro
// pontual em UMA operação) — aqui é a versão genérica disso, pra qualquer
// bug futuro parecido não derrubar o site de novo. Loga bem alto e segue
// vivo; o correto é sempre corrigir a causa raiz (como fizemos no pacto.js),
// isso aqui é só o último cinto de segurança.
process.on('uncaughtException', (err) => {
    console.error('🧨🧨🧨 [UNCAUGHT EXCEPTION] O processo quase caiu por isso:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('🧨🧨🧨 [UNHANDLED REJECTION] Promise rejeitada sem tratamento:', reason);
});

// =====================================
// CONFIGURAÇÃO DO SERVIDOR WEB E SOCKET.IO
// =====================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Upload de Mídia (Multer)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB
// Importação de contatos via planilha CSV — fica só em memória, nunca salva no disco
const uploadCsv = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// =====================================
// BANCO DE DADOS (SQLite)
// =====================================
let db;
let stats = { received: 0, sent: 0, leads: 0 };
const leadsSet = new Set();

// IDs de mensagens que o próprio sistema já enviou e registrou em "conversas"
// (bot, dashboard, fluxos). Usado pelo listener message_create pra distinguir
// isso de mensagens mandadas direto pelo celular/WhatsApp Web vinculado, que
// também precisam aparecer no Bate Papo ao Vivo mas ainda não foram salvas.
const idsMensagensDoSistema = new Set();
function marcarMensagemComoDoSistema(msgId) {
    if (!msgId) return;
    idsMensagensDoSistema.add(msgId);
    // O message_create correspondente chega quase instantaneamente — 60s de
    // janela é sobra, evita a Set crescer pra sempre.
    setTimeout(() => idsMensagensDoSistema.delete(msgId), 60000);
}

// Em produção (Railway), aponta para o volume persistente; localmente, usa a pasta do projeto.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = path.join(DATA_DIR, 'database.sqlite');

// public/uploads fica DENTRO da imagem do container — em todo deploy novo ele
// volta a ser só o .gitkeep do repositório, apagando qualquer mídia enviada
// (Regras, Fluxos, Automação). Guarda os arquivos de verdade no volume
// persistente e troca public/uploads por um link simbólico pra lá — assim todo
// o resto do código (que já espera path.join(__dirname,'public','uploads',...)
// e URLs /uploads/...) continua funcionando sem precisar mudar nada.
(function garantirUploadsPersistentes() {
    const uploadsReal = path.join(DATA_DIR, 'uploads');
    const uploadsLink = path.join(__dirname, 'public', 'uploads');
    fs.mkdirSync(uploadsReal, { recursive: true });
    try {
        if (fs.lstatSync(uploadsLink).isSymbolicLink()) return; // já está linkado
        fs.rmSync(uploadsLink, { recursive: true, force: true });
    } catch (e) { /* uploadsLink ainda não existe — segue pro symlink */ }
    try {
        fs.symlinkSync(uploadsReal, uploadsLink, 'dir');
        console.log('📎 public/uploads agora aponta pro volume persistente.');
    } catch (e) {
        console.error('⚠️ Não foi possível persistir uploads:', e.message);
    }
})();

const DEFAULT_RESPONSE_TEXT = `{saudacao}! 👋\n\nEssa mensagem foi enviada automaticamente pelo robô 🤖\n\nNa versão PRO você vai além: desbloqueie tudo!.\n\n✍️ Envio de textos\n🎙️ Áudios\n🖼️ Imagens\n🎥 Vídeos\n📂 Arquivos\n\n💡 Simulação de "digitando..." e "gravando áudio"\n🚀 Envio de mensagens em massa\n📇 Captura automática de contatos\n💻 Aprenda como deixar o robô funcionando 24 hrs, com o PC desligado\n✅ E 3 Bônus exclusivos\n\n🔥 Adquira a versão PRO agora: https://pay.kiwify.com.br/FkTOhRZ?src=pro`;

async function initDB() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS leads (
            telefone TEXT PRIMARY KEY,
            data_captura DATETIME DEFAULT CURRENT_TIMESTAMP,
            mensagens_recebidas INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS stats (
            id INTEGER PRIMARY KEY,
            sent INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS mensagens_enviadas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telefone TEXT NOT NULL,
            texto TEXT NOT NULL,
            ts DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS respostas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            keywords TEXT NOT NULL,
            resposta TEXT NOT NULL,
            ativo INTEGER DEFAULT 1,
            ordem INTEGER DEFAULT 99,
            enviar_audio INTEGER DEFAULT 0,
            media_path TEXT DEFAULT NULL,
            media_tipo TEXT DEFAULT NULL
        );
        CREATE TABLE IF NOT EXISTS configuracoes (
            chave TEXT PRIMARY KEY,
            valor TEXT
        );
        CREATE TABLE IF NOT EXISTS vinculo_pacto (
            telefone TEXT PRIMARY KEY,
            codigo_cliente INTEGER NOT NULL,
            codigo_pessoa INTEGER NOT NULL,
            matricula TEXT,
            nome TEXT,
            data_vinculo DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS conversas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telefone TEXT NOT NULL,
            nome TEXT,
            direcao TEXT NOT NULL,
            texto TEXT,
            tipo TEXT DEFAULT 'text',
            ts DATETIME DEFAULT CURRENT_TIMESTAMP,
            lida INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_conversas_tel ON conversas(telefone, ts);
        CREATE INDEX IF NOT EXISTS idx_conversas_ts ON conversas(ts DESC);
        CREATE TABLE IF NOT EXISTS horarios_atendimento (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dias TEXT NOT NULL,
            inicio TEXT NOT NULL,
            fim TEXT NOT NULL,
            modo TEXT NOT NULL DEFAULT 'robo'
        );
        CREATE TABLE IF NOT EXISTS etiquetas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL UNIQUE,
            cor TEXT NOT NULL DEFAULT '#25D366'
        );
        CREATE TABLE IF NOT EXISTS contato_etiquetas (
            telefone TEXT NOT NULL,
            etiqueta_id INTEGER NOT NULL,
            PRIMARY KEY (telefone, etiqueta_id)
        );
        CREATE INDEX IF NOT EXISTS idx_contato_etiquetas_telefone ON contato_etiquetas(telefone);
        CREATE TABLE IF NOT EXISTS conversas_humano (
            telefone TEXT PRIMARY KEY,
            assumida_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS fluxos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            gatilho TEXT,
            flow_data TEXT NOT NULL,
            ativo INTEGER DEFAULT 1,
            criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS contato_estado_fluxo (
            telefone TEXT PRIMARY KEY,
            fluxo_id INTEGER NOT NULL,
            current_node_id TEXT,
            variaveis TEXT DEFAULT '{}',
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS conversas_status (
            telefone TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'aberta',
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS automacoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            etiqueta_id INTEGER NOT NULL,
            ativo INTEGER DEFAULT 1,
            criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS automacao_etapas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            automacao_id INTEGER NOT NULL,
            ordem INTEGER NOT NULL,
            texto TEXT,
            media_path TEXT,
            media_tipo TEXT,
            dias_proxima_etapa INTEGER DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_automacao_etapas_automacao ON automacao_etapas(automacao_id, ordem);
        CREATE TABLE IF NOT EXISTS automacao_etapa_grupos (
            etapa_id INTEGER NOT NULL,
            etiqueta_id INTEGER NOT NULL,
            PRIMARY KEY (etapa_id, etiqueta_id)
        );
        CREATE TABLE IF NOT EXISTS automacao_etapa_mensagens (
            etapa_id INTEGER NOT NULL,
            mensagem_id INTEGER NOT NULL,
            PRIMARY KEY (etapa_id, mensagem_id)
        );
        CREATE TABLE IF NOT EXISTS contato_automacao_estado (
            telefone TEXT NOT NULL,
            automacao_id INTEGER NOT NULL,
            etapa_atual INTEGER NOT NULL DEFAULT 1,
            entrou_em DATETIME DEFAULT CURRENT_TIMESTAMP,
            proxima_execucao_em DATETIME,
            PRIMARY KEY (telefone, automacao_id)
        );
        CREATE INDEX IF NOT EXISTS idx_contato_automacao_proxima ON contato_automacao_estado(proxima_execucao_em);
        -- Histórico de envios já efetivados por uma automação. contato_automacao_estado
        -- é a FILA (quem ainda vai receber) e perde a linha assim que manda com sucesso
        -- (ver dispararMensagensDaAutomacao) — esse log é só pra mostrar "quem já
        -- recebeu, quando e qual mensagem" na tela de acompanhamento, sem mexer em
        -- nenhuma contagem/lógica existente da fila.
        CREATE TABLE IF NOT EXISTS automacao_envios_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            automacao_id INTEGER NOT NULL,
            telefone TEXT NOT NULL,
            nome TEXT,
            mensagem_nome TEXT,
            enviado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_automacao_envios_log_automacao ON automacao_envios_log(automacao_id, enviado_em);
        CREATE TABLE IF NOT EXISTS mensagens_personalizadas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            texto TEXT NOT NULL,
            media_path TEXT,
            media_tipo TEXT,
            horario_envio TEXT NOT NULL DEFAULT '09:00',
            ativo INTEGER DEFAULT 1,
            total_enviados INTEGER DEFAULT 0,
            criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS mensagem_personalizada_enviada (
            mensagem_id INTEGER NOT NULL,
            telefone TEXT NOT NULL,
            ano INTEGER NOT NULL,
            enviado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (mensagem_id, telefone, ano)
        );
        CREATE TABLE IF NOT EXISTS pacto_inadimplentes (
            telefone TEXT PRIMARY KEY,
            nome TEXT,
            matricula TEXT,
            qtd_parcelas_atrasadas INTEGER,
            valor_total_atrasado REAL,
            dias_atraso_mais_antiga INTEGER,
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Adiciona colunas novas se migrando de versão anterior
    try { await db.exec(`ALTER TABLE respostas ADD COLUMN media_path TEXT DEFAULT NULL`); } catch(e) {}
    try { await db.exec(`ALTER TABLE respostas ADD COLUMN media_tipo TEXT DEFAULT NULL`); } catch(e) {}
    try { await db.exec(`ALTER TABLE respostas ADD COLUMN etiqueta_id INTEGER DEFAULT NULL`); } catch(e) {}
    // Nome do contato importado via planilha (antes de ele mandar a primeira mensagem)
    try { await db.exec(`ALTER TABLE leads ADD COLUMN nome TEXT DEFAULT NULL`); } catch(e) {}
    try { await db.exec(`ALTER TABLE leads ADD COLUMN origem TEXT DEFAULT NULL`); } catch(e) {}
    // Matrícula editada manualmente na Audiência — separada de vinculo_pacto (que
    // exige codigo_cliente/codigo_pessoa) pra permitir contato sem vínculo formal
    // com o Pacto ainda assim ter uma matrícula cadastrada (mesmo padrão do nome).
    try { await db.exec(`ALTER TABLE leads ADD COLUMN matricula TEXT DEFAULT NULL`); } catch(e) {}
    try { await db.exec(`ALTER TABLE leads ADD COLUMN data_nascimento TEXT DEFAULT NULL`); } catch(e) {}
    // Se a etapa tem mensagens da biblioteca (Mensagens Personalizadas) anexadas
    // e mais de uma, manda uma diferente por contato em vez de sempre a mesma.
    try { await db.exec(`ALTER TABLE automacao_etapas ADD COLUMN envio_aleatorio INTEGER DEFAULT 0`); } catch(e) {}
    // Mensagem sorteada (de entre as anexadas nas etapas da automação) que
    // esse contato específico vai receber quando o disparo dessa automação
    // rodar em Disparos — cada contato recebe UMA, escolhida na hora do
    // disparo se ainda não tiver uma atribuída, e mantém a mesma depois.
    try { await db.exec(`ALTER TABLE contato_automacao_estado ADD COLUMN mensagem_id INTEGER DEFAULT NULL`); } catch(e) {}
    // Guarda o motivo da última falha de envio (ex: "número não tem WhatsApp",
    // timeout) pra mostrar na tela de acompanhamento — antes só ficava no log
    // do servidor, staff não tinha como saber por que um contato específico
    // nunca recebe a mensagem sem pedir pra checar o Railway.
    try { await db.exec(`ALTER TABLE contato_automacao_estado ADD COLUMN ultimo_erro TEXT DEFAULT NULL`); } catch(e) {}
    // Janela de horário permitida pra automação mandar mensagem (HH:mm) — vazio = sem restrição
    try { await db.exec(`ALTER TABLE automacoes ADD COLUMN horario_inicio TEXT DEFAULT NULL`); } catch(e) {}
    try { await db.exec(`ALTER TABLE automacoes ADD COLUMN horario_fim TEXT DEFAULT NULL`); } catch(e) {}
    // Se, ao concluir a última etapa, a etiqueta que disparou a automação some do contato (padrão: sim)
    try { await db.exec(`ALTER TABLE automacoes ADD COLUMN remove_etiqueta_ao_concluir INTEGER DEFAULT 1`); } catch(e) {}
    // Contador histórico de quantos contatos já terminaram a automação inteira
    try { await db.exec(`ALTER TABLE automacoes ADD COLUMN total_concluidos INTEGER DEFAULT 0`); } catch(e) {}
    // Unidade do "Aguardar X" de cada etapa — 'dias' (produção) ou 'horas' (testar rápido)
    try { await db.exec(`ALTER TABLE automacao_etapas ADD COLUMN unidade_tempo TEXT DEFAULT 'dias'`); } catch(e) {}
    // Distingue mensagem enviada pelo robô (regra/IA/automação/fluxo) de mensagem
    // digitada por um atendente humano (dashboard ou direto no celular vinculado)
    // — mostra o rótulo certo ("🤖 Bot" vs "👤 Atendente") no Bate Papo ao Vivo.
    try { await db.exec(`ALTER TABLE conversas ADD COLUMN manual INTEGER DEFAULT 0`); } catch(e) {}
    // Etiqueta temporária (ex: "Desafio 30 dias"): duracao_dias define quanto
    // tempo ela dura DESDE QUE APLICADA em CADA contato — a etiqueta em si
    // nunca "acaba" (continua existindo pra aplicar em gente nova), só a
    // vinculação com aquele contato específico expira sozinha. NULL = etiqueta
    // permanente (comportamento de sempre, sem mudança pra etiquetas atuais).
    try { await db.exec(`ALTER TABLE etiquetas ADD COLUMN duracao_dias INTEGER DEFAULT NULL`); } catch(e) {}
    try { await db.exec(`ALTER TABLE contato_etiquetas ADD COLUMN expira_em DATETIME DEFAULT NULL`); } catch(e) {}
    // Garante tabela conversas em instalações antigas
    try { await db.exec(`CREATE TABLE IF NOT EXISTS conversas (id INTEGER PRIMARY KEY AUTOINCREMENT, telefone TEXT NOT NULL, nome TEXT, direcao TEXT NOT NULL, texto TEXT, tipo TEXT DEFAULT 'text', ts DATETIME DEFAULT CURRENT_TIMESTAMP, lida INTEGER DEFAULT 0)`); } catch(e) {}
    try { await db.exec(`CREATE INDEX IF NOT EXISTS idx_conversas_tel ON conversas(telefone, ts)`); } catch(e) {}
    try { await db.exec(`CREATE INDEX IF NOT EXISTS idx_conversas_ts ON conversas(ts DESC)`); } catch(e) {}
    // Limpa contatos falsos de canais/listas de transmissão (@broadcast) que
    // entraram antes do filtro cobrir esse padrão — poluíam a lista de Conversas.
    try { await db.exec(`DELETE FROM conversas WHERE telefone LIKE '%@broadcast'`); } catch(e) {}
    try { await db.exec(`DELETE FROM leads WHERE telefone LIKE '%@broadcast'`); } catch(e) {}

    // stats.sent reflete a contagem real de mensagens registradas em mensagens_enviadas,
    // não mais um contador solto — assim o número do dashboard sempre bate com o histórico exibido.
    const sentCountRow = await db.get('SELECT COUNT(*) as count FROM mensagens_enviadas');
    stats.sent = sentCountRow.count;

    const leadsRows = await db.all('SELECT telefone, mensagens_recebidas FROM leads');
    leadsRows.forEach(row => { leadsSet.add(row.telefone); stats.received += row.mensagens_recebidas; });
    stats.leads = leadsSet.size;

    const respostasCount = await db.get('SELECT COUNT(*) as count FROM respostas');
    if (respostasCount.count === 0) {
        await db.run('INSERT INTO respostas (keywords, resposta, ativo, ordem, enviar_audio) VALUES (?, ?, 1, 1, 1)',
            ['oi,olá,ola,menu,bom dia,boa tarde,boa noite', DEFAULT_RESPONSE_TEXT]);
        console.log('✅ Regra padrão de resposta criada no banco.');
    }

    console.log(`📦 Banco de dados carregado. Leads: ${stats.leads}`);
}

// Cache de nomes de contatos para evitar chamadas repetidas ao WhatsApp
const nomeContatos = new Map();

async function resolverNomeContato(telefone) {
    const num = telefone.replace('@c.us','').replace('@lid','');
    if (nomeContatos.has(num)) return nomeContatos.get(num);
    try {
        const vinculo = await db.get('SELECT nome FROM vinculo_pacto WHERE telefone LIKE ?', [`%${num}%`]);
        if (vinculo?.nome) { nomeContatos.set(num, vinculo.nome); return vinculo.nome; }
    } catch(_) {}
    try {
        // Contato criado manualmente ou importado por planilha — nunca mandou
        // mensagem, então não tem pushname nem entrada em vinculo_pacto, mas já
        // tem nome cadastrado em leads (mesma fonte usada na tela de Contatos).
        const lead = await db.get(
            'SELECT nome FROM leads WHERE telefone = ? OR telefone = ? OR telefone = ?',
            [num, `${num}@c.us`, `${num}@lid`]
        );
        if (lead?.nome) { nomeContatos.set(num, lead.nome); return lead.nome; }
    } catch(_) {}
    return num;
}

// Matrícula do aluno, pro placeholder {matricula} em Regras/Fluxos/Automação —
// vem do mesmo vínculo com o CRM Pacto usado na coluna Matrícula de Contatos.
// Sem vínculo (contato que nunca se matriculou/nunca conversou sobre isso),
// devolve string vazia — o placeholder some da mensagem em vez de mostrar "null".
const matriculaContatos = new Map();
async function resolverMatriculaContato(telefone) {
    const num = telefone.replace('@c.us','').replace('@lid','');
    if (matriculaContatos.has(num)) return matriculaContatos.get(num);
    try {
        // Matrícula digitada manualmente em Contatos tem prioridade (mesma regra
        // usada na coluna Matrícula da tela de Contatos); sem isso, cai pro vínculo
        // automático com o CRM Pacto.
        const lead = await db.get(
            'SELECT matricula FROM leads WHERE telefone = ? OR telefone = ? OR telefone = ?',
            [num, `${num}@c.us`, `${num}@lid`]
        );
        if (lead?.matricula) { matriculaContatos.set(num, lead.matricula); return lead.matricula; }
    } catch (_) {}
    try {
        const vinculo = await db.get('SELECT matricula FROM vinculo_pacto WHERE telefone LIKE ?', [`%${num}%`]);
        const matricula = vinculo?.matricula || '';
        matriculaContatos.set(num, matricula);
        return matricula;
    } catch (_) { return ''; }
}

// SQLite CURRENT_TIMESTAMP grava 'YYYY-MM-DD HH:MM:SS' em UTC mas sem indicador
// de fuso — se mandar essa string crua pro navegador, o JS interpreta como hora
// LOCAL (não UTC) e o horário mostrado fica adiantado (no Brasil, 3h a mais).
// Usa isso em toda coluna DATETIME lida direto do banco antes de mandar pro front.
function sqliteTsParaIso(ts) {
    if (!ts) return ts;
    return ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
}

// Lista branca de tipos de mensagem "de verdade" (conversa real) — qualquer
// msg.type fora daqui é ruído de protocolo do WhatsApp (sincronização entre
// aparelhos, notificação de criptografia, mensagem que falhou ao decifrar,
// etc.) e nunca deve virar conversa no Bate Papo ao Vivo. Whitelist em vez de
// blacklist: mais seguro, não depende de prever cada tipo novo de ruído.
const TIPOS_MSG_VALIDOS = new Set(['chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'vcard', 'multi_vcard']);

// Detecta o tipo de uma mensagem do whatsapp-web.js a partir de msg.type.
// Compartilhado entre o handler de recebidas e o de enviadas (message_create).
function detectarTipoMsg(msg) {
    if (msg.type === 'image') return 'image';
    if (msg.type === 'audio' || msg.type === 'ptt') return 'audio';
    if (msg.type === 'video') return 'video';
    if (msg.type === 'document') return 'document';
    if (msg.type === 'sticker') return 'sticker';
    if (msg.type === 'location') return 'location';
    if (msg.type === 'vcard' || msg.type === 'multi_vcard') return 'contact';
    return 'text';
}

// Texto de exibição quando a mensagem não tem corpo (msg.body vazio) — evita
// mostrar o placeholder cru "[text]" pra tipos que a gente não trata melhor.
const TIPO_LABEL_FALLBACK = {
    image: '[imagem]', audio: '[áudio]', video: '[vídeo]', document: '[documento]',
    sticker: '[figurinha]', location: '[localização]', contact: '[contato compartilhado]',
    text: '[mensagem sem texto]'
};

// Salva mensagem na tabela de conversas (in ou out) e emite evento Socket.IO
// tsReal (opcional): timestamp de verdade do WhatsApp (msg.timestamp, em
// segundos) — quando informado, usa esse em vez de "agora". Sem isso, uma
// mensagem sincronizada em lote (ex: reconexão trazendo histórico) fica com
// o horário de quando o robô processou, não o horário real da mensagem.
async function salvarNaConversa(telefone, nome, direcao, texto, tipo = 'text', tsReal = null, manual = false) {
    const num = telefone.replace('@c.us','').replace('@lid','');
    const ts = tsReal ? new Date(tsReal * 1000).toISOString() : new Date().toISOString();
    const lida = direcao === 'out' ? 1 : 0;
    await db.run(
        'INSERT INTO conversas (telefone, nome, direcao, texto, tipo, ts, lida, manual) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [num, nome || num, direcao, texto, tipo, ts, lida, manual ? 1 : 0]
    );
    // Conta não lidas deste telefone
    const naoLidas = await db.get('SELECT COUNT(*) as c FROM conversas WHERE telefone=? AND lida=0 AND direcao="in"', num);
    io.emit('nova_mensagem', { telefone: num, nome: nome || num, texto, direcao, tipo, ts, nao_lidas: naoLidas.c, manual });

    // Qualquer mensagem nova (do cliente OU pro cliente — bot, automação, fluxo,
    // envio manual) reabre a conversa se ela tinha sido finalizada. "Finalizada"
    // significa "não precisa mais de atenção agora"; uma interação nova, em
    // qualquer direção, contraria isso.
    const statusAtual = await db.get('SELECT status FROM conversas_status WHERE telefone = ?', num);
    if (statusAtual?.status === 'fechada') {
        await db.run(
            "INSERT INTO conversas_status (telefone, status, atualizado_em) VALUES (?, 'aberta', CURRENT_TIMESTAMP) ON CONFLICT(telefone) DO UPDATE SET status = 'aberta', atualizado_em = CURRENT_TIMESTAMP",
            num
        );
        io.emit('conversa_status_atualizada', { telefone: num, status: 'aberta' });
    }
}

// Registra no histórico permanente cada mensagem realmente enviada pelo robô.
// É a única fonte da contagem "Mensagens Enviadas" — se está no contador, está nesta tabela.
async function registrarMensagemEnviada(telefone, texto, nome, msgId = null, manual = false) {
    const numeroLimpo = telefone.replace('@c.us', '').replace('@lid', '');
    marcarMensagemComoDoSistema(msgId);
    await db.run('INSERT INTO mensagens_enviadas (telefone, texto) VALUES (?, ?)', [numeroLimpo, texto]);
    stats.sent++;
    await salvarNaConversa(numeroLimpo, nome, 'out', texto, 'text', null, manual);
    io.emit('message_out', { to: numeroLimpo, text: texto, ts: Date.now() });
    io.emit('stats', stats);
}

async function registerLead(telefone) {
    stats.received++;
    if (!leadsSet.has(telefone)) {
        leadsSet.add(telefone);
        stats.leads++;
        await db.run('INSERT INTO leads (telefone) VALUES (?)', telefone);
        io.emit('new_lead', { telefone, data_captura: new Date().toISOString() });
    } else {
        await db.run('UPDATE leads SET mensagens_recebidas = mensagens_recebidas + 1 WHERE telefone = ?', telefone);
    }
    io.emit('stats', stats);
}

// =====================================
// OVERRIDE MANUAL — BOTÃO "ATIVAR ROBÔ"
// =====================================
// Permite à recepcionista assumir manualmente por um tempo (ex: foi ao banheiro,
// foi ao mercado) e devolver o atendimento ao robô sem mexer nas faixas de
// horário configuradas. Tem prioridade sobre qualquer faixa/modo padrão.
async function obterOverrideRobo() {
    const rows = await db.all("SELECT * FROM configuracoes WHERE chave IN ('override_robo_ate','override_robo_indeterminado')");
    const config = {};
    rows.forEach(r => config[r.chave] = r.valor);
    const indeterminado = config.override_robo_indeterminado === 'true';
    const ate = config.override_robo_ate ? Number(config.override_robo_ate) : null;
    const ativo = indeterminado || (ate !== null && Date.now() < ate);
    return { ativo, indeterminado: ativo && indeterminado, ate: (ativo && !indeterminado) ? ate : null };
}

// =====================================
// HORÁRIO DE FUNCIONAMENTO
// =====================================
// Define, por faixa de horário, quem atende: "robo" (resposta automática) ou
// "humano" (mensagem só fica registrada em Conversas, para responder na mão).
// Usa moment-timezone porque o servidor (Railway) roda fisicamente nos EUA —
// comparar com a hora local do processo (new Date()) daria o horário errado.
const ultimaMsgModoHumano = new Map(); // telefone -> data (YYYY-MM-DD) do último aviso enviado

// Uma faixa "cobre" o momento atual mesmo quando cruza a meia-noite (ex: 21:00-07:00):
// nesse caso ela pertence ao dia em que COMEÇA, então também precisa valer nas
// primeiras horas do dia seguinte.
function faixaCobreAgora(faixa, diaAtual, diaAnterior, minutoAtual) {
    const dias = faixa.dias.split(',').filter(Boolean).map(Number);
    const [hIni, mIni] = faixa.inicio.split(':').map(Number);
    const [hFim, mFim] = faixa.fim.split(':').map(Number);
    const minutoIni = hIni * 60 + mIni;
    const minutoFim = hFim * 60 + mFim;
    if (minutoIni < minutoFim) {
        return dias.includes(diaAtual) && minutoAtual >= minutoIni && minutoAtual < minutoFim;
    }
    return (dias.includes(diaAtual) && minutoAtual >= minutoIni) ||
           (dias.includes(diaAnterior) && minutoAtual < minutoFim);
}

// Resolve quem deve atender agora: o override manual manda mais que tudo; na
// ausência dele, consulta as faixas cadastradas e cai no modo padrão se nenhuma bater.
async function obterModoAtual() {
    const override = await obterOverrideRobo();
    if (override.ativo) return { modo: 'robo', mensagemHumano: '' };

    const confRows = await db.all('SELECT * FROM configuracoes');
    const config = {};
    confRows.forEach(r => config[r.chave] = r.valor);

    const mensagemHumano = config.horario_mensagem_humano || '';
    if (config.horario_ativo !== 'true') return { modo: 'robo', mensagemHumano: '' };

    const timezone = config.horario_timezone || 'America/Sao_Paulo';
    const modoPadrao = config.horario_modo_padrao === 'humano' ? 'humano' : 'robo';

    const agora = moment.tz(timezone);
    const diaAtual = agora.day();
    const diaAnterior = (diaAtual + 6) % 7;
    const minutoAtual = agora.hours() * 60 + agora.minutes();

    const faixas = await db.all('SELECT * FROM horarios_atendimento');
    let modo = null;
    for (const faixa of faixas) {
        if (!faixaCobreAgora(faixa, diaAtual, diaAnterior, minutoAtual)) continue;
        if (faixa.modo === 'humano') { modo = 'humano'; break; } // humano tem prioridade sobre robô em caso de sobreposição
        modo = 'robo';
    }
    return { modo: modo || modoPadrao, mensagemHumano, timezone };
}

// Upload de Mídia para Fluxos
app.post('/api/upload_fluxo', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    // Retorna a URL que será salva no JSON do fluxo
    res.json({ url: '/uploads/' + req.file.filename });
});

// =====================================
// API REST — FLUXOS DE ATENDIMENTO
// =====================================
app.get('/api/fluxos', async (req, res) => {
    try {
        const fluxos = await db.all("SELECT * FROM fluxos ORDER BY id DESC");
        // Converte JSON de volta para objeto
        const formatados = fluxos.map(f => ({
            ...f,
            flow_data: JSON.parse(f.flow_data || '[]')
        }));
        res.json(formatados);
    } catch(err) {
        res.status(500).json({error: err.message});
    }
});

app.post('/api/fluxos', async (req, res) => {
    try {
        const { nome, gatilho, flow_data, ativo } = req.body;
        const result = await db.run(
            'INSERT INTO fluxos (nome, gatilho, flow_data, ativo) VALUES (?, ?, ?, ?)',
            [nome, gatilho || null, JSON.stringify(flow_data || []), ativo !== undefined ? ativo : 1]
        );
        const novo = await db.get('SELECT * FROM fluxos WHERE id = ?', result.lastID);
        if (novo) novo.flow_data = JSON.parse(novo.flow_data || '[]');
        io.emit('fluxos_updated');
        res.json(novo);
    } catch(err) {
        res.status(500).json({error: err.message});
    }
});

app.put('/api/fluxos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, gatilho, flow_data, ativo } = req.body;
        await db.run(
            'UPDATE fluxos SET nome = ?, gatilho = ?, flow_data = ?, ativo = ? WHERE id = ?',
            [nome, gatilho || null, JSON.stringify(flow_data || []), ativo !== undefined ? ativo : 1, id]
        );
        io.emit('fluxos_updated');
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({error: err.message});
    }
});

app.delete('/api/fluxos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.run('DELETE FROM fluxos WHERE id = ?', id);
        io.emit('fluxos_updated');
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({error: err.message});
    }
});

app.post('/api/fluxos/:id/toggle', async (req, res) => {
    try {
        const { id } = req.params;
        const fluxo = await db.get('SELECT ativo FROM fluxos WHERE id = ?', id);
        if (!fluxo) return res.status(404).json({error: 'Fluxo não encontrado'});
        const novoStatus = fluxo.ativo ? 0 : 1;
        await db.run('UPDATE fluxos SET ativo = ? WHERE id = ?', [novoStatus, id]);
        io.emit('fluxos_updated');
        res.json({ success: true, ativo: novoStatus });
    } catch(err) {
        res.status(500).json({error: err.message});
    }
});

// =====================================
// API REST — CRM COLABORADORES
// =====================================
app.get('/api/respostas', async (req, res) => {
    const r = await db.all('SELECT * FROM respostas ORDER BY ordem ASC');
    res.json(r);
});

app.post('/api/respostas', async (req, res) => {
    const { keywords, resposta, ordem, enviar_audio, media_path, media_tipo, etiqueta_id } = req.body;
    if (!keywords || !resposta) return res.status(400).json({ error: 'Campos obrigatórios.' });
    const result = await db.run(
        'INSERT INTO respostas (keywords, resposta, ativo, ordem, enviar_audio, media_path, media_tipo, etiqueta_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
        [keywords, resposta, ordem || 99, enviar_audio ? 1 : 0, media_path || null, media_tipo || null, etiqueta_id || null]
    );
    const nova = await db.get('SELECT * FROM respostas WHERE id = ?', result.lastID);
    io.emit('respostas_updated');
    res.json(nova);
});

app.put('/api/respostas/:id', async (req, res) => {
    const { id } = req.params;
    const { keywords, resposta, ativo, ordem, enviar_audio, media_path, media_tipo, etiqueta_id } = req.body;
    await db.run(
        'UPDATE respostas SET keywords=?, resposta=?, ativo=?, ordem=?, enviar_audio=?, media_path=?, media_tipo=?, etiqueta_id=? WHERE id=?',
        [keywords, resposta, ativo !== undefined ? ativo : 1, ordem || 99, enviar_audio ? 1 : 0, media_path || null, media_tipo || null, etiqueta_id || null, id]
    );
    const atualizada = await db.get('SELECT * FROM respostas WHERE id = ?', id);
    io.emit('respostas_updated');
    res.json(atualizada);
});

app.delete('/api/respostas/:id', async (req, res) => {
    const { id } = req.params;
    const regra = await db.get('SELECT * FROM respostas WHERE id = ?', id);
    // Remove o arquivo de mídia se existir
    if (regra && regra.media_path) {
        const fullPath = path.join(__dirname, 'public', regra.media_path.replace('/uploads/', 'uploads/'));
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
    await db.run('DELETE FROM respostas WHERE id = ?', id);
    io.emit('respostas_updated');
    res.json({ success: true });
});

// =====================================
// API REST — CONFIGURAÇÕES (IA)
// =====================================
app.get('/api/configuracoes', async (req, res) => {
    const rows = await db.all('SELECT * FROM configuracoes');
    const config = {};
    rows.forEach(r => config[r.chave] = r.valor);
    res.json(config);
});

app.put('/api/configuracoes', async (req, res) => {
    const keys = Object.keys(req.body);
    for (const key of keys) {
        await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', [key, String(req.body[key])]);
    }
    res.json({ success: true });
});

// =====================================
// API REST — HORÁRIO DE FUNCIONAMENTO
// =====================================
app.get('/api/horarios', async (req, res) => {
    const confRows = await db.all("SELECT * FROM configuracoes WHERE chave LIKE 'horario_%'");
    const config = {};
    confRows.forEach(r => config[r.chave] = r.valor);
    const faixas = await db.all('SELECT * FROM horarios_atendimento ORDER BY id ASC');
    res.json({
        ativo: config.horario_ativo === 'true',
        modo_padrao: config.horario_modo_padrao === 'humano' ? 'humano' : 'robo',
        mensagem_humano: config.horario_mensagem_humano || '',
        faixas: faixas.map(f => ({
            id: f.id,
            dias: f.dias.split(',').filter(Boolean).map(Number),
            inicio: f.inicio,
            fim: f.fim,
            modo: f.modo
        }))
    });
});

app.put('/api/horarios', async (req, res) => {
    const { ativo, modo_padrao, mensagem_humano, faixas } = req.body;
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['horario_ativo', ativo ? 'true' : 'false']);
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['horario_modo_padrao', modo_padrao === 'humano' ? 'humano' : 'robo']);
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['horario_mensagem_humano', mensagem_humano || '']);

    await db.run('DELETE FROM horarios_atendimento');
    for (const f of (Array.isArray(faixas) ? faixas : [])) {
        const dias = Array.isArray(f.dias) ? f.dias.join(',') : String(f.dias || '');
        if (!dias || !f.inicio || !f.fim) continue;
        await db.run(
            'INSERT INTO horarios_atendimento (dias, inicio, fim, modo) VALUES (?, ?, ?, ?)',
            [dias, f.inicio, f.fim, f.modo === 'humano' ? 'humano' : 'robo']
        );
    }
    res.json({ success: true });
});

// =====================================
// API REST — OVERRIDE MANUAL (BOTÃO "ATIVAR ROBÔ")
// =====================================
app.get('/api/robo-override', async (req, res) => {
    res.json(await obterOverrideRobo());
});

app.post('/api/robo-override', async (req, res) => {
    const minutos = Number(req.body.minutos);
    if (minutos > 0) {
        const ate = Date.now() + minutos * 60000;
        await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['override_robo_ate', String(ate)]);
        await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['override_robo_indeterminado', 'false']);
    } else {
        await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['override_robo_ate', '']);
        await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['override_robo_indeterminado', 'true']);
    }
    const estado = await obterOverrideRobo();
    io.emit('robo_override', estado);
    res.json(estado);
});

app.delete('/api/robo-override', async (req, res) => {
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['override_robo_ate', '']);
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['override_robo_indeterminado', 'false']);
    const estado = await obterOverrideRobo();
    io.emit('robo_override', estado);
    res.json(estado);
});

// Upload de Mídia para uma Regra
app.post('/api/upload', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const mimeType = req.file.mimetype;
    let tipo = 'file';
    if (mimeType.startsWith('image/')) tipo = 'image';
    else if (mimeType.startsWith('video/')) tipo = 'video';
    else if (mimeType.startsWith('audio/')) tipo = 'audio';
    res.json({ path: `/uploads/${req.file.filename}`, tipo, originalName: req.file.originalname });
});

app.delete('/api/upload', (req, res) => {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath obrigatório.' });
    const fullPath = path.join(__dirname, 'public', filePath.replace('/uploads/', 'uploads/'));
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    res.json({ success: true });
});

// =====================================
// API REST — LEADS
// =====================================
app.get('/api/leads', async (req, res) => {
    const leads = await db.all('SELECT * FROM leads ORDER BY data_captura DESC');
    res.json(leads.map(l => ({ ...l, data_captura: sqliteTsParaIso(l.data_captura) })));
});

// Novos contatos por dia (horário de Brasília), pro gráfico do Painel de
// Controle. Sempre devolve um ponto por dia no período, mesmo com 0 leads.
app.get('/api/leads/por-dia', async (req, res) => {
    const dias = Math.min(parseInt(req.query.dias) || 14, 60);
    try {
        const desde = moment.tz('America/Sao_Paulo').subtract(dias - 1, 'days').startOf('day').utc().format('YYYY-MM-DD HH:mm:ss');
        const rows = await db.all('SELECT data_captura FROM leads WHERE data_captura >= ?', desde);

        const contagem = new Map();
        rows.forEach(r => {
            const dia = moment.utc(r.data_captura).tz('America/Sao_Paulo').format('YYYY-MM-DD');
            contagem.set(dia, (contagem.get(dia) || 0) + 1);
        });

        const resultado = [];
        for (let i = dias - 1; i >= 0; i--) {
            const m = moment.tz('America/Sao_Paulo').subtract(i, 'days');
            const chave = m.format('YYYY-MM-DD');
            resultado.push({ data: chave, diaMes: m.format('DD'), total: contagem.get(chave) || 0 });
        }
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export Leads como CSV
app.get('/api/leads/export', async (req, res) => {
    const leads = await db.all('SELECT telefone, data_captura, mensagens_recebidas FROM leads ORDER BY data_captura DESC');
    const csv = ['Telefone,Data de Captura,Mensagens Recebidas',
        ...leads.map(l => `${l.telefone.replace('@c.us','').replace('@lid','')},${l.data_captura},${l.mensagens_recebidas}`)
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(csv);
});

// =====================================
// API REST — LISTA DE CONTATOS (SELEÇÃO PARA DISPAROS)
// =====================================
// Junta os leads capturados com o melhor nome conhecido de cada telefone
// (o nome mais recente salvo em "conversas"), pra montar uma lista de
// contatos com nome pra seleção manual nos disparos em massa.
app.get('/api/contatos', async (req, res) => {
    try {
        const leads = await db.all('SELECT telefone, nome, origem, matricula, data_nascimento, data_captura, mensagens_recebidas FROM leads ORDER BY data_captura DESC');
        const nomes = await db.all(`
            SELECT c.telefone, c.nome
            FROM conversas c
            INNER JOIN (SELECT telefone, MAX(ts) AS max_ts FROM conversas GROUP BY telefone) latest
                ON c.telefone = latest.telefone AND c.ts = latest.max_ts
        `);
        const nomePorTelefone = new Map(nomes.map(n => [n.telefone, n.nome]));

        const etiquetasPorTelefone = new Map();
        const etiquetasRows = await db.all(`
            SELECT ce.telefone, e.id, e.nome, e.cor
            FROM contato_etiquetas ce
            INNER JOIN etiquetas e ON e.id = ce.etiqueta_id
        `);
        etiquetasRows.forEach(r => {
            if (!etiquetasPorTelefone.has(r.telefone)) etiquetasPorTelefone.set(r.telefone, []);
            etiquetasPorTelefone.get(r.telefone).push({ id: r.id, nome: r.nome, cor: r.cor });
        });

        // Matrícula vem do vínculo com o CRM Pacto (feito no fluxo de cadastro/
        // matrícula pelo WhatsApp) — telefone lá é salvo em formatos inconsistentes,
        // por isso casa por "contém" em vez de igualdade exata, igual resolverNomeContato.
        const vinculos = await db.all('SELECT telefone, matricula FROM vinculo_pacto WHERE matricula IS NOT NULL');
        function matriculaDoTelefone(telefoneLimpo) {
            const v = vinculos.find(v => v.telefone.includes(telefoneLimpo) || telefoneLimpo.includes(v.telefone));
            return v?.matricula || null;
        }

        const contatos = leads.map(l => {
            const telefone = l.telefone.replace('@c.us', '').replace('@lid', '');
            return {
                telefone,
                // Nome editado manualmente na Audiência tem prioridade — senão o nome
                // vindo do WhatsApp (pushname salvo em "conversas") sempre ganhava.
                nome: l.nome || nomePorTelefone.get(telefone) || telefone,
                origem: l.origem || 'whatsapp',
                // Matrícula editada manualmente tem prioridade sobre a do vínculo Pacto.
                matricula: l.matricula || matriculaDoTelefone(telefone),
                data_nascimento: l.data_nascimento,
                data_captura: sqliteTsParaIso(l.data_captura),
                mensagens_recebidas: l.mensagens_recebidas,
                etiquetas: etiquetasPorTelefone.get(telefone) || []
            };
        });
        res.json(contatos);
    } catch (err) {
        console.error('Erro /api/contatos:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Exclui um contato da Audiência — some da lista de Contatos, das etiquetas
// aplicadas e de qualquer automação em andamento. Não apaga o histórico de
// conversa (isso é outra ação, no Bate Papo ao Vivo).
app.delete('/api/contatos/:telefone', async (req, res) => {
    const { telefone } = req.params;
    const variantes = [telefone, `${telefone}@c.us`, `${telefone}@lid`];
    try {
        await db.run('DELETE FROM leads WHERE telefone = ? OR telefone = ? OR telefone = ?', variantes);
        await db.run('DELETE FROM contato_etiquetas WHERE telefone = ?', telefone);
        await db.run('DELETE FROM contato_automacao_estado WHERE telefone = ?', telefone);
        variantes.forEach(v => leadsSet.delete(v));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cria um contato manualmente (botão "+ Novo Contato" na tela de Contatos) —
// mesmo caminho de dados de quem chega pelo WhatsApp: fica disponível na hora
// pra Disparos, Fluxos e Automação.
app.post('/api/contatos', async (req, res) => {
    const { nome, telefone, data_nascimento, etiqueta_id } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
    const telefoneNormalizado = normalizarTelefoneImportado(telefone);
    if (!telefoneNormalizado) return res.status(400).json({ error: 'Telefone inválido. Informe com DDD (ex: 46999998888).' });
    try {
        const existente = await db.get(
            'SELECT telefone FROM leads WHERE telefone = ? OR telefone = ? OR telefone = ?',
            [telefoneNormalizado, `${telefoneNormalizado}@c.us`, `${telefoneNormalizado}@lid`]
        );
        if (existente) return res.status(400).json({ error: 'Já existe um contato com esse telefone.' });
        await db.run(
            'INSERT INTO leads (telefone, nome, origem, data_nascimento) VALUES (?, ?, ?, ?)',
            [telefoneNormalizado, nome.trim(), 'manual', (data_nascimento || '').trim() || null]
        );
        leadsSet.add(telefoneNormalizado);
        stats.leads++;
        io.emit('stats', stats);
        if (etiqueta_id) await aplicarEtiquetaContato(telefoneNormalizado, etiqueta_id);
        res.json({ success: true, telefone: telefoneNormalizado });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =====================================
// MESCLAGEM DE CONTATOS DUPLICADOS (mesmo telefone, formatos diferentes)
// =====================================
// Caso real encontrado em produção: "554284014994" e "5542984014994" eram o
// MESMO Henrique — o segundo tem o "9" que todo celular brasileiro tem desde a
// migração pro formato de 9 dígitos, o primeiro não. Tratados como duas
// pessoas: duas conversas, duas etiquetas, duas automações. normalizarTelefoneBR
// (mais acima) já evita ISSO acontecer de novo dali pra frente; essas rotas
// resolvem os duplicados que já existem na base.

// Escolhe o "melhor" lead do grupo pra ser a fonte principal de dados: prioriza
// quem tem matrícula E data de nascimento (vínculo Pacto de verdade), depois
// quem tem mais mensagens recebidas, por último o cadastro mais antigo.
function escolherMelhorLead(leadsGrupo) {
    return [...leadsGrupo].sort((a, b) => {
        const aCompleto = (a.matricula && a.data_nascimento) ? 1 : 0;
        const bCompleto = (b.matricula && b.data_nascimento) ? 1 : 0;
        if (aCompleto !== bCompleto) return bCompleto - aCompleto;
        const aMsgs = a.mensagens_recebidas || 0;
        const bMsgs = b.mensagens_recebidas || 0;
        if (aMsgs !== bMsgs) return bMsgs - aMsgs;
        return new Date(a.data_captura || 0) - new Date(b.data_captura || 0);
    })[0];
}

// Tabela sem PK/UNIQUE em telefone (pode ter várias linhas por telefone) —
// só troca o valor, sem risco de conflito.
async function moverLinhaSimples(tabela, de, para) {
    await db.run(`UPDATE ${tabela} SET telefone = ? WHERE telefone = ?`, [para, de]);
}

// Tabela com PK(telefone) só — se o telefone-alvo já tem linha, a linha do
// alvo prevalece (é o "melhor" contato) e a de origem é descartada; senão,
// só migra a linha de origem pro telefone-alvo.
async function moverLinhaPkTelefone(tabela, de, para) {
    const jaExiste = await db.get(`SELECT 1 FROM ${tabela} WHERE telefone = ?`, para);
    if (jaExiste) {
        await db.run(`DELETE FROM ${tabela} WHERE telefone = ?`, de);
    } else {
        await db.run(`UPDATE ${tabela} SET telefone = ? WHERE telefone = ?`, [para, de]);
    }
}

// Tabela com PK composta (telefone, colunaExtra) — mesma lógica, mas por
// combinação de chave: só descarta a linha de origem se o alvo já tem uma
// linha PRA AQUELA MESMA colunaExtra (ex: mesma etiqueta_id, mesma automacao_id).
async function moverLinhasChaveComposta(tabela, colunaExtra, de, para) {
    const linhas = await db.all(`SELECT ${colunaExtra} AS chave FROM ${tabela} WHERE telefone = ?`, de);
    for (const { chave } of linhas) {
        const jaExiste = await db.get(`SELECT 1 FROM ${tabela} WHERE telefone = ? AND ${colunaExtra} = ?`, [para, chave]);
        if (jaExiste) {
            await db.run(`DELETE FROM ${tabela} WHERE telefone = ? AND ${colunaExtra} = ?`, [de, chave]);
        } else {
            await db.run(`UPDATE ${tabela} SET telefone = ? WHERE telefone = ? AND ${colunaExtra} = ?`, [para, de, chave]);
        }
    }
}

// mensagem_personalizada_enviada tem PK de 3 colunas (mensagem_id, telefone,
// ano) — caso especial, não cabe no helper de chave composta genérico acima.
async function moverMensagemPersonalizadaEnviada(de, para) {
    const linhas = await db.all('SELECT mensagem_id, ano FROM mensagem_personalizada_enviada WHERE telefone = ?', de);
    for (const { mensagem_id, ano } of linhas) {
        const jaExiste = await db.get(
            'SELECT 1 FROM mensagem_personalizada_enviada WHERE telefone = ? AND mensagem_id = ? AND ano = ?',
            [para, mensagem_id, ano]
        );
        if (jaExiste) {
            await db.run('DELETE FROM mensagem_personalizada_enviada WHERE telefone = ? AND mensagem_id = ? AND ano = ?', [de, mensagem_id, ano]);
        } else {
            await db.run('UPDATE mensagem_personalizada_enviada SET telefone = ? WHERE telefone = ? AND mensagem_id = ? AND ano = ?', [para, de, mensagem_id, ano]);
        }
    }
}

// Migra TODAS as tabelas de um grupo de telefones-duplicados pro telefone
// canônico (normalizado), preservando o máximo de dado possível e nunca
// duplicando linha em tabela nenhuma.
async function mesclarGrupoDeTelefones(canonico, leadsGrupo) {
    const melhor = escolherMelhorLead(leadsGrupo);
    const nomeFinal = melhor.nome || leadsGrupo.find(l => l.nome)?.nome || null;
    const origemFinal = melhor.origem || leadsGrupo.find(l => l.origem)?.origem || null;
    const matriculaFinal = melhor.matricula || leadsGrupo.find(l => l.matricula)?.matricula || null;
    const nascimentoFinal = melhor.data_nascimento || leadsGrupo.find(l => l.data_nascimento)?.data_nascimento || null;
    const mensagensSoma = leadsGrupo.reduce((soma, l) => soma + (l.mensagens_recebidas || 0), 0);
    const capturaMaisAntiga = leadsGrupo.reduce((min, l) => (!min || (l.data_captura && l.data_captura < min)) ? l.data_captura : min, null);

    const outros = leadsGrupo.map(l => l.telefone).filter(t => t !== canonico);
    for (const de of outros) {
        await moverLinhaSimples('conversas', de, canonico);
        await moverLinhaSimples('mensagens_enviadas', de, canonico);
        await moverLinhaSimples('automacao_envios_log', de, canonico);
        await moverLinhaPkTelefone('vinculo_pacto', de, canonico);
        await moverLinhaPkTelefone('conversas_humano', de, canonico);
        await moverLinhaPkTelefone('contato_estado_fluxo', de, canonico);
        await moverLinhaPkTelefone('conversas_status', de, canonico);
        await moverLinhaPkTelefone('pacto_inadimplentes', de, canonico);
        await moverLinhasChaveComposta('contato_etiquetas', 'etiqueta_id', de, canonico);
        await moverLinhasChaveComposta('contato_automacao_estado', 'automacao_id', de, canonico);
        await moverMensagemPersonalizadaEnviada(de, canonico);
        await db.run('DELETE FROM leads WHERE telefone = ?', de);
    }

    const existeCanonico = await db.get('SELECT 1 FROM leads WHERE telefone = ?', canonico);
    if (existeCanonico) {
        await db.run(
            `UPDATE leads SET nome = ?, origem = ?, matricula = ?, data_nascimento = ?, mensagens_recebidas = ?, data_captura = ? WHERE telefone = ?`,
            [nomeFinal, origemFinal, matriculaFinal, nascimentoFinal, mensagensSoma, capturaMaisAntiga, canonico]
        );
    } else {
        await db.run(
            `INSERT INTO leads (telefone, nome, origem, matricula, data_nascimento, mensagens_recebidas, data_captura) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [canonico, nomeFinal, origemFinal, matriculaFinal, nascimentoFinal, mensagensSoma, capturaMaisAntiga]
        );
    }
}

// Agrupa todos os leads cujo telefone normaliza pro mesmo canônico — sem
// alterar nada, só pra revisar antes de mesclar de verdade.
app.get('/api/contatos/duplicados-telefone', async (req, res) => {
    try {
        const leads = await db.all('SELECT * FROM leads');
        const grupos = new Map();
        leads.forEach(l => {
            const canonico = normalizarTelefoneBR(l.telefone);
            if (!grupos.has(canonico)) grupos.set(canonico, []);
            grupos.get(canonico).push(l);
        });
        const duplicados = [...grupos.entries()]
            .filter(([, ls]) => ls.length > 1)
            .map(([canonico, contatos]) => ({ canonico, contatos }));
        res.json(duplicados);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Executa a mesclagem de verdade pra todos os grupos de duplicados encontrados.
app.post('/api/contatos/mesclar-duplicados', async (req, res) => {
    try {
        const leads = await db.all('SELECT * FROM leads');
        const grupos = new Map();
        leads.forEach(l => {
            const canonico = normalizarTelefoneBR(l.telefone);
            if (!grupos.has(canonico)) grupos.set(canonico, []);
            grupos.get(canonico).push(l);
        });
        const gruposDuplicados = [...grupos.entries()].filter(([, ls]) => ls.length > 1);

        // Achado em produção: telefone compartilhado por FAMÍLIA (pai/mãe + filho,
        // irmãos) é comum nessa academia — cada um com matrícula própria e data de
        // nascimento diferente. 2+ contatos do grupo com matrícula PRÓPRIA é gente
        // DIFERENTE de verdade, não duplicata de formato — mesclar destruiria a
        // identidade de um dos alunos. Só mescla grupo com no máximo 1 matrícula.
        const mesclados = [];
        const pulados = [];
        for (const [canonico, leadsGrupo] of gruposDuplicados) {
            const comMatricula = leadsGrupo.filter(l => l.matricula).length;
            if (comMatricula >= 2) {
                pulados.push({ canonico, motivo: 'multiplas matriculas proprias no grupo — provavel familia compartilhando telefone, nao duplicata', contatos: leadsGrupo.map(l => ({ telefone: l.telefone, nome: l.nome, matricula: l.matricula })) });
                continue;
            }
            await mesclarGrupoDeTelefones(canonico, leadsGrupo);
            mesclados.push({ canonico, telefones_mesclados: leadsGrupo.map(l => l.telefone) });
        }
        io.emit('stats', stats);
        res.json({ success: true, grupos_mesclados: mesclados.length, grupos_pulados: pulados.length, detalhes: mesclados, pulados });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edita o nome de um contato na Audiência (usado pela modal de edição).
// leads.telefone vem de fontes diferentes com formatos diferentes: mensagens do
// WhatsApp gravam com sufixo (@c.us/@lid), importação por planilha grava limpo
// — por isso o WHERE tenta todos os formatos, não só o número limpo que o front manda.
app.put('/api/contatos/:telefone', async (req, res) => {
    const { telefone } = req.params;
    const { nome, matricula, data_nascimento } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
    try {
        const result = await db.run(
            'UPDATE leads SET nome = ?, matricula = ?, data_nascimento = ? WHERE telefone = ? OR telefone = ? OR telefone = ?',
            [nome.trim(), (matricula || '').trim() || null, (data_nascimento || '').trim() || null, telefone, `${telefone}@c.us`, `${telefone}@lid`]
        );
        if (result.changes === 0) return res.status(404).json({ error: 'Contato não encontrado.' });
        res.json({ success: true, nome: nome.trim(), matricula: (matricula || '').trim() || null, data_nascimento: (data_nascimento || '').trim() || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Modelo de planilha para o usuário baixar e preencher (Nome / Telefone / Etiqueta)
app.get('/api/contatos/modelo-planilha', (req, res) => {
    const csv = 'Nome;Telefone;Etiqueta\nJoão da Silva;46999998888;Interessado\nMaria Souza;46988887777;\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="modelo-contatos.csv"');
    res.send('﻿' + csv); // BOM na frente pra abrir certo no Excel
});

// Faz o parse manual de um CSV simples (aceita separador ; ou ,), sem depender
// de biblioteca externa — evita puxar pacotes de terceiros só pra isso.
function parseCsv(texto) {
    const semBom = texto.replace(/^﻿/, '');
    const linhas = semBom.split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);
    if (linhas.length === 0) return [];

    const separador = (linhas[0].match(/;/g) || []).length >= (linhas[0].match(/,/g) || []).length ? ';' : ',';

    function parseLinha(linha) {
        const campos = [];
        let atual = '';
        let dentroAspas = false;
        for (let i = 0; i < linha.length; i++) {
            const c = linha[i];
            if (c === '"') {
                if (dentroAspas && linha[i + 1] === '"') { atual += '"'; i++; }
                else dentroAspas = !dentroAspas;
            } else if (c === separador && !dentroAspas) {
                campos.push(atual.trim());
                atual = '';
            } else {
                atual += c;
            }
        }
        campos.push(atual.trim());
        return campos;
    }

    const cabecalho = parseLinha(linhas[0]).map(h => h.toLowerCase());
    const idxNome = cabecalho.findIndex(h => h.includes('nome'));
    const idxTelefone = cabecalho.findIndex(h => h.includes('telefone') || h.includes('celular') || h.includes('whatsapp') || h.includes('phone'));
    const idxEtiqueta = cabecalho.findIndex(h => h.includes('etiqueta') || h.includes('tag'));

    const linhasDeDados = linhas.slice(1);
    return linhasDeDados.map(linha => {
        const campos = parseLinha(linha);
        return {
            nome: idxNome >= 0 ? campos[idxNome] : '',
            telefone: idxTelefone >= 0 ? campos[idxTelefone] : '',
            etiqueta: idxEtiqueta >= 0 ? campos[idxEtiqueta] : ''
        };
    });
}

// Normaliza um telefone BR pro formato canônico (55 + DDD + 9 dígitos, quando é
// celular). Sem isso, o MESMO número físico vira dois contatos diferentes
// conforme a origem manda com ou sem o "9" que faz parte do celular brasileiro
// desde a migração pro formato de 9 dígitos — caso real visto em produção:
// "554284014994" (sem o 9) e "5542984014994" (com o 9) eram o MESMO Henrique,
// só que tratados como duas pessoas: duas conversas, duas etiquetas, duas
// automações separadas. Fixo (8 dígitos locais começando 2-5) nunca teve esse
// "9" — não mexe. Sempre retorna uma string (nunca null); qualquer coisa que
// não pareça um BR de 10-13 dígitos volta sem alteração (LID, garbage, etc).
function normalizarTelefoneBR(raw) {
    let digitos = String(raw || '').replace(/\D/g, '');
    if (digitos.length === 10 || digitos.length === 11) digitos = '55' + digitos;
    if (digitos.length === 12 && digitos.startsWith('55')) {
        const ddd = digitos.slice(2, 4);
        const local = digitos.slice(4);
        if (/^[6-9]/.test(local)) digitos = `55${ddd}9${local}`;
    }
    return digitos;
}

// Normaliza número para o mesmo formato usado nas outras tabelas (só dígitos, com DDI 55)
function normalizarTelefoneImportado(raw) {
    const digitos = normalizarTelefoneBR(raw);
    if (digitos.length < 12 || digitos.length > 13) return null;
    return digitos;
}

app.post('/api/contatos/importar', uploadCsv.single('planilha'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    try {
        const texto = req.file.buffer.toString('utf8');
        const linhas = parseCsv(texto);

        let importados = 0, atualizados = 0, ignorados = 0;
        const etiquetaIdCache = new Map();

        for (const linha of linhas) {
            const telefone = normalizarTelefoneImportado(linha.telefone);
            if (!telefone) { ignorados++; continue; }

            const nome = (linha.nome || '').trim() || null;
            // leads.telefone pode estar salvo limpo (import anterior) ou com sufixo
            // @c.us/@lid (contato que já mandou mensagem pelo WhatsApp) — sem checar
            // os dois formatos, um contato que já existe vira duplicado no import.
            const existente = await db.get(
                'SELECT telefone FROM leads WHERE telefone = ? OR telefone = ? OR telefone = ?',
                [telefone, `${telefone}@c.us`, `${telefone}@lid`]
            );

            if (existente) {
                if (nome) await db.run('UPDATE leads SET nome = ? WHERE telefone = ?', [nome, existente.telefone]);
                atualizados++;
            } else {
                await db.run('INSERT INTO leads (telefone, nome, origem) VALUES (?, ?, ?)', [telefone, nome, 'planilha']);
                leadsSet.add(telefone);
                stats.leads++;
                importados++;
            }

            const nomeEtiqueta = (linha.etiqueta || '').trim();
            if (nomeEtiqueta) {
                let etiquetaId = etiquetaIdCache.get(nomeEtiqueta.toLowerCase());
                if (!etiquetaId) {
                    let row = await db.get('SELECT id FROM etiquetas WHERE LOWER(nome) = LOWER(?)', nomeEtiqueta);
                    if (!row) {
                        const cores = ['#25D366', '#128C7E', '#F59E0B', '#3B82F6', '#EF4444', '#8B5CF6'];
                        const cor = cores[Math.floor(Math.random() * cores.length)];
                        const result = await db.run('INSERT INTO etiquetas (nome, cor) VALUES (?, ?)', [nomeEtiqueta, cor]);
                        row = { id: result.lastID };
                    }
                    etiquetaId = row.id;
                    etiquetaIdCache.set(nomeEtiqueta.toLowerCase(), etiquetaId);
                }
                await aplicarEtiquetaContato(telefone, etiquetaId);
                // Se a etiqueta tiver automação vinculada, aplicá-la dispara uma
                // mensagem na hora — um respiro entre linhas evita um estouro de
                // envios simultâneos (risco de bloqueio) num import com muitos contatos.
                await delay(300);
            }
        }

        io.emit('stats', stats);
        if (etiquetaIdCache.size > 0) io.emit('etiquetas_atualizadas');
        res.json({ success: true, importados, atualizados, ignorados, total: linhas.length });
    } catch (err) {
        console.error('Erro /api/contatos/importar:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// =====================================
// API REST — ETIQUETAS
// =====================================
app.get('/api/etiquetas', async (req, res) => {
    const etiquetas = await db.all(`
        SELECT e.*, COUNT(ce.telefone) AS total_contatos
        FROM etiquetas e
        LEFT JOIN contato_etiquetas ce ON ce.etiqueta_id = e.id
        GROUP BY e.id
        ORDER BY e.nome ASC
    `);
    res.json(etiquetas);
});

app.post('/api/etiquetas', async (req, res) => {
    const { nome, cor, duracao_dias } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome da etiqueta é obrigatório.' });
    const duracaoNum = duracao_dias ? parseInt(duracao_dias) : null;
    try {
        const result = await db.run('INSERT INTO etiquetas (nome, cor, duracao_dias) VALUES (?, ?, ?)', [nome.trim(), cor || '#25D366', duracaoNum || null]);
        const nova = await db.get('SELECT *, 0 AS total_contatos FROM etiquetas WHERE id = ?', result.lastID);
        io.emit('etiquetas_atualizadas');
        res.json(nova);
    } catch (err) {
        res.status(400).json({ error: err.message.includes('UNIQUE') ? 'Já existe uma etiqueta com esse nome.' : err.message });
    }
});

app.put('/api/etiquetas/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, cor, duracao_dias } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome da etiqueta é obrigatório.' });
    const duracaoNum = duracao_dias ? parseInt(duracao_dias) : null;
    try {
        await db.run('UPDATE etiquetas SET nome = ?, cor = ?, duracao_dias = ? WHERE id = ?', [nome.trim(), cor || '#25D366', duracaoNum || null, id]);
        const atualizada = await db.get(`
            SELECT e.*, COUNT(ce.telefone) AS total_contatos
            FROM etiquetas e LEFT JOIN contato_etiquetas ce ON ce.etiqueta_id = e.id
            WHERE e.id = ? GROUP BY e.id
        `, id);
        io.emit('etiquetas_atualizadas');
        res.json(atualizada);
    } catch (err) {
        res.status(400).json({ error: err.message.includes('UNIQUE') ? 'Já existe uma etiqueta com esse nome.' : err.message });
    }
});

app.delete('/api/etiquetas/:id', async (req, res) => {
    const { id } = req.params;
    await db.run('DELETE FROM contato_etiquetas WHERE etiqueta_id = ?', id);
    await db.run('UPDATE respostas SET etiqueta_id = NULL WHERE etiqueta_id = ?', id);
    // Etiqueta apagada não pode mais disparar nem sustentar nenhuma automação —
    // apaga em cascata as automações vinculadas, suas etapas e quem estava nelas.
    const automacoesLigadas = await db.all('SELECT id FROM automacoes WHERE etiqueta_id = ?', id);
    for (const a of automacoesLigadas) {
        await db.run('DELETE FROM contato_automacao_estado WHERE automacao_id = ?', a.id);
        await db.run('DELETE FROM automacao_etapas WHERE automacao_id = ?', a.id);
    }
    await db.run('DELETE FROM automacoes WHERE etiqueta_id = ?', id);
    await db.run('DELETE FROM etiquetas WHERE id = ?', id);
    io.emit('etiquetas_atualizadas');
    if (automacoesLigadas.length > 0) io.emit('automacoes_atualizadas');
    res.json({ success: true });
});

// Aplica uma etiqueta a um contato (idempotente) e, se ela tiver uma automação
// ativa vinculada, matricula o contato nela (dispara a etapa 1 na hora). Ponto
// único usado por toda aplicação de etiqueta no sistema — regras automáticas,
// fluxos, import de planilha e aplicação manual — pra garantir que a
// automação sempre dispara, não importa de onde a etiqueta veio.
async function aplicarEtiquetaContato(telefone, etiquetaId) {
    const numLimpo = telefone.replace('@c.us','').replace('@lid','');
    const etiqueta = await db.get('SELECT duracao_dias FROM etiquetas WHERE id = ?', etiquetaId);
    const expiraEm = etiqueta?.duracao_dias
        ? new Date(Date.now() + etiqueta.duracao_dias * 86400000).toISOString()
        : null;
    // Se já tinha a etiqueta e ela é temporária, reaplicar REINICIA a contagem
    // (ex: aluno começou outra rodada do desafio) — por isso é upsert, não
    // "ignora se já existe" como antes.
    const jaTinha = await db.get('SELECT 1 FROM contato_etiquetas WHERE telefone = ? AND etiqueta_id = ?', [numLimpo, etiquetaId]);
    await db.run(
        `INSERT INTO contato_etiquetas (telefone, etiqueta_id, expira_em) VALUES (?, ?, ?)
         ON CONFLICT(telefone, etiqueta_id) DO UPDATE SET expira_em = excluded.expira_em`,
        [numLimpo, etiquetaId, expiraEm]
    );
    io.emit('etiqueta_atualizada', { telefone: numLimpo });
    if (!jaTinha) {
        await iniciarAutomacoesParaEtiqueta(numLimpo, etiquetaId);
    }
    return { changes: jaTinha ? 0 : 1 };
}

// Remove uma etiqueta de um contato e cancela qualquer automação em andamento
// vinculada a ela — a etapa que ainda não foi cumprida não faz mais sentido.
async function removerEtiquetaContato(telefone, etiquetaId) {
    const numLimpo = telefone.replace('@c.us','').replace('@lid','');
    await db.run('DELETE FROM contato_etiquetas WHERE telefone = ? AND etiqueta_id = ?', [numLimpo, etiquetaId]);
    io.emit('etiqueta_atualizada', { telefone: numLimpo });
    const automacoesLigadas = await db.all('SELECT id FROM automacoes WHERE etiqueta_id = ?', etiquetaId);
    for (const a of automacoesLigadas) {
        await db.run('DELETE FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?', [numLimpo, a.id]);
    }
}

// Etiquetas aplicadas manualmente a um contato específico (tela de Conversas)
app.get('/api/contatos/:telefone/etiquetas', async (req, res) => {
    const { telefone } = req.params;
    const etiquetas = await db.all(`
        SELECT e.* FROM contato_etiquetas ce
        INNER JOIN etiquetas e ON e.id = ce.etiqueta_id
        WHERE ce.telefone = ?
        ORDER BY e.nome ASC
    `, telefone);
    res.json(etiquetas);
});

app.post('/api/contatos/:telefone/etiquetas', async (req, res) => {
    const { telefone } = req.params;
    const { etiqueta_id } = req.body;
    if (!etiqueta_id) return res.status(400).json({ error: 'etiqueta_id é obrigatório.' });
    await aplicarEtiquetaContato(telefone, etiqueta_id);
    res.json({ success: true });
});

app.delete('/api/contatos/:telefone/etiquetas/:etiquetaId', async (req, res) => {
    const { telefone, etiquetaId } = req.params;
    await removerEtiquetaContato(telefone, etiquetaId);
    res.json({ success: true });
});

// =====================================
// AUTOMAÇÃO (sequência de mensagens disparada por etiqueta, com dias de espera
// entre etapas — ex: etiqueta "Aluno Novo" dispara boas-vindas, manual, link de
// avaliação, feedback... e ao final remove a etiqueta automaticamente)
// =====================================

// Checa se agora (horário de Brasília) está dentro da janela de envio configurada
// na automação. Sem horario_inicio/horario_fim configurado = sem restrição.
function dentroDoHorarioAutomacao(automacao) {
    if (!automacao.horario_inicio || !automacao.horario_fim) return true;
    const [hIni, mIni] = automacao.horario_inicio.split(':').map(Number);
    const [hFim, mFim] = automacao.horario_fim.split(':').map(Number);
    const agora = moment.tz('America/Sao_Paulo');
    const minutosAgora = agora.hours() * 60 + agora.minutes();
    const minutosIni = hIni * 60 + mIni;
    const minutosFim = hFim * 60 + mFim;
    if (minutosIni <= minutosFim) return minutosAgora >= minutosIni && minutosAgora <= minutosFim;
    return minutosAgora >= minutosIni || minutosAgora <= minutosFim; // janela cruza a meia-noite
}

// Próximo horário (em UTC ISO, pro banco) em que a janela de envio da automação abre.
function proximoInicioJanela(automacao) {
    const [hIni, mIni] = automacao.horario_inicio.split(':').map(Number);
    const agora = moment.tz('America/Sao_Paulo');
    const candidato = agora.clone().hours(hIni).minutes(mIni).seconds(0).milliseconds(0);
    if (candidato.isSameOrBefore(agora)) candidato.add(1, 'day');
    return candidato.toISOString();
}

// true só quando a janela de hoje já FECHOU (passou do horario_fim) — nesse
// caso não faz sentido empurrar o envio pro dia seguinte (ex: mensagem de
// aniversário mandada um dia atrasado perde o sentido). Se a janela ainda nem
// abriu hoje (antes do horario_inicio), não conta como "fechada" — aí sim
// vale esperar abrir, ainda no mesmo dia.
function janelaFechouHoje(automacao) {
    if (!automacao.horario_inicio || !automacao.horario_fim) return false;
    const [hIni, mIni] = automacao.horario_inicio.split(':').map(Number);
    const [hFim, mFim] = automacao.horario_fim.split(':').map(Number);
    const minutosIni = hIni * 60 + mIni;
    const minutosFim = hFim * 60 + mFim;
    if (minutosIni > minutosFim) return false; // janela cruza a meia-noite, não "fecha" no dia civil
    const agora = moment.tz('America/Sao_Paulo');
    const minutosAgora = agora.hours() * 60 + agora.minutes();
    return minutosAgora > minutosFim;
}

// Espera entre um envio de automação e o próximo — mesma config ("Intervalo
// entre envios") usada na tela de Disparos. Evita que N contatos que vencem a
// etapa ao mesmo tempo (ex: todos fazem aniversário no mesmo dia) recebam a
// mensagem em rajada simultânea — risco real de bloqueio da conta no WhatsApp.
async function obterProximoDelayAutomacao() {
    const configRows = await db.all(
        "SELECT chave, valor FROM configuracoes WHERE chave IN ('automacao_delay_segundos', 'automacao_delay_modo', 'automacao_delay_velocidade')"
    );
    const configMap = Object.fromEntries(configRows.map(r => [r.chave, r.valor]));
    if (configMap.automacao_delay_modo !== 'aleatorio') return (parseInt(configMap.automacao_delay_segundos) || 5) * 1000;
    const [min, max] = FAIXAS_VELOCIDADE[configMap.automacao_delay_velocidade] || FAIXAS_VELOCIDADE.medio;
    return Math.floor(min + Math.random() * (max - min));
}

// Mesma config do delay real, mas devolve a MÉDIA da faixa em vez de um valor
// aleatório — usada só pra estimar "horário previsto" na tela de acompanhamento
// (o envio de verdade continua usando obterProximoDelayAutomacao, aleatório).
async function estimarDelayMedioAutomacao() {
    const configRows = await db.all(
        "SELECT chave, valor FROM configuracoes WHERE chave IN ('automacao_delay_segundos', 'automacao_delay_modo', 'automacao_delay_velocidade')"
    );
    const configMap = Object.fromEntries(configRows.map(r => [r.chave, r.valor]));
    if (configMap.automacao_delay_modo !== 'aleatorio') return (parseInt(configMap.automacao_delay_segundos) || 5) * 1000;
    const [min, max] = FAIXAS_VELOCIDADE[configMap.automacao_delay_velocidade] || FAIXAS_VELOCIDADE.medio;
    return (min + max) / 2;
}

// Envia o conteúdo de uma etapa e decide o que vem a seguir: agenda a próxima
// etapa pra daqui a N dias, ou — se essa era a última — conclui a automação e
// remove a etiqueta que a disparou. Usada tanto pra matricular (etapa 1) quanto
// pra avançar (chamada pelo processarAutomacoesPendentes).
// Automação é só organizacional — NUNCA manda mensagem. Isso foi removido de
// propósito (não é uma trava de configuração, é estrutural) depois de um
// incidente real: a etapa mandava a mensagem e, sendo a última, removia a
// etiqueta ao concluir; 30min depois o robô que aplica a etiqueta
// "Aniversariante" via aniversário (Data de Nascimento) reaplicava porque a
// etiqueta tinha sumido, disparando a automação novamente — um contato
// chegou a receber a mesma mensagem ~10 vezes num loop antes de perceberem.
// Envio de mensagem de verdade agora é 100% manual, pela aba Disparos.
async function executarEtapaAutomacao(telefone, automacao, etapa) {
    const numLimpo = telefone.replace('@c.us','').replace('@lid','');
    await db.run(
        `INSERT INTO contato_automacao_estado (telefone, automacao_id, etapa_atual, entrou_em, proxima_execucao_em)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, NULL)
         ON CONFLICT(telefone, automacao_id) DO UPDATE SET etapa_atual = excluded.etapa_atual, entrou_em = excluded.entrou_em`,
        [numLimpo, automacao.id, etapa.ordem]
    );
    io.emit('automacoes_atualizadas');
}

// Pool de mensagens dessa automação: todas as "Mensagens Personalizadas"
// anexadas em qualquer etapa dela (via "Adicionar Mensagem" em Configurar
// Etapas) — não importa em qual etapa foram anexadas, contam pro mesmo pool.
async function poolMensagensDaAutomacao(automacaoId) {
    return db.all(
        `SELECT DISTINCT mp.* FROM automacao_etapas ae
         INNER JOIN automacao_etapa_mensagens aem ON aem.etapa_id = ae.id
         INNER JOIN mensagens_personalizadas mp ON mp.id = aem.mensagem_id
         WHERE ae.automacao_id = ?`,
        automacaoId
    );
}

let automacaoDisparoRodando = {};

// Disparo de verdade da automação: cada contato "em andamento" recebe UMA
// mensagem sorteada do pool (se ainda não tiver uma atribuída, sorteia agora
// e grava — assim uma tentativa que falhar tenta de novo com a MESMA
// mensagem, não sorteia outra à toa). Ao enviar com sucesso, sai da lista
// "em andamento" (conta como concluído) — não mexe em etiqueta nenhuma,
// essa continua sendo gerida só pelos robôs dedicados (Aniversariante,
// Inadimplente). Espaça os envios com o mesmo intervalo anti-bloqueio usado
// em Disparos e no restante do sistema.
async function dispararMensagensDaAutomacao(automacaoId) {
    const automacao = await db.get('SELECT * FROM automacoes WHERE id = ?', automacaoId);
    if (!automacao) return;
    const pool = await poolMensagensDaAutomacao(automacaoId);
    // ORDER BY entrou_em: fila FIFO, determinística — a tela de acompanhamento
    // usa a mesma ordem pra prever "quem é o próximo" e "horário previsto".
    const pendentes = await db.all('SELECT * FROM contato_automacao_estado WHERE automacao_id = ? ORDER BY entrou_em ASC', automacaoId);

    let primeiro = true;
    for (const estado of pendentes) {
        if (!primeiro) await delay(await obterProximoDelayAutomacao());
        primeiro = false;

        let mensagemId = estado.mensagem_id;
        if (!mensagemId) {
            if (pool.length === 0) continue; // nenhuma mensagem configurada nas etapas — nada pra mandar
            mensagemId = pool[Math.floor(Math.random() * pool.length)].id;
            await db.run('UPDATE contato_automacao_estado SET mensagem_id = ? WHERE telefone = ? AND automacao_id = ?', [mensagemId, estado.telefone, automacaoId]);
        }

        try {
            // client.sendMessage / resolverChatId (getNumberId) dependem do
            // WhatsApp Web via Puppeteer — se a página ficar num estado esquisito,
            // essas chamadas podem TRAVAR sem nunca resolver nem rejeitar (nem
            // sucesso, nem erro). Sem esse timeout, um único contato travado
          // parava a fila inteira pra sempre, silenciosamente, até reiniciar o
            // servidor (foi exatamente o que aconteceu com a automação
            // Aniversariante: 4 contatos ficaram com mensagem sorteada mas nenhum
            // foi enviado, o "disparo_ativo" ficou true pra sempre).
            await Promise.race([
                (async () => {
                    const msg = await db.get('SELECT * FROM mensagens_personalizadas WHERE id = ?', mensagemId);
                    if (!msg) return;
                    const numLimpo = estado.telefone;
                    const chatId = await resolverChatId(numLimpo);
                    const nome = await resolverNomeContato(numLimpo);
                    const primeiroNome = (nome && nome !== numLimpo) ? nome.split(' ')[0] : '';
                    const nomeCompleto = (nome && nome !== numLimpo) ? nome : '';
                    const matricula = await resolverMatriculaContato(numLimpo);
                    const inadimplente = await db.get(
                        'SELECT * FROM pacto_inadimplentes WHERE telefone = ? OR telefone = ? OR telefone = ?',
                        [numLimpo, `${numLimpo}@c.us`, `${numLimpo}@lid`]
                    );
                    const parcelasStr = inadimplente ? String(inadimplente.qtd_parcelas_atrasadas) : '';
                    const valorStr = inadimplente ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(inadimplente.valor_total_atrasado) : '';
                    const diasAtrasadosStr = inadimplente ? String(inadimplente.dias_atraso_mais_antiga) : '';
                    const texto = (msg.texto || '')
                        .replace(/\{nome\}/gi, primeiroNome).replace(/\[nome\]/gi, primeiroNome)
                        .replace(/\{nome_completo\}/gi, nomeCompleto).replace(/\[nome_completo\]/gi, nomeCompleto)
                        .replace(/\{matricula\}/gi, matricula).replace(/\[matricula\]/gi, matricula)
                        .replace(/\{parcelas\}/gi, parcelasStr).replace(/\[parcelas\]/gi, parcelasStr)
                        .replace(/\{valor\}/gi, valorStr).replace(/\[valor\]/gi, valorStr)
                        .replace(/\{dias_atrasados\}/gi, diasAtrasadosStr).replace(/\[dias_atrasados\]/gi, diasAtrasadosStr);

                    let sucesso = false;
                    if (msg.media_path) {
                        const mediaFullPath = path.join(__dirname, 'public', msg.media_path.replace(/^\//, ''));
                        if (fs.existsSync(mediaFullPath)) {
                            const media = MessageMedia.fromFilePath(mediaFullPath);
                            const sent = await client.sendMessage(chatId, media, texto ? { caption: texto } : undefined);
                            await registrarMensagemEnviada(numLimpo, texto || '[mídia]', nome, sent.id?._serialized);
                            sucesso = true;
                        } else {
                            console.error(`Disparo automação #${automacaoId}: mídia não encontrada (${msg.media_path}) pra ${numLimpo}`);
                        }
                    } else if (texto) {
                        const sent = await client.sendMessage(chatId, texto);
                        await registrarMensagemEnviada(numLimpo, texto, nome, sent.id?._serialized);
                        sucesso = true;
                    }

                    if (sucesso) {
                        await db.run('DELETE FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?', [numLimpo, automacaoId]);
                        await db.run('UPDATE automacoes SET total_concluidos = total_concluidos + 1 WHERE id = ?', automacaoId);
                        await db.run(
                            'INSERT INTO automacao_envios_log (automacao_id, telefone, nome, mensagem_nome) VALUES (?, ?, ?, ?)',
                            [automacaoId, numLimpo, nome, msg.nome]
                        );
                    }
                })(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout de 45s — provável travamento no WhatsApp Web/Puppeteer')), 45000))
            ]);
        } catch (e) {
            console.error(`Erro ao disparar mensagem da automação #${automacaoId} pra ${estado.telefone}:`, e.message);
            await db.run(
                'UPDATE contato_automacao_estado SET ultimo_erro = ? WHERE telefone = ? AND automacao_id = ?',
                [e.message, estado.telefone, automacaoId]
            );
        }
        io.emit('automacoes_atualizadas');
    }
}

// Matricula o contato em toda automação ativa vinculada à etiqueta recém-aplicada
// (se ainda não estiver matriculado) e dispara a etapa 1 na hora.
async function iniciarAutomacoesParaEtiqueta(telefone, etiquetaId) {
    const numLimpo = telefone.replace('@c.us','').replace('@lid','');
    const automacoes = await db.all('SELECT * FROM automacoes WHERE etiqueta_id = ? AND ativo = 1', etiquetaId);
    for (const automacao of automacoes) {
        const jaMatriculado = await db.get(
            'SELECT 1 FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?',
            [numLimpo, automacao.id]
        );
        if (jaMatriculado) continue;
        const etapa1 = await db.get('SELECT * FROM automacao_etapas WHERE automacao_id = ? ORDER BY ordem ASC LIMIT 1', automacao.id);
        if (!etapa1) continue;
        await executarEtapaAutomacao(numLimpo, automacao, etapa1);
    }
}

// iniciarAutomacoesParaEtiqueta só dispara no INSTANTE em que a etiqueta é
// aplicada — quem já tinha a etiqueta antes da automação existir (ou antes
// dela ganhar etapas) nunca é matriculado sozinho. Chamada depois de salvar
// etapas ou reativar uma automação, pra pegar esses contatos "atrasados".
async function enrolarContatosExistentesNaAutomacao(automacaoId) {
    const automacao = await db.get('SELECT * FROM automacoes WHERE id = ?', automacaoId);
    if (!automacao || !automacao.ativo) return;
    const etapa1 = await db.get('SELECT * FROM automacao_etapas WHERE automacao_id = ? ORDER BY ordem ASC LIMIT 1', automacaoId);
    if (!etapa1) return;
    const contatos = await db.all('SELECT telefone FROM contato_etiquetas WHERE etiqueta_id = ?', automacao.etiqueta_id);
    let primeiro = true;
    for (const c of contatos) {
        const jaMatriculado = await db.get(
            'SELECT 1 FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?',
            [c.telefone, automacaoId]
        );
        if (jaMatriculado) continue;
        if (!primeiro) await delay(await obterProximoDelayAutomacao());
        primeiro = false;
        // Um erro num contato não pode abortar o lote inteiro — os demais nunca
        // mais seriam pegos, já que essa varredura não roda sozinha de novo.
        try {
            await executarEtapaAutomacao(c.telefone, automacao, etapa1);
        } catch (e) {
            console.error(`Erro ao matricular ${c.telefone} na automação #${automacaoId}:`, e.message);
        }
    }
}

// Roda periodicamente: busca contatos cuja etapa atual já venceu (dias
// passaram) e avança pra próxima etapa da automação.
async function processarAutomacoesPendentes() {
    if (!db) return;
    try {
        const pendentes = await db.all(
            'SELECT * FROM contato_automacao_estado WHERE proxima_execucao_em IS NOT NULL AND proxima_execucao_em <= ?',
            new Date().toISOString()
        );
        // Se muitos contatos vencerem a etapa ao mesmo tempo (ex: todos entraram no
        // mesmo dia), manda um de cada vez com um respiro entre eles — evita um
        // estouro de mensagens simultâneas (risco de bloqueio no WhatsApp).
        let primeiro = true;
        for (const estado of pendentes) {
            if (!primeiro) await delay(await obterProximoDelayAutomacao());
            primeiro = false;
            const automacao = await db.get('SELECT * FROM automacoes WHERE id = ?', estado.automacao_id);
            if (!automacao || !automacao.ativo) {
                await db.run('DELETE FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?', [estado.telefone, estado.automacao_id]);
                continue;
            }
            // Etiqueta removida manualmente no meio do caminho — cancela a automação.
            const aindaTemEtiqueta = await db.get(
                'SELECT 1 FROM contato_etiquetas WHERE telefone = ? AND etiqueta_id = ?',
                [estado.telefone, automacao.etiqueta_id]
            );
            if (!aindaTemEtiqueta) {
                await db.run('DELETE FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?', [estado.telefone, estado.automacao_id]);
                continue;
            }
            const proximaEtapa = await db.get('SELECT * FROM automacao_etapas WHERE automacao_id = ? AND ordem = ?', [automacao.id, estado.etapa_atual + 1]);
            if (!proximaEtapa) {
                await db.run('DELETE FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?', [estado.telefone, estado.automacao_id]);
                continue;
            }
            // Um erro num contato não pode travar o lote inteiro — os demais ficariam
            // esperando mais 30min à toa por causa de um só que deu problema.
            try {
                await executarEtapaAutomacao(estado.telefone, automacao, proximaEtapa);
            } catch (e) {
                console.error(`Erro ao processar etapa de ${estado.telefone} na automação #${automacao.id}:`, e.message);
            }
        }
    } catch (e) {
        console.error('Erro ao processar automações pendentes:', e.message);
    }
}
setInterval(processarAutomacoesPendentes, 30 * 60 * 1000); // checa a cada 30 minutos
// Também roda logo depois de subir — cada deploy reinicia o processo e some
// com a contagem do setInterval, então sem isso um contato que já venceu a
// etapa fica esperando até 30min a mais só porque o servidor reiniciou.
setTimeout(processarAutomacoesPendentes, 60 * 1000);

// Força uma checada imediata (fora da espera de 30min) — útil pra testar sem
// precisar esperar, e como válvula de escape se o servidor reiniciar bastante.
app.post('/api/automacoes/processar-agora', async (req, res) => {
    try {
        await processarAutomacoesPendentes();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/automacoes', async (req, res) => {
    // total_concluidos é histórico (desde sempre) — "concluídos" na tela de
    // Disparos precisa ser SÓ do dia de hoje (horário de Brasília, UTC-3), não
    // acumulado, senão o card mostra "100" pra sempre mesmo que nada tenha sido
    // enviado hoje. Vem de automacao_envios_log (tem timestamp por envio).
    const automacoes = await db.all(`
        SELECT a.*, e.nome AS etiqueta_nome, e.cor AS etiqueta_cor,
               (SELECT COUNT(*) FROM automacao_etapas WHERE automacao_id = a.id) AS total_etapas,
               (SELECT COUNT(*) FROM contato_automacao_estado WHERE automacao_id = a.id) AS total_ativos,
               (SELECT COUNT(*) FROM automacao_envios_log
                  WHERE automacao_id = a.id
                    AND date(enviado_em, '-3 hours') = date('now', '-3 hours')) AS concluidos_hoje
        FROM automacoes a
        LEFT JOIN etiquetas e ON e.id = a.etiqueta_id
        ORDER BY a.criado_em DESC
    `);
    res.json(automacoes);
});

// =====================================
// MENSAGENS PERSONALIZADAS — aniversário automático
// =====================================
app.get('/api/mensagens-personalizadas', async (req, res) => {
    const mensagens = await db.all('SELECT * FROM mensagens_personalizadas ORDER BY criado_em DESC');
    res.json(mensagens);
});

app.post('/api/mensagens-personalizadas', async (req, res) => {
    const { nome, texto, media_path, media_tipo } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
    if (!texto || !texto.trim()) return res.status(400).json({ error: 'Mensagem é obrigatória.' });
    try {
        const result = await db.run(
            'INSERT INTO mensagens_personalizadas (nome, texto, media_path, media_tipo) VALUES (?, ?, ?, ?)',
            [nome.trim(), texto.trim(), media_path || null, media_tipo || null]
        );
        res.json({ success: true, id: result.lastID });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/mensagens-personalizadas/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, texto, media_path, media_tipo } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
    if (!texto || !texto.trim()) return res.status(400).json({ error: 'Mensagem é obrigatória.' });
    try {
        const result = await db.run(
            'UPDATE mensagens_personalizadas SET nome = ?, texto = ?, media_path = ?, media_tipo = ? WHERE id = ?',
            [nome.trim(), texto.trim(), media_path || null, media_tipo || null, id]
        );
        if (result.changes === 0) return res.status(404).json({ error: 'Mensagem não encontrada.' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/mensagens-personalizadas/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.run('DELETE FROM mensagens_personalizadas WHERE id = ?', id);
        await db.run('DELETE FROM mensagem_personalizada_enviada WHERE mensagem_id = ?', id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Etiqueta "Aniversariante" — aplicada sozinha em quem faz aniversário hoje,
// removida sozinha assim que o dia vira (mesmo ciclo que dispara as mensagens
// de aniversário). Fica disponível pra filtrar Contatos ou disparar outras
// Automações vinculadas a ela.
const NOME_ETIQUETA_ANIVERSARIANTE = 'Aniversariante';

async function garantirEtiquetaAniversariante() {
    const existente = await db.get('SELECT id FROM etiquetas WHERE LOWER(nome) = LOWER(?)', NOME_ETIQUETA_ANIVERSARIANTE);
    if (existente) return existente.id;
    const result = await db.run('INSERT INTO etiquetas (nome, cor) VALUES (?, ?)', [NOME_ETIQUETA_ANIVERSARIANTE, '#EC4899']);
    return result.lastID;
}

async function processarEtiquetaAniversariantes() {
    if (!db) return;
    try {
        const etiquetaId = await garantirEtiquetaAniversariante();
        const hojeMD = moment.tz('America/Sao_Paulo').format('MM-DD');

        const aniversariantesHoje = await db.all(
            `SELECT telefone FROM leads WHERE data_nascimento IS NOT NULL AND strftime('%m-%d', data_nascimento) = ?`,
            hojeMD
        );
        // Aplicar a etiqueta pode disparar Automações vinculadas na hora
        // (iniciarAutomacoesParaEtiqueta) — com um respiro entre cada contato pra
        // não mandar tudo em rajada simultânea quando várias pessoas fazem
        // aniversário no mesmo dia (risco de bloqueio no WhatsApp).
        let primeiro = true;
        for (const lead of aniversariantesHoje) {
            const numLimpo = lead.telefone.replace('@c.us', '').replace('@lid', '');
            const jaTem = await db.get('SELECT 1 FROM contato_etiquetas WHERE telefone = ? AND etiqueta_id = ?', [numLimpo, etiquetaId]);
            if (jaTem) continue;
            if (!primeiro) await delay(await obterProximoDelayAutomacao());
            primeiro = false;
            try {
                await aplicarEtiquetaContato(numLimpo, etiquetaId);
            } catch (e) {
                console.error(`Erro ao etiquetar aniversariante ${numLimpo}:`, e.message);
            }
        }

        // Some com a etiqueta de quem a tem mas não faz aniversário hoje — o dia virou.
        const comEtiqueta = await db.all('SELECT telefone FROM contato_etiquetas WHERE etiqueta_id = ?', etiquetaId);
        for (const c of comEtiqueta) {
            const lead = await db.get(
                'SELECT data_nascimento FROM leads WHERE telefone = ? OR telefone = ? OR telefone = ?',
                [c.telefone, `${c.telefone}@c.us`, `${c.telefone}@lid`]
            );
            const aniversarioHoje = lead?.data_nascimento && String(lead.data_nascimento).slice(5, 10) === hojeMD;
            if (!aniversarioHoje) await removerEtiquetaContato(c.telefone, etiquetaId);
        }
    } catch (e) {
        console.error('Erro ao processar etiqueta de aniversariantes:', e.message);
    }
}

// "Mensagens Personalizadas" é só uma biblioteca de conteúdo — quem manda de
// verdade é a Automação (campo "Adicionar Mensagem" na etapa, puxando daqui).
// Esse ciclo só cuida de etiquetar/desetiquetar aniversariantes; nada aqui
// envia mensagem diretamente.
setInterval(processarEtiquetaAniversariantes, 30 * 60 * 1000);
setTimeout(processarEtiquetaAniversariantes, 90 * 1000);

app.post('/api/mensagens-personalizadas/processar-agora', async (req, res) => {
    try {
        await processarEtiquetaAniversariantes();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/automacoes', async (req, res) => {
    const { nome, etiqueta_id, horario_inicio, horario_fim } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
    if (!etiqueta_id) return res.status(400).json({ error: 'Selecione uma etiqueta.' });
    try {
        const result = await db.run(
            'INSERT INTO automacoes (nome, etiqueta_id, horario_inicio, horario_fim) VALUES (?, ?, ?, ?)',
            [nome.trim(), etiqueta_id, horario_inicio || null, horario_fim || null]
        );
        const nova = await db.get('SELECT a.*, e.nome AS etiqueta_nome, e.cor AS etiqueta_cor, 0 AS total_etapas, 0 AS total_ativos FROM automacoes a LEFT JOIN etiquetas e ON e.id = a.etiqueta_id WHERE a.id = ?', result.lastID);
        io.emit('automacoes_atualizadas');
        res.json(nova);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/automacoes/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, etiqueta_id, ativo, horario_inicio, horario_fim, remove_etiqueta_ao_concluir } = req.body;
    // Update parcial: só mexe no campo que veio no body — assim o toggle "Ativa"
    // (que só manda { ativo }) não apaga a janela de horário configurada, e vice-versa.
    const sets = [];
    const params = [];
    if (nome !== undefined) { sets.push('nome = ?'); params.push(nome.trim()); }
    if (etiqueta_id !== undefined) { sets.push('etiqueta_id = ?'); params.push(etiqueta_id); }
    if (ativo !== undefined) { sets.push('ativo = ?'); params.push(ativo ? 1 : 0); }
    if (horario_inicio !== undefined) { sets.push('horario_inicio = ?'); params.push(horario_inicio || null); }
    if (horario_fim !== undefined) { sets.push('horario_fim = ?'); params.push(horario_fim || null); }
    if (remove_etiqueta_ao_concluir !== undefined) { sets.push('remove_etiqueta_ao_concluir = ?'); params.push(remove_etiqueta_ao_concluir ? 1 : 0); }
    if (sets.length === 0) return res.json({ success: true });
    try {
        params.push(id);
        await db.run(`UPDATE automacoes SET ${sets.join(', ')} WHERE id = ?`, params);
        io.emit('automacoes_atualizadas');
        res.json({ success: true });
        // Reativou a automação: pega quem já tem a etiqueta mas ainda não foi matriculado.
        if (ativo) enrolarContatosExistentesNaAutomacao(id).catch(e => console.error('Erro ao matricular contatos existentes:', e.message));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/automacoes/:id', async (req, res) => {
    const { id } = req.params;
    await db.run('DELETE FROM contato_automacao_estado WHERE automacao_id = ?', id);
    await db.run('DELETE FROM automacao_etapas WHERE automacao_id = ?', id);
    await db.run('DELETE FROM automacoes WHERE id = ?', id);
    io.emit('automacoes_atualizadas');
    res.json({ success: true });
});

app.get('/api/automacoes/:id/etapas', async (req, res) => {
    const { id } = req.params;
    const etapas = await db.all('SELECT * FROM automacao_etapas WHERE automacao_id = ? ORDER BY ordem ASC', id);
    for (const etapa of etapas) {
        etapa.grupo_etiquetas = (await db.all('SELECT etiqueta_id FROM automacao_etapa_grupos WHERE etapa_id = ?', etapa.id)).map(r => r.etiqueta_id);
        etapa.mensagens = (await db.all('SELECT mensagem_id FROM automacao_etapa_mensagens WHERE etapa_id = ?', etapa.id)).map(r => r.mensagem_id);
    }
    res.json(etapas);
});

// Força matricular agora quem já tem a etiqueta da automação mas ficou de fora
// (etiqueta aplicada antes da automação existir/ter etapas) — mesmo caso que
// roda sozinho ao salvar etapas ou reativar, só que sob demanda.
// Roda em background (não espera terminar pra responder) — o envio é
// espaçado de propósito (30-120s por contato, mesmo intervalo de Disparos)
// pra não arriscar bloqueio no WhatsApp, então com vários contatos isso pode
// levar minutos. O front acompanha via socket "automacoes_atualizadas", que
// já dispara a cada contato matriculado.
app.post('/api/automacoes/:id/matricular-existentes', async (req, res) => {
    const { id } = req.params;
    res.json({ success: true });
    enrolarContatosExistentesNaAutomacao(id).catch(e => console.error('Erro ao matricular contatos existentes:', e.message));
});

// Automação aqui só organiza contatos por etiqueta — não manda mensagem
// nenhuma (isso é papel de Disparos). "Importar" só registra o contato em
// contato_automacao_estado (aparece em "contatos em andamento"), sem chamar
// executarEtapaAutomacao — instantâneo, sem fila, sem envio.
async function importarContatosParaAutomacao(automacaoId) {
    const automacao = await db.get('SELECT * FROM automacoes WHERE id = ?', automacaoId);
    if (!automacao) return { importados: 0 };
    const contatos = await db.all('SELECT telefone FROM contato_etiquetas WHERE etiqueta_id = ?', automacao.etiqueta_id);
    let importados = 0;
    for (const c of contatos) {
        const jaMatriculado = await db.get(
            'SELECT 1 FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?',
            [c.telefone, automacaoId]
        );
        if (jaMatriculado) continue;
        await db.run(
            `INSERT INTO contato_automacao_estado (telefone, automacao_id, etapa_atual, entrou_em, proxima_execucao_em)
             VALUES (?, ?, 0, CURRENT_TIMESTAMP, NULL)`,
            [c.telefone, automacaoId]
        );
        importados++;
    }
    return { importados };
}

app.post('/api/automacoes/:id/importar-contatos', async (req, res) => {
    const { id } = req.params;
    try {
        const resultado = await importarContatosParaAutomacao(id);
        io.emit('automacoes_atualizadas');
        res.json({ success: true, ...resultado });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Dispara de verdade os contatos "em andamento" dessa automação — cada um
// recebe a mensagem sorteada pra ele (ver dispararMensagensDaAutomacao).
// Roda em background (espaçado, pode levar minutos) — front acompanha pelo
// socket "automacoes_atualizadas", que já dispara a cada contato concluído.
app.post('/api/automacoes/:id/disparar', async (req, res) => {
    const { id } = req.params;
    if (automacaoDisparoRodando[id]) return res.status(400).json({ error: 'Já tem um disparo rodando pra essa automação.' });
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp não está conectado.' });
    automacaoDisparoRodando[id] = true;
    res.json({ success: true });
    dispararMensagensDaAutomacao(id)
        .catch(e => console.error('Erro ao disparar automação:', e.message))
        .finally(() => { automacaoDisparoRodando[id] = false; });
});

// Lista quem já tem a etiqueta que dispara essa automação, com as etiquetas
// de cada um e se já está matriculado ou não — pra revisar antes de mandar
// matricular quem falta.
app.get('/api/automacoes/:id/contatos-com-etiqueta', async (req, res) => {
    const { id } = req.params;
    try {
        const automacao = await db.get('SELECT * FROM automacoes WHERE id = ?', id);
        if (!automacao) return res.status(404).json({ error: 'Automação não encontrada.' });
        const contatos = await db.all('SELECT telefone FROM contato_etiquetas WHERE etiqueta_id = ?', automacao.etiqueta_id);
        const resultado = [];
        for (const c of contatos) {
            const nome = await resolverNomeContato(c.telefone);
            const estado = await db.get('SELECT mensagem_id FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?', [c.telefone, id]);
            const etiquetas = await db.all(
                `SELECT e.id, e.nome, e.cor FROM contato_etiquetas ce INNER JOIN etiquetas e ON e.id = ce.etiqueta_id WHERE ce.telefone = ?`,
                c.telefone
            );
            let mensagemNome = null;
            if (estado?.mensagem_id) {
                const msg = await db.get('SELECT nome FROM mensagens_personalizadas WHERE id = ?', estado.mensagem_id);
                mensagemNome = msg?.nome || null;
            }
            resultado.push({ telefone: c.telefone, nome: nome || c.telefone, matriculado: !!estado, mensagem_nome: mensagemNome, etiquetas });
        }
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Limpeza pontual: cancela quem ficou "preso" esperando a janela de um dia
// que já passou (etapa_atual = 0 = nunca chegou a enviar nada) — resquício de
// antes da correção que parou de empurrar envio pra dia seguinte.
app.post('/api/automacoes/:id/cancelar-atrasados', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.run('DELETE FROM contato_automacao_estado WHERE automacao_id = ? AND etapa_atual = 0', id);
        io.emit('automacoes_atualizadas');
        res.json({ success: true, removidos: result.changes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Acompanhamento: quem está em andamento na automação agora, em que etapa cada
// um está e quando recebe a próxima mensagem — pra tela de Disparos monitorar.
app.get('/api/automacoes/:id/progresso', async (req, res) => {
    const { id } = req.params;
    try {
        const automacao = await db.get('SELECT * FROM automacoes WHERE id = ?', id);
        if (!automacao) return res.status(404).json({ error: 'Automação não encontrada.' });

        const totalEtapas = (await db.get('SELECT COUNT(*) AS c FROM automacao_etapas WHERE automacao_id = ?', id)).c;
        // Mesma ordem FIFO usada no disparo de verdade (dispararMensagensDaAutomacao)
        // — garante que "horário previsto" abaixo reflita quem é enviado primeiro.
        const estados = await db.all(
            'SELECT telefone, etapa_atual, entrou_em, mensagem_id, ultimo_erro FROM contato_automacao_estado WHERE automacao_id = ? ORDER BY entrou_em ASC',
            id
        );

        const nomePorTelefone = new Map();
        const nomesConversas = await db.all(`
            SELECT c.telefone, c.nome FROM conversas c
            INNER JOIN (SELECT telefone, MAX(ts) AS max_ts FROM conversas GROUP BY telefone) latest
                ON c.telefone = latest.telefone AND c.ts = latest.max_ts
        `);
        nomesConversas.forEach(n => nomePorTelefone.set(n.telefone, n.nome));
        const leadsComNome = await db.all('SELECT telefone, nome FROM leads WHERE nome IS NOT NULL');
        leadsComNome.forEach(l => nomePorTelefone.set(l.telefone.replace('@c.us','').replace('@lid',''), l.nome));

        // Nome da mensagem já sorteada pra cada contato (sorteio é lento — só
        // acontece quando o disparo passa por ele, ver dispararMensagensDaAutomacao)
        // — quem ainda não chegou nesse ponto mostra null (front exibe "será sorteada").
        const pool = await poolMensagensDaAutomacao(id);
        const nomeMensagemPorId = new Map(pool.map(m => [m.id, m.nome]));

        // "Horário previsto" só faz sentido enquanto o disparo está rodando de
        // verdade — sem isso, a fila pode ficar parada por dias esperando alguém
        // clicar em "Disparar Mensagens", e prever um horário seria enganoso.
        const disparoAtivo = !!automacaoDisparoRodando[id];
        const delayMedioMs = disparoAtivo ? await estimarDelayMedioAutomacao() : 0;
        let acumuladoMs = 0;

        // Primeiro da fila é enviado quase na hora (o disparo real só espera
        // ANTES do 2º em diante — ver "if (!primeiro) await delay(...)" em
        // dispararMensagensDaAutomacao) — daí o acúmulo começar depois do 1º.
        const contatos = estados.map((e, i) => {
            if (i > 0) acumuladoMs += delayMedioMs;
            return {
                telefone: e.telefone,
                nome: nomePorTelefone.get(e.telefone) || e.telefone,
                etapa_atual: e.etapa_atual,
                entrou_em: sqliteTsParaIso(e.entrou_em),
                mensagem_nome: e.mensagem_id ? (nomeMensagemPorId.get(e.mensagem_id) || null) : null,
                horario_previsto: disparoAtivo ? new Date(Date.now() + acumuladoMs).toISOString() : null,
                ultimo_erro: e.ultimo_erro || null
            };
        });

        const enviadasRaw = await db.all(
            'SELECT telefone, nome, mensagem_nome, enviado_em FROM automacao_envios_log WHERE automacao_id = ? ORDER BY enviado_em DESC LIMIT 50',
            id
        );
        const enviadas = enviadasRaw.map(e => ({ ...e, enviado_em: sqliteTsParaIso(e.enviado_em) }));

        res.json({
            total_etapas: totalEtapas,
            total_ativos: estados.length,
            total_concluidos: automacao.total_concluidos || 0,
            disparo_ativo: disparoAtivo,
            contatos,
            enviadas
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Substitui todas as etapas de uma automação de uma vez (o editor manda a lista
// inteira já na ordem final) — mais simples que expor create/update/reorder
// separados pra cada etapa individualmente.
app.put('/api/automacoes/:id/etapas', async (req, res) => {
    const { id } = req.params;
    const { etapas } = req.body;
    if (!Array.isArray(etapas) || etapas.length === 0) return res.status(400).json({ error: 'A automação precisa de pelo menos uma etapa.' });
    if (etapas.some(e => !e.texto?.trim() && !e.media_path && (!e.mensagens || e.mensagens.length === 0))) {
        return res.status(400).json({ error: 'Toda etapa precisa de uma mensagem, um arquivo anexado ou mensagens personalizadas selecionadas.' });
    }
    try {
        // Etapas são recriadas do zero a cada save (IDs novos) — limpa os vínculos
        // de grupo/mensagens das etapas antigas antes de apagá-las, senão sobra lixo.
        const etapasAntigas = await db.all('SELECT id FROM automacao_etapas WHERE automacao_id = ?', id);
        for (const ea of etapasAntigas) {
            await db.run('DELETE FROM automacao_etapa_grupos WHERE etapa_id = ?', ea.id);
            await db.run('DELETE FROM automacao_etapa_mensagens WHERE etapa_id = ?', ea.id);
        }
        await db.run('DELETE FROM automacao_etapas WHERE automacao_id = ?', id);
        let ordem = 1;
        for (const etapa of etapas) {
            const result = await db.run(
                'INSERT INTO automacao_etapas (automacao_id, ordem, texto, media_path, media_tipo, dias_proxima_etapa, unidade_tempo, envio_aleatorio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [id, ordem, etapa.texto || null, etapa.media_path || null, etapa.media_tipo || null, parseInt(etapa.dias_proxima_etapa) || 1, etapa.unidade_tempo === 'horas' ? 'horas' : 'dias', etapa.envio_aleatorio ? 1 : 0]
            );
            const etapaId = result.lastID;
            for (const etiquetaId of (etapa.grupo_etiquetas || [])) {
                await db.run('INSERT OR IGNORE INTO automacao_etapa_grupos (etapa_id, etiqueta_id) VALUES (?, ?)', [etapaId, etiquetaId]);
            }
            for (const mensagemId of (etapa.mensagens || [])) {
                await db.run('INSERT OR IGNORE INTO automacao_etapa_mensagens (etapa_id, mensagem_id) VALUES (?, ?)', [etapaId, mensagemId]);
            }
            ordem++;
        }
        io.emit('automacoes_atualizadas');
        res.json({ success: true });
        // Acabou de ganhar etapa 1: pega quem já tem a etiqueta da automação mas
        // ainda não foi matriculado (a etiqueta pode ter sido aplicada antes de
        // a automação existir ou antes dela ter etapas configuradas).
        enrolarContatosExistentesNaAutomacao(id).catch(e => console.error('Erro ao matricular contatos existentes:', e.message));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =====================================
// API REST — HISTÓRICO DE MENSAGENS ENVIADAS
// =====================================
app.get('/api/mensagens/enviadas', async (req, res) => {
    const limite = Math.min(parseInt(req.query.limit) || 200, 500);
    const mensagens = await db.all('SELECT * FROM mensagens_enviadas ORDER BY id DESC LIMIT ?', limite);
    res.json(mensagens);
});

// =====================================
// API REST — CONVERSAS (GERENCIADOR / BATE PAPO AO VIVO)
// =====================================

// Lista todas as conversas (uma por contato, com último texto, não lidas,
// status Aberta/Fechada e etiquetas) — usado tanto pela rota REST quanto
// pela carga inicial via Socket.IO, pra não duplicar a query em dois lugares.
async function listarConversasComEtiquetas() {
    // A "última mensagem" ideal pra prévia da lista é a última com conteúdo de
    // verdade — não um ruído de protocolo (tipo='text' com texto placeholder)
    // que às vezes fica registrado por cima do histórico real de um contato
    // (ver fix de causa raiz em client.on('message')). latest_real pega a mais
    // recente IGNORANDO esses placeholders; latest_any é o fallback pro raro
    // caso de um telefone cujo histórico inteiro seja placeholder (não deveria
    // sobrar depois da limpeza, mas evita o contato simplesmente sumir da lista).
    // O "nome" a mostrar não necessariamente vem da mesma linha da última
    // mensagem real: uma mensagem enviada pelo robô pode ter sido registrada
    // antes do nome do contato resolver (nome = telefone cru), enquanto uma
    // mensagem de sincronização posterior já tinha o pushname certo — sem essa
    // separação, o contato aparece na lista com o telefone no lugar do nome
    // (ex: Cleonice aparecia como "554299878939"). melhor_nome pega o nome
    // mais recente entre os que têm pelo menos uma letra (nome de verdade).
    const conversas = await db.all(`
        WITH latest_real AS (
            SELECT telefone, MAX(ts) AS max_ts
            FROM conversas
            WHERE NOT (tipo = 'text' AND texto IN ('[text]', '[mensagem sem texto]'))
            GROUP BY telefone
        ),
        latest_any AS (
            SELECT telefone, MAX(ts) AS max_ts
            FROM conversas
            GROUP BY telefone
        ),
        melhor_nome AS (
            SELECT telefone, MAX(ts) AS max_ts
            FROM conversas
            WHERE nome GLOB '*[^0-9]*'
            GROUP BY telefone
        )
        SELECT
            c.telefone,
            COALESCE(mn.nome, c.nome) AS nome,
            c.texto AS ultimo_texto,
            c.direcao AS ultima_direcao,
            c.tipo AS ultimo_tipo,
            c.ts AS ultimo_ts,
            (SELECT COUNT(*) FROM conversas WHERE telefone = c.telefone AND lida = 0 AND direcao = 'in') AS nao_lidas,
            (CASE WHEN ch.telefone IS NULL THEN 0 ELSE 1 END) AS assumida_humano,
            COALESCE(cs.status, 'aberta') AS status
        FROM conversas c
        INNER JOIN (
            SELECT la.telefone, COALESCE(lr.max_ts, la.max_ts) AS max_ts
            FROM latest_any la
            LEFT JOIN latest_real lr ON lr.telefone = la.telefone
        ) latest ON c.telefone = latest.telefone AND c.ts = latest.max_ts
        LEFT JOIN (
            SELECT cn.telefone, cn.nome
            FROM conversas cn
            INNER JOIN melhor_nome mnn ON mnn.telefone = cn.telefone AND mnn.max_ts = cn.ts
            GROUP BY cn.telefone
        ) mn ON mn.telefone = c.telefone
        LEFT JOIN conversas_humano ch ON ch.telefone = c.telefone
        LEFT JOIN conversas_status cs ON cs.telefone = c.telefone
        GROUP BY c.telefone
        ORDER BY c.ts DESC
        LIMIT 200
    `);

    const etiquetasRows = await db.all(`
        SELECT ce.telefone, e.id, e.nome, e.cor
        FROM contato_etiquetas ce
        INNER JOIN etiquetas e ON e.id = ce.etiqueta_id
    `);
    const etiquetasPorTelefone = new Map();
    etiquetasRows.forEach(r => {
        if (!etiquetasPorTelefone.has(r.telefone)) etiquetasPorTelefone.set(r.telefone, []);
        etiquetasPorTelefone.get(r.telefone).push({ id: r.id, nome: r.nome, cor: r.cor });
    });

    return conversas.map(c => ({ ...c, etiquetas: etiquetasPorTelefone.get(c.telefone) || [] }));
}

// Lista todas as conversas (uma por contato, com o último texto e count de não lidas)
app.get('/api/conversas', async (req, res) => {
    try {
        const conversas = await listarConversasComEtiquetas();
        res.json(conversas);
    } catch(err) {
        console.error('Erro /api/conversas:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Limpeza pontual das "conversas fantasma" salvas antes do filtro de tipo de
// mensagem existir (ruído de protocolo do WhatsApp: sincronização entre
// aparelhos, notificação de criptografia, IDs sintéticos de outras rotinas,
// etc). O critério ANTERIOR (nome == telefone na msg mais recente) foi
// TESTADO EM PRODUÇÃO e provou ser perigoso: nome==telefone também acontece
// pra contato real que nunca teve pushname resolvido — pegou 34 conversas
// reais (telefones brasileiros válidos, com cobrança/boas-vindas de verdade)
// junto com as 10 realmente falsas. Critério novo: um telefone de WhatsApp
// BR real é '55' + DDD(2) + número(8 ou 9) = 12 ou 13 dígitos, só números.
// Qualquer coisa fora desse formato (IDs sintéticos de 14+ dígitos, ':xx' de
// grupo/broadcast mal filtrado, telefone '0') não é uma conversa de verdade,
// independente do nome ou conteúdo do texto.
const TELEFONE_BR_GLOB_12 = `55${'[0-9]'.repeat(10)}`;
const TELEFONE_BR_GLOB_13 = `55${'[0-9]'.repeat(11)}`;
// Segundo critério (além do formato de telefone inválido): telefone com
// formato válido cujo histórico INTEIRO é placeholder (nunca teve conteúdo
// real, nem imagem/áudio/etc — só ruído tipo=text com texto vazio). Cobre
// tanto o caso do nome vindo de ID de @lid (contato.number, já corrigido no
// handler 'message') quanto o caso do pushname ter resolvido normal mas a
// "conversa" em si nunca ter sido real (ex: Daize Gusso, Cleonice — só têm 1
// mensagem no banco, um ping de sincronização, nunca uma mensagem de
// verdade). Exigir que TODO o histórico seja placeholder (não só a última
// mensagem) é o que garante nunca apagar conversa de gente real que teve
// UMA mensagem vazia no meio de um histórico real (ex: Fulano com "[text]"
// seguido de "Oi bom dia" continua de fora).
const QUERY_FANTASMAS = `
    SELECT telefone, nome, texto FROM conversas c1
    WHERE id = (SELECT MAX(id) FROM conversas c2 WHERE c2.telefone = c1.telefone)
      AND (
        (telefone NOT GLOB ? AND telefone NOT GLOB ?)
        OR NOT EXISTS (
          SELECT 1 FROM conversas c3 WHERE c3.telefone = c1.telefone
            AND NOT (c3.tipo = 'text' AND c3.texto IN ('[text]', '[mensagem sem texto]'))
        )
      )
`;
app.get('/api/conversas/fantasmas', async (req, res) => {
    try {
        const candidatos = await db.all(QUERY_FANTASMAS, [TELEFONE_BR_GLOB_12, TELEFONE_BR_GLOB_13]);
        res.json(candidatos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/conversas/fantasmas', async (req, res) => {
    try {
        const candidatos = await db.all(QUERY_FANTASMAS.replace('SELECT telefone, nome, texto', 'SELECT telefone'), [TELEFONE_BR_GLOB_12, TELEFONE_BR_GLOB_13]);
        const telefones = candidatos.map(c => c.telefone);
        let mensagensRemovidas = 0;
        if (telefones.length > 0) {
            const placeholders = telefones.map(() => '?').join(',');
            const result = await db.run(`DELETE FROM conversas WHERE telefone IN (${placeholders})`, telefones);
            mensagensRemovidas = result.changes;
        }
        res.json({ success: true, contatos_removidos: telefones.length, mensagens_removidas: mensagensRemovidas, telefones });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Assume/libera uma conversa manualmente: enquanto assumida, o robô não
// responde automaticamente esse contato (tem prioridade sobre horário e
// sobre o override global "Ativar Robô").
app.post('/api/conversas/:telefone/assumir', async (req, res) => {
    const { telefone } = req.params;
    await db.run('INSERT OR IGNORE INTO conversas_humano (telefone) VALUES (?)', telefone);
    io.emit('conversa_assumida', { telefone, assumida: true });
    res.json({ success: true });
});

app.post('/api/conversas/:telefone/liberar', async (req, res) => {
    const { telefone } = req.params;
    await db.run('DELETE FROM conversas_humano WHERE telefone = ?', telefone);
    io.emit('conversa_assumida', { telefone, assumida: false });
    res.json({ success: true });
});

// Histórico de mensagens de um contato
app.get('/api/conversas/:telefone', async (req, res) => {
    const { telefone } = req.params;
    const limite = Math.min(parseInt(req.query.limit) || 100, 500);
    try {
        const msgs = await db.all(
            'SELECT * FROM conversas WHERE telefone = ? ORDER BY ts ASC LIMIT ?',
            [telefone, limite]
        );
        // SQLite guarda manual como 0/1 — o front compara com "=== true", então
        // precisa virar boolean de verdade aqui, senão a bolha nunca marca
        // "👤 Atendente" mesmo quando manual=1 no banco.
        res.json(msgs.map(m => ({ ...m, manual: !!m.manual })));
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Envia mensagem manual pelo dashboard para um contato
app.post('/api/conversas/:telefone/enviar', async (req, res) => {
    // Normaliza ANTES de gravar (mesmo se o painel do atendente ainda tiver
    // uma aba antiga aberta com o telefone sem o 9) — sem isso, uma resposta
    // manual reabre/recria a conversa no formato errado mesmo depois de já
    // ter sido mesclada, porque o envio de verdade (resolverChatId) faz sua
    // própria busca ao vivo no WhatsApp e funciona de qualquer jeito, mas o
    // registro em "conversas" usava o telefone cru da URL, não o normalizado.
    const telefone = normalizarTelefoneBR(req.params.telefone);
    const { texto } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ error: 'Texto obrigatório.' });
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp não está conectado.' });
    try {
        const chatId = telefone.includes('@') ? telefone : await resolverChatId(telefone);
        const sentMsg = await client.sendMessage(chatId, texto.trim());
        const nome = await resolverNomeContato(telefone);
        await registrarMensagemEnviada(telefone, texto.trim(), nome, sentMsg.id?._serialized, true);
        res.json({ success: true });
    } catch(err) {
        console.error('Erro envio manual:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Marca todas as mensagens de um contato como lidas
app.post('/api/conversas/:telefone/lida', async (req, res) => {
    const { telefone } = req.params;
    try {
        await db.run('UPDATE conversas SET lida = 1 WHERE telefone = ? AND direcao = "in"', telefone);
        io.emit('conversa_lida', { telefone });
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Resolve (fecha) ou reabre uma conversa. Uma conversa fechada some da aba
// "Abertas" mas reabre sozinha assim que o contato manda mensagem de novo
// (ver client.on('message') mais abaixo).
app.post('/api/conversas/:telefone/status', async (req, res) => {
    const { telefone } = req.params;
    const { status } = req.body;
    if (status !== 'aberta' && status !== 'fechada') return res.status(400).json({ error: 'status inválido.' });
    try {
        await db.run(
            'INSERT INTO conversas_status (telefone, status, atualizado_em) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(telefone) DO UPDATE SET status = excluded.status, atualizado_em = CURRENT_TIMESTAMP',
            [telefone, status]
        );
        io.emit('conversa_status_atualizada', { telefone, status });
        res.json({ success: true, status });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Apaga todo o histórico de uma conversa — ação irreversível, usada com
// moderação pelo botão "Excluir" no Bate Papo ao Vivo.
app.delete('/api/conversas/:telefone', async (req, res) => {
    const { telefone } = req.params;
    try {
        await db.run('DELETE FROM conversas WHERE telefone = ?', telefone);
        await db.run('DELETE FROM conversas_humano WHERE telefone = ?', telefone);
        await db.run('DELETE FROM conversas_status WHERE telefone = ?', telefone);
        io.emit('conversa_excluida', { telefone });
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Envia um arquivo (imagem, documento, etc.) pelo dashboard para um contato
app.post('/api/conversas/:telefone/enviar-arquivo', upload.single('arquivo'), async (req, res) => {
    const telefone = normalizarTelefoneBR(req.params.telefone); // ver comentário na rota /enviar
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp não está conectado.' });
    try {
        const chatId = telefone.includes('@') ? telefone : await resolverChatId(telefone);
        const media = MessageMedia.fromFilePath(req.file.path);
        const legenda = (req.body.legenda || '').trim();
        const sentMsg = await client.sendMessage(chatId, media, legenda ? { caption: legenda } : undefined);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        const tipo = req.file.mimetype.startsWith('image/') ? 'image'
            : req.file.mimetype.startsWith('video/') ? 'video'
            : req.file.mimetype.startsWith('audio/') ? 'audio'
            : 'document';
        const nome = await resolverNomeContato(telefone);
        const numeroLimpo = telefone.replace('@c.us', '').replace('@lid', '');
        marcarMensagemComoDoSistema(sentMsg.id?._serialized);
        await salvarNaConversa(numeroLimpo, nome, 'out', legenda || req.file.originalname, tipo, null, true);
        io.emit('stats', stats);
        res.json({ success: true });
    } catch(err) {
        console.error('Erro ao enviar arquivo:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// =====================================
// API REST — BROADCAST (DISPAROS EM MASSA)
// =====================================
let broadcastRunning = false;
let broadcastProgress = { total: 0, sent: 0, failed: 0, running: false };

app.get('/api/broadcast/status', (req, res) => res.json(broadcastProgress));

app.post('/api/broadcast/start', upload.single('media'), async (req, res) => {
    if (broadcastRunning) return res.status(400).json({ error: 'Um disparo já está em andamento.' });
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp não está conectado.' });

    const { numeros, mensagem, delay_ms, delay_modo, delay_velocidade } = req.body;
    const listaNumeros = numeros.split('\n').map(n => n.trim().replace(/\D/g, '')).filter(n => n.length >= 10);

    if (listaNumeros.length === 0) return res.status(400).json({ error: 'Nenhum número válido encontrado.' });
    if (!mensagem) return res.status(400).json({ error: 'Mensagem obrigatória.' });

    const mediaFile = req.file ? { path: req.file.path, mimetype: req.file.mimetype, filename: req.file.originalname } : null;

    // Modo fixo: mesmo intervalo sempre. Modo aleatório: um valor novo dentro
    // da faixa escolhida a cada mensagem — menos previsível, reduz risco de bloqueio.
    const delayFixoMs = parseInt(delay_ms) || 5000;
    function proximoDelay() {
        if (delay_modo !== 'aleatorio') return delayFixoMs;
        const [min, max] = FAIXAS_VELOCIDADE[delay_velocidade] || FAIXAS_VELOCIDADE.medio;
        return Math.floor(min + Math.random() * (max - min));
    }

    broadcastRunning = true;
    broadcastProgress = { total: listaNumeros.length, sent: 0, failed: 0, running: true };
    io.emit('broadcast_progress', broadcastProgress);

    res.json({ success: true, total: listaNumeros.length });

    // Executa o broadcast de forma assíncrona
    (async () => {
        for (const numero of listaNumeros) {
            if (!broadcastRunning) break;
            try {
                const numeroCompleto = numero.startsWith('55') ? numero : `55${numero}`;
                const chatId = await resolverChatId(numeroCompleto);
                await client.sendMessage(chatId, mensagem);

                if (mediaFile) {
                    const media = MessageMedia.fromFilePath(mediaFile.path);
                    await client.sendMessage(chatId, media);
                }

                broadcastProgress.sent++;
            } catch (err) {
                console.error(`❌ Falha ao enviar para ${numero}:`, err.message);
                broadcastProgress.failed++;
            }
            io.emit('broadcast_progress', broadcastProgress);
            await delay(proximoDelay());
        }

        broadcastProgress.running = false;
        broadcastRunning = false;
        if (mediaFile && fs.existsSync(mediaFile.path)) fs.unlinkSync(mediaFile.path);
        io.emit('broadcast_progress', broadcastProgress);
        io.emit('broadcast_done', broadcastProgress);
        console.log(`✅ Broadcast finalizado: ${broadcastProgress.sent} enviados, ${broadcastProgress.failed} falhas.`);
    })();
});

app.post('/api/broadcast/stop', (req, res) => {
    broadcastRunning = false;
    res.json({ success: true });
});

app.post('/api/pairing-code', async (req, res) => {
    const { telefone } = req.body;
    if (!telefone) return res.status(400).json({ error: 'Informe o número de telefone.' });
    if (!clientReadyForPairing) return res.status(400).json({ error: 'Aguarde o QR Code aparecer antes de solicitar o código.' });
    try {
        // Remove tudo exceto dígitos
        const numero = String(telefone).replace(/\D/g, '');
        const code = await client.requestPairingCode(numero);
        console.log(`🔑 Código de pareamento gerado: ${code}`);
        res.json({ code });
    } catch (err) {
        console.error('Erro ao gerar código de pareamento:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Rota TEMPORÁRIA para validar manualmente (Postman/curl) a resposta real de
// /pagamento/realizarCobrancaOnline antes de conectar ao fluxo automático do
// WhatsApp — ainda não sabemos se ela traz link/QR Code do Pix além de
// status/transacaoId/valor. Não é chamada por nenhum lugar do robô. Remover
// (ou proteger) depois que o campo do link estiver identificado.
app.post('/api/pacto/teste-pix', async (req, res) => {
    const { movparcela, nrParcelas, convenio } = req.body;
    if (!movparcela) return res.status(400).json({ error: 'Informe "movparcela" (código da parcela a pagar).' });
    try {
        const resultado = await gerarLinkPagamentoPixSantander({ movparcela, nrParcelas, convenio });
        res.json(resultado);
    } catch (err) {
        console.error('❌ Erro ao testar geração de link Pix Santander:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// =====================================
// API REST — CRM PACTO (CARTEIRA DO DIA)
// =====================================
app.get('/api/crm/colaboradores', async (req, res) => {
    try {
        const colaboradores = await listarColaboradoresCrm();
        res.json(colaboradores);
    } catch (err) {
        console.error('❌ Erro ao listar colaboradores do CRM:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/crm/carteira/abrir', async (req, res) => {
    const { codigoColaboradorResponsavel, dia } = req.body;
    if (!codigoColaboradorResponsavel) return res.status(400).json({ error: 'Informe "codigoColaboradorResponsavel".' });
    try {
        const diaFinal = dia || moment.tz('America/Sao_Paulo').format('YYYY-MM-DD');
        await abrirCarteiraDia({ dia: diaFinal, codigoColaboradorResponsavel });
        const carteira = await consultarCarteiraDia({ codigoColaborador: codigoColaboradorResponsavel });
        res.json(carteira);
    } catch (err) {
        console.error('❌ Erro ao abrir carteira do dia:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/crm/carteira', async (req, res) => {
    const { codigoColaborador } = req.query;
    if (!codigoColaborador) return res.status(400).json({ error: 'Informe "codigoColaborador".' });
    try {
        const carteira = await consultarCarteiraDia({ codigoColaborador });
        res.json(carteira);
    } catch (err) {
        console.error('❌ Erro ao consultar carteira do dia:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Consulta Aluno — por enquanto só busca por matrícula, que é o único filtro
// que o /v1/cliente da Pacto realmente aplica (nome e cpf são ignorados pela
// API deles; testado direto contra o ambiente real antes de implementar).
app.get('/api/pacto/consulta-aluno', async (req, res) => {
    const { matricula } = req.query;
    if (!matricula || !matricula.trim()) return res.status(400).json({ error: 'Informe a matrícula pra buscar.' });
    try {
        const aluno = await buscarAlunoPorMatricula(matricula.trim());
        if (!aluno) return res.status(404).json({ error: 'Nenhum aluno encontrado com essa matrícula.' });
        res.json({
            nome: aluno.pessoa?.nome || null,
            dataNascimento: aluno.pessoa?.datanasc || null,
            telefone: aluno.pessoa?.telefones?.[0]?.numero || null,
            matricula: aluno.matricula || null,
            tipoPlano: null,
            duracao: null
        });
    } catch (err) {
        console.error('❌ Erro ao consultar aluno na Pacto:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Importação em massa Contatos ← Pacto. A API da Pacto não tem endpoint de
// listagem (só busca por matrícula exata — testado ao vivo, confirmado nos
// comentários da rota de Consulta Aluno acima), então varremos um intervalo
// de matrículas numéricas em paralelo (a faixa 000001–009000 cobre com folga
// o intervalo real de matrículas usadas, amostrado manualmente antes de
// implementar isso). Roda em background — várias milhares de chamadas
// levariam minutos demais pra segurar a requisição HTTP do dashboard aberta.
let pactoImportRunning = false;
let pactoImportProgress = { total: 0, verificadas: 0, importados: 0, ja_existiam: 0, sem_telefone: 0, nao_encontrados: 0, running: false };
const PACTO_IMPORT_MATRICULA_MIN = 1;
const PACTO_IMPORT_MATRICULA_MAX = 9000;
const PACTO_IMPORT_CONCORRENCIA = 5;

app.get('/api/pacto/importar-contatos/status', (req, res) => res.json(pactoImportProgress));

app.post('/api/pacto/importar-contatos', async (req, res) => {
    if (pactoImportRunning) return res.status(400).json({ error: 'Uma importação do Pacto já está em andamento.' });

    const total = PACTO_IMPORT_MATRICULA_MAX - PACTO_IMPORT_MATRICULA_MIN + 1;
    pactoImportRunning = true;
    pactoImportProgress = { total, verificadas: 0, importados: 0, ja_existiam: 0, sem_telefone: 0, nao_encontrados: 0, running: true };
    io.emit('pacto_import_progress', pactoImportProgress);
    res.json({ success: true, total });

    (async () => {
        async function processarMatricula(numero) {
            const matricula = String(numero).padStart(6, '0');
            try {
                const aluno = await buscarAlunoPorMatricula(matricula);
                if (!aluno) { pactoImportProgress.nao_encontrados++; return; }

                const telefone = normalizarTelefoneImportado(aluno.pessoa?.telefones?.[0]?.numero);
                if (!telefone) { pactoImportProgress.sem_telefone++; return; }

                const dataNascimento = aluno.pessoa?.datanasc ? String(aluno.pessoa.datanasc).slice(0, 10) : null;

                const existente = await db.get(
                    'SELECT telefone, data_nascimento FROM leads WHERE telefone = ? OR telefone = ? OR telefone = ?',
                    [telefone, `${telefone}@c.us`, `${telefone}@lid`]
                );
                if (existente) {
                    // Contato já existia (de um import anterior, do WhatsApp, etc.) — só
                    // completa a data de nascimento se estiver faltando, sem tocar em
                    // nome/matrícula pra não sobrescrever edição manual.
                    if (!existente.data_nascimento && dataNascimento) {
                        await db.run('UPDATE leads SET data_nascimento = ? WHERE telefone = ?', [dataNascimento, existente.telefone]);
                    }
                    pactoImportProgress.ja_existiam++;
                    return;
                }

                await db.run(
                    'INSERT INTO leads (telefone, nome, origem, matricula, data_nascimento) VALUES (?, ?, ?, ?, ?)',
                    [telefone, aluno.pessoa?.nome || null, 'pacto', aluno.matricula || matricula, dataNascimento]
                );
                leadsSet.add(telefone);
                stats.leads++;
                pactoImportProgress.importados++;
            } catch (err) {
                console.error(`❌ Erro ao importar matrícula ${matricula} do Pacto:`, err.message);
                pactoImportProgress.nao_encontrados++;
            }
        }

        let atual = PACTO_IMPORT_MATRICULA_MIN;
        while (atual <= PACTO_IMPORT_MATRICULA_MAX && pactoImportRunning) {
            const lote = [];
            for (let i = 0; i < PACTO_IMPORT_CONCORRENCIA && atual <= PACTO_IMPORT_MATRICULA_MAX; i++, atual++) {
                lote.push(processarMatricula(atual));
            }
            await Promise.all(lote);
            pactoImportProgress.verificadas += lote.length;
            io.emit('pacto_import_progress', pactoImportProgress);
        }

        pactoImportProgress.running = false;
        pactoImportRunning = false;
        io.emit('stats', stats);
        io.emit('pacto_import_progress', pactoImportProgress);
        io.emit('pacto_import_done', pactoImportProgress);
        console.log(`✅ Importação Pacto finalizada: ${pactoImportProgress.importados} novos contatos de ${pactoImportProgress.verificadas} matrículas verificadas.`);
    })();
});

// =====================================
// PACTO — ALUNOS ATIVOS COM PARCELAS ATRASADAS
// =====================================
// Etiqueta "Inadimplente" já existe no sistema (usada manualmente até aqui) —
// reaproveitamos ela em vez de criar uma nova, mesmo padrão de
// garantirEtiquetaAniversariante: busca por nome, só cria se não existir.
const NOME_ETIQUETA_INADIMPLENTE = 'Inadimplente';
async function garantirEtiquetaInadimplente() {
    const existente = await db.get('SELECT id FROM etiquetas WHERE LOWER(nome) = LOWER(?)', NOME_ETIQUETA_INADIMPLENTE);
    if (existente) return existente.id;
    const result = await db.run('INSERT INTO etiquetas (nome, cor) VALUES (?, ?)', [NOME_ETIQUETA_INADIMPLENTE, '#EF4444']);
    return result.lastID;
}

let pactoInadimplentesRunning = false;
let pactoInadimplentesProgress = { total: 0, verificados: 0, inadimplentes: 0, running: false };

app.get('/api/pacto/inadimplentes/status', (req, res) => res.json(pactoInadimplentesProgress));

app.get('/api/pacto/inadimplentes', async (req, res) => {
    const lista = await db.all('SELECT * FROM pacto_inadimplentes ORDER BY dias_atraso_mais_antiga DESC');
    res.json(lista);
});

// Remoção manual: some da lista e desvincula a etiqueta "Inadimplente" na
// hora. Se ele ainda estiver mesmo em atraso, volta a aparecer na próxima
// verificação (Integração → Atualizar Lista) — isso aqui só limpa a leitura atual.
app.delete('/api/pacto/inadimplentes/:telefone', async (req, res) => {
    const { telefone } = req.params;
    try {
        const etiquetaId = await garantirEtiquetaInadimplente();
        await removerEtiquetaContato(telefone, etiquetaId);
        await db.run('DELETE FROM pacto_inadimplentes WHERE telefone = ?', telefone);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Varre os contatos que já têm matrícula conhecida (vindos do import anterior
// ou cadastro manual) — mais rápido que escanear a faixa de matrículas
// inteira de novo, já que só interessa quem já sabemos que é aluno. Pra cada
// um: confere se está "Ativo" no Pacto e se tem parcela vencida; se sim,
// aplica a etiqueta "Inadimplente" e guarda no cache local; se não (ou não
// está mais ativo), remove a etiqueta SE foi este sistema quem aplicou
// (rastreado pela própria linha em pacto_inadimplentes) — não mexe em quem
// foi etiquetado manualmente por outro motivo.
async function processarInadimplentesPacto() {
    const contatos = await db.all("SELECT telefone, matricula FROM leads WHERE matricula IS NOT NULL AND matricula != ''");
    const etiquetaId = await garantirEtiquetaInadimplente();

    pactoInadimplentesRunning = true;
    pactoInadimplentesProgress = { total: contatos.length, verificados: 0, inadimplentes: 0, running: true };
    io.emit('pacto_inadimplentes_progress', pactoInadimplentesProgress);

    const CONCORRENCIA = 5;
    let indice = 0;

    async function processarContato(contato) {
        const numLimpo = contato.telefone.replace('@c.us', '').replace('@lid', '');
        try {
            const aluno = await buscarAlunoPorMatricula(contato.matricula);
            const estaAtivo = aluno?.situacao?.codigo === 'AT';
            let parcelasVencidas = [];
            if (estaAtivo) {
                const parcelas = await obterParcelasEmAberto(aluno.pessoa.codigo);
                parcelasVencidas = (parcelas || []).filter(p => p.vencida);
            }

            const jaEstavaNoCache = await db.get('SELECT 1 FROM pacto_inadimplentes WHERE telefone = ?', numLimpo);

            if (estaAtivo && parcelasVencidas.length > 0) {
                const valorTotal = parcelasVencidas.reduce((soma, p) => soma + (p.valor || 0), 0);
                const maisAntiga = Math.min(...parcelasVencidas.map(p => p.dataVencimentoDt));
                const diasAtraso = Math.floor((Date.now() - maisAntiga) / 86400000);
                await db.run(
                    `INSERT INTO pacto_inadimplentes (telefone, nome, matricula, qtd_parcelas_atrasadas, valor_total_atrasado, dias_atraso_mais_antiga, atualizado_em)
                     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(telefone) DO UPDATE SET nome = excluded.nome, matricula = excluded.matricula,
                        qtd_parcelas_atrasadas = excluded.qtd_parcelas_atrasadas, valor_total_atrasado = excluded.valor_total_atrasado,
                        dias_atraso_mais_antiga = excluded.dias_atraso_mais_antiga, atualizado_em = CURRENT_TIMESTAMP`,
                    [numLimpo, aluno.pessoa?.nome || null, aluno.matricula || contato.matricula, parcelasVencidas.length, valorTotal, diasAtraso]
                );
                await aplicarEtiquetaContato(numLimpo, etiquetaId);
                pactoInadimplentesProgress.inadimplentes++;
            } else if (jaEstavaNoCache) {
                // Não é mais ativo ou já quitou as parcelas — some do cache e da
                // etiqueta (só porque sabemos que fomos nós que aplicamos).
                await db.run('DELETE FROM pacto_inadimplentes WHERE telefone = ?', numLimpo);
                await removerEtiquetaContato(numLimpo, etiquetaId);
            }
        } catch (err) {
            console.error(`❌ Erro ao checar inadimplência da matrícula ${contato.matricula}:`, err.message);
        }
        pactoInadimplentesProgress.verificados++;
    }

    while (indice < contatos.length && pactoInadimplentesRunning) {
        const lote = contatos.slice(indice, indice + CONCORRENCIA);
        await Promise.all(lote.map(processarContato));
        indice += lote.length;
        io.emit('pacto_inadimplentes_progress', pactoInadimplentesProgress);
    }

    pactoInadimplentesProgress.running = false;
    pactoInadimplentesRunning = false;
    io.emit('pacto_inadimplentes_progress', pactoInadimplentesProgress);
    io.emit('pacto_inadimplentes_done', pactoInadimplentesProgress);
    console.log(`✅ Varredura de inadimplentes finalizada: ${pactoInadimplentesProgress.inadimplentes} encontrados de ${pactoInadimplentesProgress.verificados} verificados.`);
}

app.post('/api/pacto/inadimplentes/atualizar', async (req, res) => {
    if (pactoInadimplentesRunning) return res.status(400).json({ error: 'Uma varredura de inadimplentes já está em andamento.' });
    res.json({ success: true });
    processarInadimplentesPacto().catch(e => console.error('Erro ao processar inadimplentes:', e.message));
});

// A etiqueta "Inadimplente" dura só 20h desde a última verificação que
// confirmou o débito (atualizado_em é renovado a cada varredura em que o
// contato continua inadimplente) — depois disso desvincula sozinha. Pra
// reaparecer, precisa rodar uma nova verificação em Integração.
const INADIMPLENTE_EXPIRACAO_HORAS = 20;
async function expirarInadimplentesAntigos() {
    if (!db) return;
    try {
        const etiquetaId = await garantirEtiquetaInadimplente();
        const expirados = await db.all(
            `SELECT telefone FROM pacto_inadimplentes WHERE atualizado_em <= datetime('now', ?)`,
            `-${INADIMPLENTE_EXPIRACAO_HORAS} hours`
        );
        for (const c of expirados) {
            await removerEtiquetaContato(c.telefone, etiquetaId);
            await db.run('DELETE FROM pacto_inadimplentes WHERE telefone = ?', c.telefone);
        }
        if (expirados.length > 0) console.log(`⏳ ${expirados.length} etiqueta(s) "Inadimplente" expirada(s) após ${INADIMPLENTE_EXPIRACAO_HORAS}h.`);
    } catch (e) {
        console.error('Erro ao expirar inadimplentes antigos:', e.message);
    }
}
setInterval(expirarInadimplentesAntigos, 30 * 60 * 1000);
setTimeout(expirarInadimplentesAntigos, 90 * 1000);

// Expira etiquetas temporárias (contato_etiquetas.expira_em) de QUALQUER
// etiqueta configurada com duracao_dias — genérico, não é só pro "Desafio":
// cada contato tem seu próprio relógio, contado a partir de quando a
// etiqueta foi aplicada NELE (ver aplicarEtiquetaContato). removerEtiquetaContato
// já cancela automação em andamento vinculada, então reaproveita a mesma rotina.
async function expirarEtiquetasTemporarias() {
    if (!db) return;
    try {
        const expirados = await db.all(
            `SELECT telefone, etiqueta_id FROM contato_etiquetas WHERE expira_em IS NOT NULL AND expira_em <= datetime('now')`
        );
        for (const c of expirados) {
            await removerEtiquetaContato(c.telefone, c.etiqueta_id);
        }
        if (expirados.length > 0) console.log(`⏳ ${expirados.length} etiqueta(s) temporária(s) expirada(s).`);
    } catch (e) {
        console.error('Erro ao expirar etiquetas temporárias:', e.message);
    }
}
setInterval(expirarEtiquetasTemporarias, 30 * 60 * 1000);
setTimeout(expirarEtiquetasTemporarias, 100 * 1000);

app.post('/api/disconnect', async (req, res) => {
    // Responde imediatamente para não travar o frontend
    res.json({ success: true });
    io.emit('disconnected', 'Desconectado manualmente');

    // Remove sessão do volume para forçar novo QR Code no próximo start
    try {
        const authDir = path.join(DATA_DIR, '.wwebjs_auth');
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    } catch (_) {}

    // Tenta logout suave com timeout de 5s, depois força destroy e reinicia processo
    const exitClean = () => { console.log('🔄 Reiniciando para gerar novo QR Code...'); process.exit(1); };
    const timer = setTimeout(exitClean, 5000);
    try {
        await Promise.race([
            client.logout(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
        ]);
    } catch (_) {
        try { await client.destroy(); } catch (__) {}
    }
    clearTimeout(timer);
    exitClean();
});

// =====================================
// CONFIGURAÇÃO DO CLIENTE WHATSAPP
// =====================================

// Mata qualquer Chrome residual de inicializações anteriores
try { require('child_process').execSync('pkill -f chrome || true', { stdio: 'ignore' }); } catch (_) {}

// Usa chromium do sistema se disponível (evita download do Chrome pelo puppeteer)
const chromiumPath = (() => {
    const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
    for (const p of candidates) {
        try { if (require('fs').existsSync(p)) return p; } catch (_) {}
    }
    return undefined;
})();
if (chromiumPath) console.log(`🌐 Usando Chromium do sistema: ${chromiumPath}`);

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, '.wwebjs_auth') }),
    puppeteer: {
        headless: true,
        protocolTimeout: 180000,
        ...(chromiumPath && { executablePath: chromiumPath }),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-first-run',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI,BlinkGenPropertyTrees',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--disable-domain-reliability',
            '--disable-component-update',
            '--disable-client-side-phishing-detection',
            '--disable-popup-blocking',
            '--disable-breakpad',
            '--disable-crash-reporter',
            '--disable-in-process-stack-traces',
            '--disable-logging',
            '--memory-pressure-off',
            '--disable-low-res-tiling',
            '--disable-smooth-scrolling',
            '--js-flags=--max-old-space-size=350 --optimize-for-size --gc-interval=100',
        ],
    },
});

let currentQR = null;
let isConnected = false;
let clientReadyForPairing = false;
let restartInProgress = false; // Evita loop de restart: só uma reinicialização por vez

// =====================================
// EVENTOS DO SOCKET.IO (PAINEL WEB)
// =====================================
io.on('connection', async (socket) => {
    console.log('💻 Novo usuário conectado ao painel web');
    socket.emit('stats', stats);
    socket.emit('broadcast_progress', broadcastProgress);

    if (db) {
        const allLeads = await db.all('SELECT telefone, data_captura FROM leads ORDER BY data_captura DESC');
        socket.emit('all_leads', allLeads.map(l => ({ ...l, data_captura: sqliteTsParaIso(l.data_captura) })));

        const allMensagensEnviadas = await db.all('SELECT * FROM mensagens_enviadas ORDER BY id DESC LIMIT 200');
        socket.emit('all_mensagens_enviadas', allMensagensEnviadas.map(m => ({ ...m, ts: sqliteTsParaIso(m.ts) })));

        // Envia lista de conversas para popular o gerenciador
        try {
            const conversas = await listarConversasComEtiquetas();
            socket.emit('all_conversas', conversas);
        } catch(e) { console.error('Erro ao carregar conversas:', e.message); }
    }

    if (isConnected) socket.emit('ready');
    else if (currentQR) socket.emit('qr', currentQR);
    else socket.emit('loading', 'Iniciando o WhatsApp...');
});

// =====================================
// EVENTOS DO WHATSAPP
// =====================================
client.on('qr', async (qr) => {
    console.log('📲 Novo QR Code gerado! Acesse o painel web para escanear.');
    sessionWasFresh = true; // a QR/pairing flow is happening — not a silent restore
    clientReadyForPairing = true;
    try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        currentQR = qrDataUrl;
        io.emit('qr', qrDataUrl);
    } catch (err) { console.error('Erro ao gerar QR:', err); }
});

client.on('authenticated', () => {
    console.log('🔐 WhatsApp autenticado — sessão estabelecida.');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Falha de autenticação WhatsApp:', msg);
});

client.on('ready', async () => {
    console.log('✅ Tudo certo! WhatsApp conectado.');
    try {
        const info = client.info;
        if (info) console.log(`📱 Número conectado: ${info.wid.user} (${info.pushname})`);
    } catch (_) {}

    isConnected = true;
    currentQR = null;
    clientReadyForPairing = false;
    restartInProgress = false;
    io.emit('ready');

    // DIAGNÓSTICO: expõe erros que acontecem DENTRO do Chrome headless
    // Ativado 1x por página pra não empilhar listener a cada 'ready' repetido.
    try {
        if (client.pupPage && !client.pupPage._diagAtivo) {
            client.pupPage._diagAtivo = true;
            client.pupPage.on('pageerror', (err) => {
                console.error('🧨 [PAGE ERROR]', err.message || err);
            });
            client.pupPage.on('console', (msg) => {
                if (msg.type() === 'error') console.error('🧨 [PAGE CONSOLE ERROR]', msg.text());
            });
            client.pupPage.on('error', async (err) => {
                console.error('🧨 [PAGE CRASHED]', err.message || err);
                if (restartInProgress) {
                    console.log('⚠️  Restart já em andamento — ignorando crash duplicado.');
                    return;
                }
                restartInProgress = true;
                isConnected = false;
                io.emit('disconnected', 'Reconectando WhatsApp...');
                console.log('🔄 Reiniciando cliente WhatsApp (servidor HTTP permanece no ar)...');

                // Destroi o cliente atual silenciosamente
                try { await client.destroy(); } catch (_) {}

                // Aguarda 4s e reinicializa — sem matar o processo Node!
                setTimeout(async () => {
                    try {
                        await client.initialize();
                        console.log('🔁 Cliente reinicializado com sucesso.');
                    } catch (e) {
                        console.error('❌ Falha ao reinicializar cliente:', e.message);
                        // Só agora, se realmente falhar, mata o processo como último recurso
                        setTimeout(() => process.exit(1), 1000);
                    }
                }, 4000);
            });
            console.log('🩺 Diagnóstico de erros da página ativado.');
        }
    } catch (e) {
        console.error('Erro ao ativar diagnóstico de página:', e.message);
    }
});

client.on('disconnected', (reason) => {
    console.log('⚠️ Desconectado:', reason);
    isConnected = false;
    io.emit('disconnected', reason);
});

// =====================================
// INTEGRAÇÃO PACTO — VÍNCULO TELEFONE x ALUNO
// =====================================
async function getVinculo(telefone) {
    return db.get('SELECT * FROM vinculo_pacto WHERE telefone = ?', telefone);
}

async function saveVinculo(telefone, aluno) {
    await db.run(
        `INSERT INTO vinculo_pacto (telefone, codigo_cliente, codigo_pessoa, matricula, nome)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(telefone) DO UPDATE SET
            codigo_cliente = excluded.codigo_cliente,
            codigo_pessoa = excluded.codigo_pessoa,
            matricula = excluded.matricula,
            nome = excluded.nome`,
        [telefone, aluno.codigo, aluno.pessoa.codigo, aluno.matricula, aluno.pessoa.nome]
    );
}

const PACTO_PALAVRAS_CHAVE = [
    'débito', 'debito', 'boleto', 'pendência', 'pendencia', 'mensalidade', 'fatura', '2ª via', '2via',
    'matrícula', 'matricula', 'minha situação', 'situação', 'situacao', 'meus dados'
];

function ehIntencaoPacto(texto) {
    return PACTO_PALAVRAS_CHAVE.some(p => texto.includes(p));
}

// Envia uma mensagem via WhatsApp e registra no histórico de mensagens enviadas.
async function enviarEregistrar(telefone, conteudo) {
    if (typeof conteudo === 'string') {
        await simularDigitando(client.getChatById(telefone));
        await delay(calcularDelayDigitacao(conteudo));
    }
    const resultado = await client.sendMessage(telefone, conteudo);
    await registrarMensagemEnviada(telefone, typeof conteudo === 'string' ? conteudo : '[mídia]', null, resultado.id?._serialized);
    return resultado;
}

// Envia a situação do aluno e as parcelas em aberto sempre juntas: quem pergunta
// "minha situação" também quer saber se está devendo, e vice-versa.
async function enviarRespostaPacto(telefone, aluno) {
    const nome = aluno.pessoa?.nome || 'Aluno';
    const situacao = aluno.situacao?.descricao || 'Não informada';
    let texto = `📋 *${nome}*\nMatrícula: ${aluno.matricula}\nSituação: *${situacao}*\n\n`;

    try {
        const parcelas = await obterParcelasEmAberto(aluno.pessoa.codigo);
        if (parcelas.length === 0) {
            texto += '✅ Você não possui nenhuma parcela em aberto.';
        } else {
            const linhas = parcelas.map(p => `• ${p.descricao || 'Parcela'} — R$ ${p.valor ?? '?'} — vence em ${p.dataVencimento || '?'}`);
            texto += `💰 Você tem ${parcelas.length} parcela(s) em aberto:\n${linhas.join('\n')}`;
        }
    } catch (err) {
        console.error('❌ Erro ao consultar parcelas na Pacto:', err.message);
        texto += '⚠️ Não consegui consultar seus débitos agora. Tente novamente em alguns minutos.';
    }

    await enviarEregistrar(telefone, texto);
}

async function identificarERresponder(telefone, matricula) {
    try {
        const aluno = await buscarAlunoPorMatricula(matricula);
        if (!aluno) {
            await enviarEregistrar(telefone, `❌ Não encontrei nenhum aluno com a matrícula ${matricula}. Confira o número e tente de novo.`);
            return;
        }
        await saveVinculo(telefone, aluno);
        await enviarRespostaPacto(telefone, aluno);
    } catch (err) {
        console.error('❌ Erro ao consultar aluno na Pacto:', err.message);
        await enviarEregistrar(telefone, '⚠️ Não consegui consultar seus dados agora. Tente novamente em alguns minutos.');
    }
}

if (!global.pactoFlow) global.pactoFlow = new Map();

// Trata intents de academia (situação, débitos). Retorna true se a mensagem foi tratada
// por esse fluxo, sinalizando ao handler principal que não deve seguir para regras/IA.
async function handlePactoFlow(telefone, texto) {
    const aguardandoMatricula = global.pactoFlow.get(telefone);

    if (aguardandoMatricula) {
        global.pactoFlow.delete(telefone);
        const matricula = texto.replace(/\D/g, '');
        if (!matricula) {
            await enviarEregistrar(telefone, '❌ Não entendi. Envie apenas o número da sua matrícula.');
            return true;
        }
        await identificarERresponder(telefone, matricula);
        return true;
    }

    if (!ehIntencaoPacto(texto)) return false;

    const vinculo = await getVinculo(telefone);
    if (vinculo) {
        try {
            const aluno = await buscarAlunoPorCodigo(vinculo.codigo_cliente);
            await enviarRespostaPacto(telefone, aluno);
        } catch (err) {
            console.error('❌ Erro ao consultar aluno vinculado na Pacto:', err.message);
            await enviarEregistrar(telefone, '⚠️ Não consegui consultar seus dados agora. Tente novamente em alguns minutos.');
        }
        return true;
    }

    global.pactoFlow.set(telefone, true);
    await enviarEregistrar(telefone, '👋 Para te ajudar, me informe o número da sua matrícula na academia:');
    return true;
}

// =====================================
// INTEGRAÇÃO PACTO — AUTOATENDIMENTO DE MATRÍCULA
// =====================================
const PACTO_PALAVRAS_MATRICULAR = ['quero matricular', 'quero me matricular', 'quero me cadastrar', 'novo aluno', 'quero ser aluno', 'fazer cadastro', 'quero treinar'];

function ehIntencaoMatricular(texto) {
    return PACTO_PALAVRAS_MATRICULAR.some(p => texto.includes(p));
}

function formatarDataBR(date) {
    return date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function extrairCelular(telefone) {
    let digitos = telefone.replace('@c.us', '').replace(/\D/g, '');
    if (digitos.startsWith('55') && digitos.length > 11) digitos = digitos.slice(2);
    return digitos;
}

if (!global.pactoCadastro) global.pactoCadastro = new Map();

async function finalizarCadastro(telefone, dados) {
    try {
        const cliente = await criarCliente({
            nome: dados.nome,
            celular: extrairCelular(telefone),
            cpf: dados.cpf,
            email: dados.email
        });

        const hoje = new Date();
        const fim = new Date(hoje);
        const duracao = Number(process.env.PACTO_PLANO_DURACAO_MESES || 1);
        fim.setMonth(fim.getMonth() + duracao);

        await matricularAluno({
            codigoMatricula: parseInt(cliente.matricula, 10),
            consultor: process.env.PACTO_CONSULTOR_PADRAO,
            dataCadastro: formatarDataBR(hoje),
            dataInicio: formatarDataBR(hoje),
            dataFinal: formatarDataBR(fim),
            duracao,
            modalidades: [{
                nome: process.env.PACTO_PLANO_MODALIDADE,
                vezesPorSemana: Number(process.env.PACTO_PLANO_VEZES_SEMANA || 7)
            }],
            valorContrato: Number(process.env.PACTO_PLANO_VALOR_CONTRATO),
            valorMatricula: Number(process.env.PACTO_PLANO_VALOR_MATRICULA)
        });

        await saveVinculo(telefone, cliente);
        await enviarEregistrar(telefone, `✅ Matrícula realizada com sucesso! Sua matrícula é *${cliente.matricula}*. Bem-vindo(a)!`);
    } catch (err) {
        console.error('❌ Erro ao matricular novo aluno na Pacto:', err.message);
        await enviarEregistrar(telefone, '⚠️ Não consegui concluir sua matrícula agora. Por favor, fale com a recepção da academia.');
    }
}

// Conduz a conversa de cadastro+matrícula passo a passo. "textoOriginal" preserva
// maiúsculas/acentos do que o aluno digitou (nome e e-mail não devem ser lowercased).
async function handleCadastroFlow(telefone, texto, textoOriginal) {
    const estado = global.pactoCadastro.get(telefone);

    if (!estado) {
        if (!ehIntencaoMatricular(texto)) return false;
        global.pactoCadastro.set(telefone, { etapa: 'nome' });
        await enviarEregistrar(telefone, '🏋️ Que ótimo que você quer treinar com a gente! Pra começar, me diga seu *nome completo*:');
        return true;
    }

    if (estado.etapa === 'nome') {
        estado.nome = textoOriginal.trim();
        estado.etapa = 'cpf';
        await enviarEregistrar(telefone, 'Agora me informe seu *CPF* (somente números):');
        return true;
    }

    if (estado.etapa === 'cpf') {
        const cpf = texto.replace(/\D/g, '');
        if (cpf.length !== 11) {
            await enviarEregistrar(telefone, '❌ CPF inválido. Envie os 11 números do seu CPF:');
            return true;
        }
        estado.cpf = cpf;
        estado.etapa = 'email';
        await enviarEregistrar(telefone, 'Qual o seu *e-mail*? (ou digite *pular* se não quiser informar)');
        return true;
    }

    if (estado.etapa === 'email') {
        estado.email = texto === 'pular' ? '' : textoOriginal.trim();
        estado.etapa = 'confirmar';
        await enviarEregistrar(telefone,
            `📋 Confere os seus dados:\n\nNome: ${estado.nome}\nCPF: ${estado.cpf}\nE-mail: ${estado.email || '(não informado)'}\n\n` +
            `Plano: Mensal — R$ ${process.env.PACTO_PLANO_VALOR_CONTRATO} + R$ ${process.env.PACTO_PLANO_VALOR_MATRICULA} de matrícula\n\n` +
            `Digite *CONFIRMAR* para finalizar ou *CANCELAR* para desistir.`
        );
        return true;
    }

    if (estado.etapa === 'confirmar') {
        global.pactoCadastro.delete(telefone);
        if (texto !== 'confirmar') {
            await enviarEregistrar(telefone, '❌ Cadastro cancelado. Se quiser tentar de novo, é só me chamar.');
            return true;
        }
        await finalizarCadastro(telefone, estado);
        return true;
    }

    return false;
}

// =====================================
// FUNIL DE MENSAGENS — DINÂMICO
// =====================================
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Faixas de intervalo "aleatório" (ms) — compartilhadas entre Disparos e
// Automação: cada mensagem espera um valor novo dentro da faixa escolhida,
// menos previsível que um intervalo fixo, reduz risco de bloqueio no WhatsApp.
const FAIXAS_VELOCIDADE = {
    curto: [5000, 10000],
    medio: [10000, 30000],
    longo: [30000, 120000],
    muito_longo: [120000, 320000]
};

// Simula o tempo de "digitando...": resposta curta pausa pouco, resposta longa
// pausa mais — enviar tudo instantâneo soa robótico demais.
const DIGITACAO_MIN_MS = 1200;
const DIGITACAO_MAX_MS = 6000;
const DIGITACAO_MS_POR_CARACTERE = 35;
function calcularDelayDigitacao(texto) {
    const estimado = (texto || '').length * DIGITACAO_MS_POR_CARACTERE;
    return Math.min(DIGITACAO_MAX_MS, Math.max(DIGITACAO_MIN_MS, estimado));
}

// Mostra o "digitando..." de verdade no WhatsApp do contato. Isso já causou
// travamento do Puppeteer no passado (commit 1099a86) porque era chamado sem
// nenhuma proteção — aqui roda com timeout curto e nunca deixa o envio da
// mensagem depender do resultado (se travar ou falhar, apenas ignora).
async function simularDigitando(chatOuGetter) {
    try {
        await Promise.race([
            Promise.resolve(chatOuGetter).then(chat => chat.sendStateTyping()),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
        ]);
    } catch (_) {}
}

// Transcreve áudio/nota de voz recebida via Whisper. Sempre usa a Groq
// (whisper-large-v3, gratuita e rápida), independente do provider escolhido
// para a IA de chat — usa a groq_api_key cadastrada em Configurações → IA
// mesmo que o provider selecionado ali seja OpenAI. Sem chave configurada,
// retorna null e a mensagem segue tratada como antes (sem texto).
const EXTENSAO_POR_MIME = { 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'webm' };
async function transcreverAudio(msg) {
    let tmpPath = null;
    try {
        const confRows = await db.all("SELECT * FROM configuracoes WHERE chave = 'groq_api_key'");
        const apiKey = confRows[0]?.valor;
        if (!apiKey) return null;

        const media = await Promise.race([
            msg.downloadMedia(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
        ]);
        if (!media || !media.data) return null;

        const ext = EXTENSAO_POR_MIME[(media.mimetype || '').split(';')[0].trim()] || 'ogg';
        tmpPath = path.join(os.tmpdir(), `audio_${Date.now()}_${Math.round(Math.random() * 1e6)}.${ext}`);
        fs.writeFileSync(tmpPath, Buffer.from(media.data, 'base64'));

        const groq = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
        const transcricao = await groq.audio.transcriptions.create({
            file: fs.createReadStream(tmpPath),
            model: 'whisper-large-v3',
            language: 'pt'
        });

        return transcricao.text ? transcricao.text.trim() : null;
    } catch (e) {
        console.error('❌ Erro ao transcrever áudio:', e.message);
        return null;
    } finally {
        if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
}

// Quando o WhatsApp usa @lid (privacidade), resolve o número de telefone real.
// contact.number NÃO serve aqui: para contatos @lid ele devolve o próprio lid,
// não o telefone. getContactLidAndPhone() consulta o mapeamento real do WhatsApp.
const lidParaTelefone = new Map();
async function resolveJid(jid) {
    if (!jid) return jid;
    if (!jid.endsWith('@lid')) {
        // Já é @c.us (ou outro formato) — normaliza o número (8x9 dígitos do
        // celular BR) mantendo o sufixo, pra nunca virar um contato duplicado
        // por causa do formato do número receber de jeito diferente.
        if (jid.endsWith('@c.us')) return `${normalizarTelefoneBR(jid.slice(0, -'@c.us'.length))}@c.us`;
        return jid;
    }
    if (lidParaTelefone.has(jid)) return lidParaTelefone.get(jid);
    try {
        const [{ pn } = {}] = await Promise.race([
            client.getContactLidAndPhone([jid]),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
        ]);
        if (pn) {
            const pnNormalizado = pn.endsWith('@c.us')
                ? `${normalizarTelefoneBR(pn.slice(0, -'@c.us'.length))}@c.us`
                : pn;
            lidParaTelefone.set(jid, pnNormalizado);
            return pnNormalizado;
        }
    } catch (_) {}
    return jid;
}
async function resolvePhone(msg) {
    return resolveJid(msg.from);
}

// Resolve o JID correto pra ENVIAR mensagem a um número — usa o lookup oficial
// do WhatsApp (getNumberId) em vez de só grudar "@c.us" no número, que falha
// com "No LID for user" em contas migradas pro sistema de LID do WhatsApp,
// mesmo quando o número é válido. Se getNumberId não achar nada, o número
// realmente não tem WhatsApp — cair pra um "@c.us" às cegas ia falhar do
// mesmo jeito, só que com um erro mais confuso.
const chatIdCache = new Map();
async function resolverChatId(numeroLimpo) {
    if (chatIdCache.has(numeroLimpo)) return chatIdCache.get(numeroLimpo);
    const contato = await client.getNumberId(numeroLimpo);
    if (!contato) throw new Error(`O número ${numeroLimpo} não tem WhatsApp.`);
    chatIdCache.set(numeroLimpo, contato._serialized);
    return contato._serialized;
}

// message_create dispara pra QUALQUER mensagem enviada, inclusive as que o
// próprio robô/dashboard manda — o Set idsMensagensDoSistema filtra essas pra
// não duplicar (elas já foram salvas por registrarMensagemEnviada/salvarNaConversa).
// O que sobra são mensagens mandadas direto do celular/WhatsApp vinculado (ex:
// atendente respondeu por fora do painel) — persistimos aqui pra completar o
// histórico do Bate Papo ao Vivo mesmo quando a resposta não passou pelo bot.
client.on('message_create', async (msg) => {
    const dir = msg.fromMe ? '→ ENVIADA' : '← RECEBIDA';
    if (msg.from !== 'status@broadcast') {
        console.log(`🔍 [DEBUG] ${dir} from=${msg.from} body="${(msg.body||'[sem texto]').slice(0,40)}"`);
    }

    if (!msg.fromMe || !db) return;
    if (!msg.to || msg.to.endsWith('@g.us') || msg.to.endsWith('@broadcast')) return;
    if (!TIPOS_MSG_VALIDOS.has(msg.type)) return; // ruído de protocolo — nunca vira conversa
    // "chat" com corpo vazio nunca é uma mensagem de texto real (ninguém manda
    // texto em branco pelo WhatsApp) — é ruído de sincronização entre
    // aparelhos disfarçado de mensagem de texto legítima (mesmo msg.type).
    if (msg.type === 'chat' && !msg.body) return;

    const msgId = msg.id?._serialized;
    if (msgId) {
        // message_create pode disparar ANTES do nosso próprio código terminar de
        // registrar o ID em idsMensagensDoSistema (a marcação só acontece depois
        // que o await client.sendMessage()/msg.reply() resolve, e o evento pode
        // chegar antes disso) — sem essa espera, mensagem do próprio bot/dashboard
        // é tratada como "eco do celular" e duplica no histórico do Bate Papo ao Vivo.
        await delay(400);
        if (idsMensagensDoSistema.has(msgId)) {
            idsMensagensDoSistema.delete(msgId);
            return; // já registrada pelo próprio sistema
        }
    }

    try {
        const telefoneResolvido = await resolveJid(msg.to);
        const numLimpo = telefoneResolvido.replace('@c.us', '').replace('@lid', '');
        const tipoMsg = detectarTipoMsg(msg);
        // Mesma reclassificação assíncrona de msg.body vista na mensagem recebida
        // (ver comentário no handler 'message') — rechecar aqui, já com o await
        // do resolveJid concluído, evita salvar ruído de protocolo reclassificado
        // tarde demais pro filtro do topo do handler pegar.
        if (tipoMsg === 'text' && !msg.body) return;
        const textoExibir = msg.body || TIPO_LABEL_FALLBACK[tipoMsg] || '[mensagem sem texto]';
        const nome = await resolverNomeContato(numLimpo);
        // Chegou aqui = mandada direto do celular vinculado, não pelo robô nem
        // pelo painel — é sempre um atendente humano respondendo por fora.
        await salvarNaConversa(numLimpo, nome, 'out', textoExibir, tipoMsg, msg.timestamp, true);
    } catch (e) {
        console.error('Erro ao registrar mensagem enviada pelo celular:', e.message);
    }
});// =====================================
// ENGINE DE FLUXOS (Flow Builder - Drawflow)
// =====================================

function getNextNodeId(node, outputKey = 'output_1') {
    if (!node || !node.outputs || !node.outputs[outputKey]) return null;
    const conns = node.outputs[outputKey].connections;
    if (!conns || conns.length === 0) return null;
    return conns[0].node; // ID do próximo nó
}

async function engineExecutarFluxo(telefoneReal, numLimpo, nomeContato, fluxoId, startNodeId) {
    const fluxo = await db.get('SELECT * FROM fluxos WHERE id = ?', fluxoId);
    if (!fluxo) return;
    
    let drawflow = {};
    try { drawflow = JSON.parse(fluxo.flow_data); } catch(e) { return; }
    
    const nodes = drawflow?.drawflow?.Home?.data;
    if (!nodes) return;

    const matriculaContato = await resolverMatriculaContato(numLimpo);
    const aplicarPlaceholders = (txt) => txt
        .replace(/\{nome\}|\[nome\]/gi, nomeContato)
        .replace(/\{nome_completo\}|\[nome_completo\]/gi, nomeContato)
        .replace(/\{matricula\}|\[matricula\]/gi, matriculaContato);

    let currentNodeId = startNodeId;
    if (!currentNodeId) {
        // Prioriza o bloco "start" explícito (o robô pula direto pro que vem
        // depois dele, já que o start em si não faz nada). Fluxos antigos sem
        // esse bloco caem no heurístico anterior: primeiro nó sem conexão de entrada.
        const startNode = Object.values(nodes).find(n => n.name === 'start');
        if (startNode) {
            currentNodeId = getNextNodeId(startNode, 'output_1');
        } else {
            for (const key in nodes) {
                const n = nodes[key];
                const in1 = n.inputs?.input_1?.connections;
                if (!in1 || in1.length === 0) {
                    currentNodeId = n.id;
                    break;
                }
            }
        }
    }
    
    while (currentNodeId) {
        const node = nodes[currentNodeId];
        if (!node) {
            await db.run('DELETE FROM contato_estado_fluxo WHERE telefone = ?', telefoneReal);
            break;
        }
        
        await db.run(
            'INSERT OR REPLACE INTO contato_estado_fluxo (telefone, fluxo_id, current_node_id) VALUES (?, ?, ?)', 
            [telefoneReal, fluxoId, currentNodeId]
        );

        if (node.name === 'message') {
            if (node.data.text) {
                const txt = aplicarPlaceholders(node.data.text);
                await simularDigitando(client.getChatById(telefoneReal));
                await delay(calcularDelayDigitacao(txt));
                const sentFluxo = await client.sendMessage(telefoneReal, txt);
                await registrarMensagemEnviada(telefoneReal, txt, nomeContato, sentFluxo.id?._serialized);
            }
            currentNodeId = getNextNodeId(node, 'output_1');
        }
        else if (node.name === 'delay') {
            const segs = parseInt(node.data.delaySeconds) || 1;
            await delay(segs * 1000);
            currentNodeId = getNextNodeId(node, 'output_1');
        }
        else if (node.name === 'media') {
            if (node.data.mediaUrl) {
                const mediaPath = path.join(__dirname, 'public', node.data.mediaUrl);
                if (fs.existsSync(mediaPath)) {
                    const MessageMedia = require('whatsapp-web.js').MessageMedia;
                    const media = MessageMedia.fromFilePath(mediaPath);
                    const cap = node.data.text ? aplicarPlaceholders(node.data.text) : '';
                    const sentFluxoMedia = await client.sendMessage(telefoneReal, media, { caption: cap });
                    await registrarMensagemEnviada(telefoneReal, cap || '[Mídia]', nomeContato, sentFluxoMedia.id?._serialized);
                }
            }
            currentNodeId = getNextNodeId(node, 'output_1');
        }
        else if (node.name === 'question') {
            let txt = aplicarPlaceholders(node.data.text || '') + '\n';
            const opts = [];
            if (node.data.opt1) opts.push({ lbl: node.data.opt1, out: 'output_1' });
            if (node.data.opt2) opts.push({ lbl: node.data.opt2, out: 'output_2' });
            if (node.data.opt3) opts.push({ lbl: node.data.opt3, out: 'output_3' });
            
            if (opts.length > 0) {
                txt += '\n' + opts.map((o, i) => `${i+1} - ${o.lbl}`).join('\n');
            }
            await simularDigitando(client.getChatById(telefoneReal));
            await delay(calcularDelayDigitacao(txt));
            const sentFluxoPergunta = await client.sendMessage(telefoneReal, txt);
            await registrarMensagemEnviada(telefoneReal, txt, nomeContato, sentFluxoPergunta.id?._serialized);
            break; // PARA E ESPERA O USUÁRIO RESPONDER
        }
        else if (node.name === 'action') {
            if (node.data.actionType === 'add_tag') {
                await aplicarEtiquetaContato(numLimpo, node.data.tagId);
            } else if (node.data.actionType === 'remove_tag') {
                await removerEtiquetaContato(numLimpo, node.data.tagId);
            }
            currentNodeId = getNextNodeId(node, 'output_1');
        }
        else if (node.name === 'condition') {
            let possui = false;
            if (node.data.etiquetaId) {
                const row = await db.get(
                    'SELECT 1 FROM contato_etiquetas WHERE telefone = ? AND etiqueta_id = ?',
                    [numLimpo, node.data.etiquetaId]
                );
                possui = !!row;
            }
            currentNodeId = getNextNodeId(node, possui ? 'output_1' : 'output_2');
        }
        else {
            // Cobre o bloco "start" (não faz nada, só passa adiante) e
            // qualquer tipo de nó desconhecido — segue pela primeira saída.
            currentNodeId = getNextNodeId(node, 'output_1');
        }
        
        if (!currentNodeId) {
            await db.run('DELETE FROM contato_estado_fluxo WHERE telefone = ?', telefoneReal);
        }
    }
}

async function engineContinuarFluxo(telefoneReal, numLimpo, nomeContato, textoMensagem) {
    const estado = await db.get('SELECT * FROM contato_estado_fluxo WHERE telefone = ?', telefoneReal);
    if (!estado) return false;
    
    const fluxo = await db.get('SELECT * FROM fluxos WHERE id = ?', estado.fluxo_id);
    if (!fluxo) {
        await db.run('DELETE FROM contato_estado_fluxo WHERE telefone = ?', telefoneReal);
        return false;
    }
    
    let drawflow = {};
    try { drawflow = JSON.parse(fluxo.flow_data); } catch(e) { return false; }
    
    const nodes = drawflow?.drawflow?.Home?.data;
    if (!nodes) return false;
    
    const node = nodes[estado.current_node_id];
    if (!node || node.name !== 'question') {
        await engineExecutarFluxo(telefoneReal, numLimpo, nomeContato, estado.fluxo_id, getNextNodeId(node, 'output_1'));
        return true; 
    }
    
    const msg = textoMensagem.trim().toLowerCase();
    
    const opts = [];
    if (node.data.opt1) opts.push({ lbl: node.data.opt1, out: 'output_1' });
    if (node.data.opt2) opts.push({ lbl: node.data.opt2, out: 'output_2' });
    if (node.data.opt3) opts.push({ lbl: node.data.opt3, out: 'output_3' });
    
    let targetOutput = null;
    
    for (let i = 0; i < opts.length; i++) {
        if (msg === (i+1).toString() || msg === opts[i].lbl.toLowerCase().trim()) {
            targetOutput = opts[i].out;
            break;
        }
    }
    
    if (targetOutput) {
        const nextNodeId = getNextNodeId(node, targetOutput);
        await engineExecutarFluxo(telefoneReal, numLimpo, nomeContato, estado.fluxo_id, nextNodeId);
    } else {
        const txtInvalida = 'Opção inválida, por favor digite o número correto da opção.';
        const sentInvalida = await client.sendMessage(telefoneReal, txtInvalida);
        await registrarMensagemEnviada(telefoneReal, txtInvalida, nomeContato, sentInvalida.id?._serialized);
        await engineExecutarFluxo(telefoneReal, numLimpo, nomeContato, estado.fluxo_id, estado.current_node_id);
    }
    
    return true;
}

// Wrapper de envio: tenta msg.reply(), se timeout reinicia o processo
async function enviarResposta(msg, conteudo, opcoes = {}) {
    try {
        if (typeof conteudo === 'string') {
            await simularDigitando(msg.getChat());
            await delay(calcularDelayDigitacao(conteudo));
        }
        const sent = await msg.reply(conteudo, undefined, opcoes);
        console.log(`✅ Resposta entregue.`);
        return sent;
    } catch (e) {
        if (e.message && (e.message.includes('timed out') || e.message.includes('Protocol error'))) {
            console.error('❌ Timeout no envio — reiniciando cliente para recuperar...');
            setTimeout(() => process.exit(1), 500);
        } else {
            console.error('❌ Erro ao enviar:', e.message);
        }
        return null;
    }
}

client.on('message', async (msg) => {
    try {
        if (!msg.from || msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast')) return;
        if (!TIPOS_MSG_VALIDOS.has(msg.type)) return; // ruído de protocolo — nunca vira conversa
        // "chat" com corpo vazio nunca é uma mensagem de texto real (ninguém
        // manda texto em branco pelo WhatsApp) — é ruído de sincronização
        // entre aparelhos disfarçado de mensagem de texto legítima.
        if (msg.type === 'chat' && !msg.body) return;
        const chat = await msg.getChat();
        if (chat.isGroup) return;

        // Usa o ID interno do chat para envio — funciona com @lid e @c.us
        const replyTo    = chat.id._serialized;
        const telefoneReal = await resolvePhone(msg);  // número limpo para salvar no banco
        const numLimpo = telefoneReal.replace('@c.us','').replace('@lid','');

        // Tenta obter o nome do contato (pushname ou nome da agenda). NUNCA usa
        // contact.number como fallback: em contatos migrados pro sistema @lid do
        // WhatsApp, contact.number pode devolver o ID interno do lid (um número
        // gigante sem relação com o telefone real) em vez do telefone — melhor
        // cair no numLimpo (já resolvido via resolveJid) do que salvar esse lixo
        // como "nome" do contato.
        let nomeContato = numLimpo;
        try {
            const contact = await Promise.race([
                msg.getContact(),
                new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2500))
            ]);
            nomeContato = contact.pushname || contact.name || numLimpo;
            nomeContatos.set(numLimpo, nomeContato);
        } catch(_) {}

        await registerLead(telefoneReal);
        let texto = msg.body ? msg.body.trim().toLowerCase() : '';

        // Determina tipo da mensagem
        let tipoMsg = detectarTipoMsg(msg);

        // Áudio/nota de voz: transcreve via Whisper para o robô conseguir entender
        // e responder normalmente (regras exatas e IA). Sem API key configurada,
        // transcreverAudio() retorna null e a mensagem segue como antes (sem texto).
        let transcricaoAudio = null;
        if (tipoMsg === 'audio' && !texto) {
            transcricaoAudio = await transcreverAudio(msg);
            if (transcricaoAudio) texto = transcricaoAudio.trim().toLowerCase();
        }

        // msg.body pode "esvaziar" de forma assíncrona: mensagem de sincronização
        // chega com msg.type='chat' e corpo aparentemente presente, mas o Store
        // interno do WhatsApp Web só termina de classificar como ruído de
        // protocolo DEPOIS dos awaits acima (getChat/getContact/registerLead) —
        // o filtro lá em cima (linha ~3330) não pega isso porque roda cedo demais.
        // Rechecar aqui, na hora de salvar, pega o valor já estabilizado: se é
        // tipo texto (tipoMsg default) e não tem corpo real nem transcrição,
        // nunca foi uma mensagem de verdade — não vira conversa fantasma.
        if (tipoMsg === 'text' && !msg.body && !transcricaoAudio) return;

        // Salva na tabela de conversas (mensagens recebidas) — salvarNaConversa já
        // reabre a conversa automaticamente se ela tinha sido finalizada.
        const textoExibir = transcricaoAudio ? `🎤 ${transcricaoAudio}` : (msg.body || TIPO_LABEL_FALLBACK[tipoMsg] || '[mensagem sem texto]');
        await salvarNaConversa(numLimpo, nomeContato, 'in', textoExibir, tipoMsg, msg.timestamp);

        // Ignora mensagens sem texto (stickers, imagens sem legenda, áudio sem transcrição)
        if (!texto && !msg.body) return;

        console.log(`📨 Mensagem de ${numLimpo} (${nomeContato}): "${textoExibir}"`);
        io.emit('message_in', { from: numLimpo, nome: nomeContato, text: textoExibir, ts: Date.now() });

        // Comando interno TEMPORÁRIO de teste — não documentado pra clientes.
        // Mostra a resposta CRUA de gerarLinkPagamentoPixSantander pra
        // descobrir onde está o link/QR Code do Pix antes de expor isso de
        // verdade aos alunos. Roda sempre (ignora horário/modo humano) pra
        // facilitar teste. Remover depois que o campo do link for identificado.
        if (msg.body && msg.body.trim().toLowerCase().startsWith('/testepix')) {
            const matricula = msg.body.trim().slice('/testepix'.length).trim();
            if (!matricula) {
                await enviarResposta(msg, '❌ Uso: /testepix <matrícula>');
                return;
            }
            try {
                const aluno = await buscarAlunoPorMatricula(matricula);
                if (!aluno) {
                    await enviarResposta(msg, `❌ Nenhum aluno encontrado com a matrícula ${matricula}.`);
                    return;
                }
                const parcelas = await obterParcelasEmAberto(aluno.pessoa.codigo);
                console.log('🧪 [TESTE PIX] parcelas em aberto:', JSON.stringify(parcelas, null, 2));
                if (parcelas.length === 0) {
                    await enviarResposta(msg, '✅ Esse aluno não tem parcelas em aberto pra testar.');
                    return;
                }
                const parcela = parcelas[0];
                const movparcela = parcela.movparcela || parcela.codigo || parcela.id || parcela.numero;
                await enviarResposta(msg, `🧪 Parcela usada:\n${JSON.stringify(parcela)}\n\nCampo usado como movparcela: ${movparcela}`);
                const resultado = await gerarLinkPagamentoPixSantander({ movparcela });
                await enviarResposta(msg, `✅ Resultado:\n${JSON.stringify(resultado, null, 2)}`);
            } catch (err) {
                console.error('❌ [TESTE PIX] erro:', err.message);
                await enviarResposta(msg, `❌ Erro ao testar: ${err.message}`);
            }
            return;
        }

        // Conversa assumida manualmente por um humano (botão "Assumir Conversa"
        // em Conversas): tem prioridade sobre horário e sobre o override global
        // "Ativar Robô" — enquanto assumida, o robô nunca responde esse contato.
        const assumidaPorHumano = await db.get('SELECT 1 FROM conversas_humano WHERE telefone = ?', numLimpo);
        if (assumidaPorHumano) return;

        // Modo Humano: a mensagem já foi salva em "conversas" (o operador pode
        // responder manualmente pelo painel), mas o robô não dispara fluxos
        // automáticos nem a IA.
        const { modo, mensagemHumano, timezone } = await obterModoAtual();
        if (modo === 'humano') {
            const hoje = moment.tz(timezone || 'America/Sao_Paulo').format('YYYY-MM-DD');
            if (mensagemHumano && ultimaMsgModoHumano.get(numLimpo) !== hoje) {
                const sentHumano = await enviarResposta(msg, mensagemHumano);
                if (sentHumano) {
                    ultimaMsgModoHumano.set(numLimpo, hoje);
                    await registrarMensagemEnviada(telefoneReal, mensagemHumano, nomeContato, sentHumano.id?._serialized);
                }
            }
            return;
        }

        // Sinaliza que o bot está processando ("digitando...")
        io.emit('bot_digitando', { telefone: numLimpo, ativo: true });

        // Tenta continuar um fluxo ativo (se o usuário estava preso em uma Pergunta)
        if (await engineContinuarFluxo(telefoneReal, numLimpo, nomeContato, texto)) {
            io.emit('bot_digitando', { telefone: numLimpo, ativo: false });
            return;
        }

        // Tenta iniciar um NOVO fluxo se bater com alguma palavra-chave (gatilho)
        if (texto) {
            const fluxosAtivos = await db.all('SELECT * FROM fluxos WHERE ativo = 1');
            let fluxoIniciado = false;
            for (const fluxo of fluxosAtivos) {
                if (!fluxo.gatilho) continue;
                const gatilhos = fluxo.gatilho.split(',').map(g => g.trim().toLowerCase());
                if (gatilhos.some(g => texto === g || texto.includes(g))) {
                    await engineExecutarFluxo(telefoneReal, numLimpo, nomeContato, fluxo.id, null);
                    fluxoIniciado = true;
                    break;
                }
            }
            if (fluxoIniciado) {
                io.emit('bot_digitando', { telefone: numLimpo, ativo: false });
                return;
            }
        }

        if (await handleCadastroFlow(replyTo, texto, msg.body || '')) { io.emit('bot_digitando', { telefone: numLimpo, ativo: false }); return; }

        if (await handlePactoFlow(replyTo, texto)) { io.emit('bot_digitando', { telefone: numLimpo, ativo: false }); return; }

        const regras = await db.all('SELECT * FROM respostas WHERE ativo = 1 ORDER BY ordem ASC');
        let regraAtiva = null;
        for (const regra of regras) {
            const keywords = regra.keywords.split(',').map(k => k.trim().toLowerCase());
            // Palavra-chave puramente numérica (ex: opção "1" do menu) só ativa a regra se
            // for a mensagem inteira — senão qualquer número (horário, telefone, preço) ativaria à toa.
            const matched = keywords.some(kw => /^\d+$/.test(kw) ? texto === kw : texto.includes(kw));
            if (matched) { regraAtiva = regra; break; }
        }

        if (!regraAtiva) {
            const confRows = await db.all('SELECT * FROM configuracoes');
            const config = {};
            confRows.forEach(r => config[r.chave] = r.valor);

            const provider  = config.ia_provider || 'openai';
            const iaAtiva   = config.openai_status === 'true';
            const apiKey    = provider === 'groq' ? config.groq_api_key : config.openai_api_key;
            const modelo    = provider === 'groq'
                ? (config.groq_modelo || 'llama-3.3-70b-versatile')
                : (config.openai_modelo || 'gpt-3.5-turbo');

            if (iaAtiva && apiKey) {
                

                if (!global.chatHistory) global.chatHistory = new Map();
                const history = global.chatHistory.get(telefoneReal) || [];

                if (history.length === 0) {
                    // Monta o prompt de sistema combinando o treinamento configurado
                    // com o nome real do contato — assim a IA nunca precisa usar [nome].
                    const nomeParaIA = nomeContato && nomeContato !== numLimpo
                        ? nomeContato.split(' ')[0]  // usa só o primeiro nome
                        : null;
                    let systemContent = config.openai_treinamento || '';
                    if (config.ia_campanha_mes) {
                        systemContent = systemContent
                            ? `${systemContent}\n\n# CAMPANHA DO MÊS (promoção vigente)\n${config.ia_campanha_mes}`
                            : `# CAMPANHA DO MÊS (promoção vigente)\n${config.ia_campanha_mes}`;
                    }
                    if (nomeParaIA) {
                        systemContent = systemContent
                            ? `${systemContent}\n\nVocê está conversando com ${nomeParaIA}. Ao personalizar a mensagem, use esse nome diretamente — nunca use [nome] ou {nome} como placeholder.`
                            : `Você está conversando com ${nomeParaIA}.`;
                    }
                    if (systemContent) history.push({ role: 'system', content: systemContent });
                }

                history.push({ role: 'user', content: texto });

                // Tenta com retry automático em caso de rate limit (429)
                const chamarIA = async (tentativa = 1) => {
                    try {
                        const openai = new OpenAI({
                            apiKey,
                            ...(provider === 'groq' && { baseURL: 'https://api.groq.com/openai/v1' })
                        });
                        return await openai.chat.completions.create({
                            messages: history,
                            model: modelo,
                            max_tokens: 300
                        });
                    } catch (e) {
                        if (e.status === 429 && tentativa < 3) {
                            const espera = tentativa * 15000; // 15s, 30s
                            console.log(`⏳ Rate limit (${provider}), tentativa ${tentativa}/3 — aguardando ${espera/1000}s...`);
                            await new Promise(r => setTimeout(r, espera));
                            return chamarIA(tentativa + 1);
                        }
                        throw e;
                    }
                };

                try {
                    const completion = await chamarIA();
                    // Substitui placeholders de nome antes de enviar — caso o treinamento
                    // ou o modelo ainda use [nome] ou {nome}, o aluno vê o nome de verdade.
                    const nomeExibir = (nomeContato && nomeContato !== numLimpo)
                        ? nomeContato.split(' ')[0]
                        : '';
                    const respostaIARaw = completion.choices[0].message.content;
                    const respostaIA = nomeExibir
                        ? respostaIARaw
                            .replace(/\[nome\]/gi, nomeExibir)
                            .replace(/\{nome\}/gi, nomeExibir)
                        : respostaIARaw;

                    history.push({ role: 'assistant', content: respostaIA });

                    if (history.length > 7) {
                        const sys = history.shift();
                        history.shift();
                        history.shift();
                        history.unshift(sys);
                    }
                    global.chatHistory.set(telefoneReal, history);

                    console.log(`🤖 IA respondendo para ${numLimpo}`);
                    const sentIA = await enviarResposta(msg, respostaIA);
                    io.emit('bot_digitando', { telefone: numLimpo, ativo: false });
                    if (sentIA) await registrarMensagemEnviada(telefoneReal, respostaIA, nomeContato, sentIA.id?._serialized);
                } catch (e) {
                    io.emit('bot_digitando', { telefone: numLimpo, ativo: false });
                    console.error(`❌ Erro na API da IA (${provider}):`, e.message);
                }
            }
            return;
        }

        // Usa moment-timezone para garantir o horário de Brasília
        // — o servidor (Railway) roda em UTC, então new Date().getHours() daria errado.
        const hora = moment.tz('America/Sao_Paulo').hours();
        let saudacao = 'Olá';
        if (hora >= 5  && hora < 12) saudacao = 'Bom dia';
        else if (hora >= 12 && hora < 18) saudacao = 'Boa tarde';
        else saudacao = 'Boa noite';

        // Substitui placeholders na resposta da regra
        const nomeExibir = (nomeContato && nomeContato !== numLimpo)
            ? nomeContato.split(' ')[0]
            : '';
        const nomeCompletoExibir = (nomeContato && nomeContato !== numLimpo) ? nomeContato : '';
        const matriculaExibir = await resolverMatriculaContato(numLimpo);
        const textoFinal = regraAtiva.resposta
            .replace(/{saudacao}/g, saudacao)
            .replace(/\[nome\]/gi, nomeExibir || '')
            .replace(/{nome}/gi, nomeExibir || '')
            .replace(/\[nome_completo\]/gi, nomeCompletoExibir || '')
            .replace(/{nome_completo}/gi, nomeCompletoExibir || '')
            .replace(/\[matricula\]/gi, matriculaExibir || '')
            .replace(/{matricula}/gi, matriculaExibir || '');
        console.log(`📤 Regra #${regraAtiva.id} ativada → respondendo para ${numLimpo}`);

        // Aplica automaticamente a etiqueta configurada nesta regra (se houver)
        if (regraAtiva.etiqueta_id) {
            await aplicarEtiquetaContato(numLimpo, regraAtiva.etiqueta_id);
        }

        const sent = await enviarResposta(msg, textoFinal);
        io.emit('bot_digitando', { telefone: numLimpo, ativo: false });
        if (sent) await registrarMensagemEnviada(telefoneReal, textoFinal, nomeContato, sent.id?._serialized);

        // Áudio temporariamente desativado (causa timeout no Puppeteer)
        // if (regraAtiva.enviar_audio) { ... }

        if (regraAtiva.media_path) {
            const mediaFullPath = path.join(__dirname, 'public', regraAtiva.media_path.replace(/^\//, ''));
            if (fs.existsSync(mediaFullPath)) {
                await delay(500);
                const media = MessageMedia.fromFilePath(mediaFullPath);
                const sentMedia = await enviarResposta(msg, media);
                if (sentMedia) await registrarMensagemEnviada(telefoneReal, '[mídia enviada]', nomeContato, sentMedia.id?._serialized);
            }
        }
    } catch (error) {
        console.error('❌ Erro no processamento da mensagem:', error);
    }
});

// Reação a uma mensagem (❤️, 👍 etc) é um evento SEPARADO no WhatsApp — não
// passa por 'message'/'message_create'. Sem esse handler, uma conversa cuja
// última interação real foi uma reação (comum: cliente reage em vez de
// responder por texto) ficava "parada" no painel na última mensagem de texto
// enviada, enquanto no WhatsApp de verdade a conversa continuou depois disso —
// o painel parecia defasado mesmo com o horário das mensagens de texto certo.
client.on('message_reaction', async (reaction) => {
    try {
        if (!reaction.reaction) return; // reação removida (undo) — nada de novo pra mostrar
        const remoteChat = reaction.id?.remote;
        if (!remoteChat || remoteChat.endsWith('@g.us') || remoteChat.endsWith('@broadcast')) return;

        const telefoneResolvido = await resolveJid(remoteChat);
        const numLimpo = telefoneResolvido.replace('@c.us', '').replace('@lid', '');
        const nome = await resolverNomeContato(numLimpo);
        const direcao = reaction.id?.fromMe ? 'out' : 'in';
        await salvarNaConversa(numLimpo, nome, direcao, `Reagiu com ${reaction.reaction}`, 'reaction', reaction.timestamp);
    } catch (e) {
        console.error('Erro ao registrar reação:', e.message);
    }
});

// =====================================
// INICIALIZAÇÃO
// =====================================
(async () => {
    await initDB();
    client.initialize();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`🌐 Painel rodando em: http://localhost:${PORT}`));
})();

const shutdown = async () => {
    console.log('⏳ Desligando robô de forma segura...');
    await client.destroy();
    if (db) await db.close();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
