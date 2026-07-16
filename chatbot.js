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
} catch (_) { }

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
} catch (_) { }

// =====================================
// IMPORTAÇÕES
// =====================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const pdfParse = require('pdf-parse');
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
const { buscarAlunoPorMatricula, buscarAlunoPorCodigo, obterParcelasEmAberto, criarCliente, matricularAluno, gerarLinkPagamentoPixSantander } = require('./pacto');
const { enviarMensagemInstagram, obterNomeUsuarioInstagram, verificarAssinaturaWebhook } = require('./instagram');
const { buscarAgendaDoDia } = require('./agenda');

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
// (bot, dashboard). Usado pelo listener message_create pra distinguir
// isso de mensagens mandadas direto pelo celular/WhatsApp Web vinculado, que
// também precisam aparecer no Bate Papo ao Vivo mas ainda não foram salvas.
const idsMensagensDoSistema = new Set();
// Fallback pro caso de client.sendMessage() devolver undefined mesmo quando a
// mensagem FOI entregue de verdade (bug conhecido do WhatsApp Web, já visto
// no download de mídia) — sem um id de verdade pra marcar, o message_create
// dessa mesma mensagem não batia com nada em idsMensagensDoSistema e acabava
// sendo tratado como "eco do celular", duplicando a mensagem na conversa
// (mesma mensagem, texto idêntico, ts a poucos milissegundos de diferença).
// telefone+texto como chave é bem mais grosseiro que o id de verdade, mas só
// entra em jogo quando o id não veio mesmo.
const conteudosMensagensDoSistema = new Set();
function marcarMensagemComoDoSistema(msgId, telefone = null, texto = null) {
    if (msgId) {
        idsMensagensDoSistema.add(msgId);
        // O message_create correspondente chega quase instantaneamente — 60s de
        // janela é sobra, evita a Set crescer pra sempre.
        setTimeout(() => idsMensagensDoSistema.delete(msgId), 60000);
    }
    if (telefone && texto) {
        const chave = `${telefone}|${texto}`;
        conteudosMensagensDoSistema.add(chave);
        setTimeout(() => conteudosMensagensDoSistema.delete(chave), 60000);
    }
}

// Em produção (Railway), aponta para o volume persistente; localmente, usa a pasta do projeto.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = path.join(DATA_DIR, 'database.sqlite');

// public/uploads fica DENTRO da imagem do container — em todo deploy novo ele
// volta a ser só o .gitkeep do repositório, apagando qualquer mídia enviada
// (Regras, Automação). Guarda os arquivos de verdade no volume
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

// Corrige duplicatas de leads.telefone — telefone é PRIMARY KEY, mas pelo
// menos 3 contatos acabaram com 2 linhas pro mesmo número (uma origem
// 'whatsapp', outra 'pacto'), provavelmente de uma corrida entre o import
// do Pacto e uma mensagem real chegando ao mesmo tempo (ver upsert em
// processarImportacaoPactoContatos). Mescla os dados na linha com mais
// mensagens recebidas (a mais "real"/ativa; empate desempata pela mais
// antiga) e apaga a(s) outra(s). Idempotente — não faz nada se não houver
// duplicata. Roda no início E fica exposta em
// POST /api/admin/mesclar-leads-duplicados pra rodar sob demanda.
async function mesclarLeadsDuplicados() {
    const relatorio = [];
    try {
        const linhasLeads = await db.all('SELECT rowid, telefone, nome, matricula, data_nascimento, data_captura, mensagens_recebidas FROM leads');
        // Agrupa pelo telefone totalmente normalizado (mesma função usada no
        // resto do sistema: tira sufixo @c.us/@lid E resolve a variação do
        // 9º dígito do celular) — as linhas duplicadas não tinham telefone
        // idêntico de verdade (isso violaria a PRIMARY KEY); eram variações
        // válidas e diferentes do MESMO número (com/sem sufixo, com/sem o
        // 9), que /api/contatos e o resto do sistema já tratam como o mesmo
        // contato, por isso pareciam duplicadas na tela.
        const porTelefone = new Map();
        linhasLeads.forEach(l => {
            const chave = normalizarTelefoneBR(l.telefone);
            if (!porTelefone.has(chave)) porTelefone.set(chave, []);
            porTelefone.get(chave).push(l);
        });
        for (const [telefoneDuplicado, grupo] of porTelefone) {
            if (grupo.length < 2) continue;
            grupo.sort((a, b) => (b.mensagens_recebidas - a.mensagens_recebidas) || (new Date(a.data_captura) - new Date(b.data_captura)));
            const manter = grupo[0];
            const outras = grupo.slice(1);
            const nome = manter.nome || outras.find(o => o.nome)?.nome || null;
            const matricula = manter.matricula || outras.find(o => o.matricula)?.matricula || null;
            const dataNascimento = manter.data_nascimento || outras.find(o => o.data_nascimento)?.data_nascimento || null;
            const totalMensagens = grupo.reduce((soma, l) => soma + (l.mensagens_recebidas || 0), 0);
            await db.run(
                'UPDATE leads SET nome = ?, matricula = ?, data_nascimento = ?, mensagens_recebidas = ? WHERE rowid = ?',
                [nome, matricula, dataNascimento, totalMensagens, manter.rowid]
            );
            for (const o of outras) await db.run('DELETE FROM leads WHERE rowid = ?', o.rowid);
            console.log(`🔧 Mesclado(s) ${outras.length} registro(s) duplicado(s) de leads pro telefone ${telefoneDuplicado} (mantido rowid ${manter.rowid}).`);
            relatorio.push({ telefone: telefoneDuplicado, apagados: outras.length, rowidMantido: manter.rowid });
        }
    } catch (e) {
        console.error('Erro ao mesclar leads duplicados:', e.message);
    }
    return relatorio;
}

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
        CREATE TABLE IF NOT EXISTS automacao_envios_erros_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            automacao_id INTEGER NOT NULL,
            telefone TEXT NOT NULL,
            erro TEXT NOT NULL,
            ocorrido_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_automacao_envios_erros_log_telefone ON automacao_envios_erros_log(telefone);
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
        CREATE TABLE IF NOT EXISTS pacto_vencem_hoje (
            telefone TEXT PRIMARY KEY,
            nome TEXT,
            matricula TEXT,
            qtd_parcelas INTEGER,
            valor_total REAL,
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS agenda_avaliacoes_hoje (
            appointment_id TEXT PRIMARY KEY,
            telefone TEXT,
            nome TEXT,
            matricula TEXT,
            horario TEXT,
            professor TEXT,
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS ia_uso_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telefone TEXT,
            provedor TEXT NOT NULL,
            modelo TEXT NOT NULL,
            prompt_tokens INTEGER DEFAULT 0,
            completion_tokens INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            ts DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ia_uso_log_ts ON ia_uso_log(ts);
        CREATE TABLE IF NOT EXISTS conexao_eventos_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT NOT NULL,
            motivo TEXT,
            ts DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_conexao_eventos_log_ts ON conexao_eventos_log(ts);
        CREATE TABLE IF NOT EXISTS disparo_envios_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telefone TEXT NOT NULL,
            sucesso INTEGER NOT NULL,
            erro TEXT,
            enviado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_disparo_envios_log_ts ON disparo_envios_log(enviado_em);
        -- Relatório "Contratos Sem Assinar": lista importada de um PDF do Pacto
        -- (um link por consultora), com checkbox "Assinado" que tira da lista.
        -- UNIQUE(consultora, matricula) permite reimportar a mesma lista sem
        -- duplicar quem já está lá (idempotente) nem perder quem já foi marcado.
        CREATE TABLE IF NOT EXISTS contratos_sem_assinar (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            consultora TEXT NOT NULL,
            nome TEXT NOT NULL,
            matricula TEXT NOT NULL,
            telefone TEXT,
            assinado INTEGER DEFAULT 0,
            assinado_em DATETIME,
            criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(consultora, matricula)
        );
        CREATE INDEX IF NOT EXISTS idx_contratos_sem_assinar_consultora ON contratos_sem_assinar(consultora, assinado);
        -- Dedup de reações (client.on('message_reaction')) — o WhatsApp Web
        -- reenvia reações "antigas" toda vez que a sessão resincroniza (mesmo
        -- comportamento de backlog já visto em mensagens normais), e sem essa
        -- tabela a MESMA reação virava uma linha nova na conversa a cada
        -- reconexão/redeploy, se acumulando pra sempre (encontrado uma reação
        -- com 11 cópias idênticas na conversa de uma aluna).
        CREATE TABLE IF NOT EXISTS reacoes_processadas (
            chave TEXT PRIMARY KEY,
            processado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        -- Números de WhatsApp extras, dedicados só a mandar Disparos em massa
        -- (nunca respondem ninguém) — reduz o risco de o número principal ser
        -- banido pelo alto volume de envio. Cada linha vira uma sessão própria
        -- do whatsapp-web.js (LocalAuth clientId = client_id), independente da
        -- sessão do número principal.
        CREATE TABLE IF NOT EXISTS disparo_numeros (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            client_id TEXT NOT NULL UNIQUE,
            ativo INTEGER DEFAULT 1,
            criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        -- Qual(is) número(s) do pool de Disparo mandam cada campanha (mesma
        -- chave de CAMPANHAS_INFO / mensagens_personalizadas.categoria).
        -- numeros_ids é um CSV de disparo_numeros.id: 1 id = exclusivo desse
        -- número; 2+ ids = revezam (round-robin) só entre eles. Sem linha pra
        -- uma campanha = usa todos os números do pool conectados.
        CREATE TABLE IF NOT EXISTS disparo_roteamento (
            campanha_chave TEXT PRIMARY KEY,
            numeros_ids TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS programacoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            dias TEXT NOT NULL,
            horario TEXT NOT NULL,
            ativo INTEGER DEFAULT 1,
            ultima_execucao_em TEXT,
            criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS programacao_acoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            programacao_id INTEGER NOT NULL,
            automacao_id INTEGER NOT NULL,
            ordem INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_programacao_acoes_prog ON programacao_acoes(programacao_id);
        CREATE TABLE IF NOT EXISTS integracao_programacoes (
            chave TEXT PRIMARY KEY,
            dias TEXT NOT NULL,
            horario TEXT NOT NULL,
            ativo INTEGER DEFAULT 1,
            ultima_execucao_em TEXT
        );
        CREATE TABLE IF NOT EXISTS relatorio_dispensados (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT NOT NULL,
            telefone TEXT NOT NULL,
            dispensado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(tipo, telefone)
        );
        CREATE TABLE IF NOT EXISTS ia_exemplos_consultoras (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telefone TEXT,
            pergunta_cliente TEXT NOT NULL,
            resposta_consultora TEXT NOT NULL,
            embedding TEXT NOT NULL,
            origem_conversa_id INTEGER,
            criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ia_exemplos_criado ON ia_exemplos_consultoras(criado_em);
        -- Índice único parcial: só entra em conflito quando origem_conversa_id
        -- vem preenchido (backfill histórico) — evita reimportar a mesma
        -- mensagem se o botão "Importar Histórico" for clicado de novo. As
        -- indexações em tempo real (registrarMensagemEnviada) deixam essa
        -- coluna NULL, e SQLite permite múltiplos NULL num índice único.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ia_exemplos_origem ON ia_exemplos_consultoras(origem_conversa_id) WHERE origem_conversa_id IS NOT NULL;
    `);
    try { await db.exec(`ALTER TABLE programacao_acoes ADD COLUMN intervalo_depois_segundos INTEGER DEFAULT 60`); } catch (e) { }
    // "automacao" = roda Importar Lista (sincroniza a fila com quem tem a
    // etiqueta agora); "disparo" = roda Disparar Mensagens (manda pra quem já
    // está na fila). Default 'disparo' preserva o comportamento das
    // programações criadas antes dessa distinção existir (só disparavam).
    try { await db.exec(`ALTER TABLE programacao_acoes ADD COLUMN tipo TEXT DEFAULT 'disparo'`); } catch (e) { }
    // Chave da Campanha Rápida (ex: 'aniversariantes') quando a ação foi
    // escolhida pelo atalho "Disparo" — só pra reabrir o seletor certo ao
    // editar; a automação-alvo em si já está resolvida em automacao_id.
    try { await db.exec(`ALTER TABLE programacao_acoes ADD COLUMN campanha_chave TEXT DEFAULT NULL`); } catch (e) { }
    // Nome do número do pool de Disparo que mandou aquela mensagem (não o id
    // — assim o relatório continua mostrando quem mandou mesmo se o número
    // for removido do pool depois). NULL pros envios antigos, de antes dessa
    // feature existir.
    try { await db.exec(`ALTER TABLE disparo_envios_log ADD COLUMN numero_envio TEXT DEFAULT NULL`); } catch (e) { }
    // Canal de origem do contato/mensagem ('whatsapp' ou 'instagram') — leads
    // e conversas continuam com a mesma chave opaca (telefone ou IGSID do
    // Instagram), só ganham essa coluna a mais pra saber por onde falar com
    // esse contato e pra filtrar relatórios/limpezas específicas de canal.
    try { await db.exec(`ALTER TABLE leads ADD COLUMN canal TEXT DEFAULT 'whatsapp'`); } catch (e) { }
    try { await db.exec(`ALTER TABLE conversas ADD COLUMN canal TEXT DEFAULT 'whatsapp'`); } catch (e) { }
    // Dedup de mensagens do webhook do Instagram — a Meta não garante entrega
    // única, pode reenviar o MESMO evento se a resposta demorar/falhar. Sem
    // isso, uma reentrega processava a mensagem de novo (lead duplicado,
    // robô respondendo duas vezes). Fica numa tabela (não só em memória)
    // porque o processo reinicia com frequência (deploys).
    try {
        await db.exec(`CREATE TABLE IF NOT EXISTS instagram_mensagens_processadas (
            mid TEXT PRIMARY KEY,
            processado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    } catch (e) { console.error('Erro ao criar tabela de dedup do Instagram:', e.message); }

    // Semeia as programações automáticas que antes eram horários fixos no
    // código (Agenda de Avaliação às 06:00, Situação Financeira às 06:05,
    // dias úteis) — agora editáveis em Integração → "Criar Programação". Só
    // roda se a chave ainda não existir, pra não sobrescrever o que o usuário
    // já configurou. "Importar Contatos do Pacto" não tinha automático antes,
    // então não ganha semente — fica sem programação até o usuário criar uma.
    try {
        await db.run(`INSERT OR IGNORE INTO integracao_programacoes (chave, dias, horario, ativo) VALUES ('agenda_avaliacao', '1,2,3,4,5', '06:00', 1)`);
        await db.run(`INSERT OR IGNORE INTO integracao_programacoes (chave, dias, horario, ativo) VALUES ('situacao_financeira', '1,2,3,4,5', '06:05', 1)`);
    } catch (e) { console.error('Erro ao semear programações de integração:', e.message); }

    // relatorio_dispensados ganhou uma coluna "motivo" (cada relatório passou
    // a ter 2 checkboxes independentes em vez de 1) — SQLite não deixa alterar
    // UNIQUE via ALTER TABLE, então recria a tabela (rename → cria nova →
    // copia o que já existia como motivo 'corrigido' → apaga a antiga).
    try {
        const colsRelatorio = await db.all("PRAGMA table_info(relatorio_dispensados)");
        const jaTemMotivo = colsRelatorio.some(c => c.name === 'motivo');
        if (!jaTemMotivo) {
            await db.exec(`ALTER TABLE relatorio_dispensados RENAME TO relatorio_dispensados_old`);
            await db.exec(`
                CREATE TABLE relatorio_dispensados (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tipo TEXT NOT NULL,
                    motivo TEXT NOT NULL,
                    telefone TEXT NOT NULL,
                    dispensado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(tipo, motivo, telefone)
                )
            `);
            await db.run(`INSERT INTO relatorio_dispensados (tipo, motivo, telefone, dispensado_em) SELECT tipo, 'corrigido', telefone, dispensado_em FROM relatorio_dispensados_old`);
            await db.exec(`DROP TABLE relatorio_dispensados_old`);
        }
    } catch (e) { console.error('Erro na migração de relatorio_dispensados:', e.message); }

    // Migração única: contato_automacao_estado.ultimo_erro é apagado sempre que
    // o contato sai da fila (sucesso no reenvio, automação pausada, etiqueta
    // removida etc) — não serve de histórico permanente. Copia os erros que
    // estão na fila HOJE pro log persistente (automacao_envios_erros_log) uma
    // única vez, pra quem já aparece no Relatório de Erros não sumir da lista
    // quando o relatório passar a ler só do log novo.
    try {
        const jaMigrouErros = await db.get("SELECT valor FROM configuracoes WHERE chave = 'automacao_erros_log_migrado'");
        if (!jaMigrouErros) {
            await db.run(`
                INSERT INTO automacao_envios_erros_log (automacao_id, telefone, erro, ocorrido_em)
                SELECT automacao_id, telefone, ultimo_erro, ultimo_erro_em FROM contato_automacao_estado WHERE ultimo_erro IS NOT NULL
            `);
            await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['automacao_erros_log_migrado', 'true']);
        }
    } catch (e) { console.error('Erro ao migrar erros de automação existentes pro log persistente:', e.message); }

    // Migração única: agenda_avaliacoes_hoje tinha telefone como chave, o que
    // significava que agendamento SEM WhatsApp válido nunca era salvo (não tem
    // chave pra salvar) — ficava invisível na tela, sem jeito de corrigir o
    // número antes de automatizar. A chave vira appointment_id (sempre existe,
    // venha ou não WhatsApp junto) e telefone passa a ser um campo comum, editável.
    try {
        const colsAgenda = await db.all("PRAGMA table_info(agenda_avaliacoes_hoje)");
        const telefoneEhChave = colsAgenda.some(c => c.name === 'telefone' && c.pk === 1);
        if (telefoneEhChave) {
            await db.exec(`ALTER TABLE agenda_avaliacoes_hoje RENAME TO agenda_avaliacoes_hoje_old`);
            await db.exec(`
                CREATE TABLE agenda_avaliacoes_hoje (
                    appointment_id TEXT PRIMARY KEY,
                    telefone TEXT,
                    nome TEXT,
                    matricula TEXT,
                    horario TEXT,
                    professor TEXT,
                    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await db.run(`
                INSERT OR IGNORE INTO agenda_avaliacoes_hoje (appointment_id, telefone, nome, matricula, horario, professor, atualizado_em)
                SELECT COALESCE(appointment_id, telefone), telefone, nome, matricula, horario, professor, atualizado_em FROM agenda_avaliacoes_hoje_old
            `);
            await db.exec(`DROP TABLE agenda_avaliacoes_hoje_old`);
        }
    } catch (e) { console.error('Erro na migração de agenda_avaliacoes_hoje:', e.message); }

    // Corrige duplicatas de leads.telefone (telefone é PRIMARY KEY, mas
    // algumas escaparam disso — ver mesclarLeadsDuplicados). Roda toda vez
    // no início — é barato (uma leitura da tabela toda) e não faz nada se
    // não houver duplicata, então serve de rede de segurança permanente.
    // Também exposta em POST /api/admin/mesclar-leads-duplicados pra rodar
    // sob demanda, sem depender de um restart do processo.
    await mesclarLeadsDuplicados();

    // Rede de segurança do Horário de Funcionamento (robô assume depois de N
    // segundos sem resposta humana): liga por padrão com 180s na primeira vez
    // que o servidor sobe com essa feature — pedido explícito do usuário pra
    // já valer sem precisar abrir Configurações e marcar o checkbox à toa.
    // INSERT OR IGNORE: só define o padrão se a chave nunca existiu; depois
    // disso, quem decide é o usuário salvando o formulário normalmente.
    try {
        await db.run("INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('horario_fallback_ativo', 'true')");
        await db.run("INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('horario_fallback_segundos', '180')");
    } catch (e) { console.error('Erro ao definir padrão da rede de segurança de horário:', e.message); }

    // Adiciona colunas novas se migrando de versão anterior
    try { await db.exec(`ALTER TABLE respostas ADD COLUMN media_path TEXT DEFAULT NULL`); } catch (e) { }
    try { await db.exec(`ALTER TABLE respostas ADD COLUMN media_tipo TEXT DEFAULT NULL`); } catch (e) { }
    try { await db.exec(`ALTER TABLE respostas ADD COLUMN etiqueta_id INTEGER DEFAULT NULL`); } catch (e) { }
    // Nome do contato importado via planilha (antes de ele mandar a primeira mensagem)
    try { await db.exec(`ALTER TABLE leads ADD COLUMN nome TEXT DEFAULT NULL`); } catch (e) { }
    try { await db.exec(`ALTER TABLE leads ADD COLUMN origem TEXT DEFAULT NULL`); } catch (e) { }
    // Matrícula editada manualmente na Audiência — separada de vinculo_pacto (que
    // exige codigo_cliente/codigo_pessoa) pra permitir contato sem vínculo formal
    // com o Pacto ainda assim ter uma matrícula cadastrada (mesmo padrão do nome).
    try { await db.exec(`ALTER TABLE leads ADD COLUMN matricula TEXT DEFAULT NULL`); } catch (e) { }
    try { await db.exec(`ALTER TABLE leads ADD COLUMN data_nascimento TEXT DEFAULT NULL`); } catch (e) { }
    // Se a etapa tem mensagens da biblioteca (Mensagens Personalizadas) anexadas
    // e mais de uma, manda uma diferente por contato em vez de sempre a mesma.
    try { await db.exec(`ALTER TABLE automacao_etapas ADD COLUMN envio_aleatorio INTEGER DEFAULT 0`); } catch (e) { }
    // Mensagem sorteada (de entre as anexadas nas etapas da automação) que
    // esse contato específico vai receber quando o disparo dessa automação
    // rodar em Disparos — cada contato recebe UMA, escolhida na hora do
    // disparo se ainda não tiver uma atribuída, e mantém a mesma depois.
    try { await db.exec(`ALTER TABLE contato_automacao_estado ADD COLUMN mensagem_id INTEGER DEFAULT NULL`); } catch (e) { }
    // Guarda o motivo da última falha de envio (ex: "número não tem WhatsApp",
    // timeout) pra mostrar na tela de acompanhamento — antes só ficava no log
    // do servidor, staff não tinha como saber por que um contato específico
    // nunca recebe a mensagem sem pedir pra checar o Railway.
    try { await db.exec(`ALTER TABLE contato_automacao_estado ADD COLUMN ultimo_erro TEXT DEFAULT NULL`); } catch (e) { }
    try { await db.exec(`ALTER TABLE contato_automacao_estado ADD COLUMN ultimo_erro_em DATETIME DEFAULT NULL`); } catch (e) { }
    // Janela de horário permitida pra automação mandar mensagem (HH:mm) — vazio = sem restrição
    try { await db.exec(`ALTER TABLE automacoes ADD COLUMN horario_inicio TEXT DEFAULT NULL`); } catch (e) { }
    try { await db.exec(`ALTER TABLE automacoes ADD COLUMN horario_fim TEXT DEFAULT NULL`); } catch (e) { }
    // Se, ao concluir a última etapa, a etiqueta que disparou a automação some do contato (padrão: sim)
    try { await db.exec(`ALTER TABLE automacoes ADD COLUMN remove_etiqueta_ao_concluir INTEGER DEFAULT 1`); } catch (e) { }
    // Contador histórico de quantos contatos já terminaram a automação inteira
    try { await db.exec(`ALTER TABLE automacoes ADD COLUMN total_concluidos INTEGER DEFAULT 0`); } catch (e) { }
    // Unidade do "Aguardar X" de cada etapa — 'dias' (produção) ou 'horas' (testar rápido)
    try { await db.exec(`ALTER TABLE automacao_etapas ADD COLUMN unidade_tempo TEXT DEFAULT 'dias'`); } catch (e) { }
    // Distingue mensagem enviada pelo robô (regra/IA/automação) de mensagem
    // digitada por um atendente humano (dashboard ou direto no celular vinculado)
    // — mostra o rótulo certo ("🤖 Bot" vs "👤 Atendente") no Bate Papo ao Vivo.
    try { await db.exec(`ALTER TABLE conversas ADD COLUMN manual INTEGER DEFAULT 0`); } catch (e) { }
    // Caminho do arquivo (imagem/documento/vídeo/figurinha) salvo em
    // public/uploads pra poder ser aberto clicando na bolha do Bate Papo ao
    // Vivo — antes a mídia recebida nunca era baixada, só o rótulo do tipo.
    try { await db.exec(`ALTER TABLE conversas ADD COLUMN media_path TEXT DEFAULT NULL`); } catch (e) { }
    // Etiqueta temporária (ex: "Desafio 30 dias"): duracao_dias define quanto
    // tempo ela dura DESDE QUE APLICADA em CADA contato — a etiqueta em si
    // nunca "acaba" (continua existindo pra aplicar em gente nova), só a
    // vinculação com aquele contato específico expira sozinha. NULL = etiqueta
    // permanente (comportamento de sempre, sem mudança pra etiquetas atuais).
    try { await db.exec(`ALTER TABLE etiquetas ADD COLUMN duracao_dias INTEGER DEFAULT NULL`); } catch (e) { }
    try { await db.exec(`ALTER TABLE contato_etiquetas ADD COLUMN expira_em DATETIME DEFAULT NULL`); } catch (e) { }
    // "Mensagens Personalizadas" vira biblioteca de VÁRIAS campanhas (não só
    // aniversário) — categoria identifica qual "Campanha Rápida" (Aniversariantes,
    // Inadimplentes, etc) a mensagem pertence. Migração "importa" as que já
    // existiam pelo padrão do NOME (não joga tudo em "aniversariantes" cego —
    // já existiam mensagens de cobrança/ex-aluno na mesma tabela, misturar
    // categoria errada faria elas somem do filtro certo e apareçam no errado).
    // Só mexe em quem ainda não tem categoria nenhuma; o que não reconhece
    // pelo nome fica sem categoria (nunca chuta errado).
    try {
        await db.exec(`ALTER TABLE mensagens_personalizadas ADD COLUMN categoria TEXT DEFAULT NULL`);
        await db.run(`UPDATE mensagens_personalizadas SET categoria = 'aniversariantes' WHERE categoria IS NULL AND nome LIKE 'Aniversário%'`);
        await db.run(`UPDATE mensagens_personalizadas SET categoria = 'inadimplentes' WHERE categoria IS NULL AND nome LIKE 'Cobrança%'`);
        await db.run(`UPDATE mensagens_personalizadas SET categoria = 'ex-alunos' WHERE categoria IS NULL AND (nome LIKE 'Ex Aluno%' OR nome LIKE 'Ex-Aluno%')`);
    } catch (e) { }
    // Feature "Fluxos" (Flow Builder visual) removida a pedido — limpeza única
    // das tabelas que sobraram de quando ela existia.
    try { await db.exec(`DROP TABLE IF EXISTS fluxos`); } catch (e) { }
    try { await db.exec(`DROP TABLE IF EXISTS contato_estado_fluxo`); } catch (e) { }
    // Garante tabela conversas em instalações antigas
    try { await db.exec(`CREATE TABLE IF NOT EXISTS conversas (id INTEGER PRIMARY KEY AUTOINCREMENT, telefone TEXT NOT NULL, nome TEXT, direcao TEXT NOT NULL, texto TEXT, tipo TEXT DEFAULT 'text', ts DATETIME DEFAULT CURRENT_TIMESTAMP, lida INTEGER DEFAULT 0)`); } catch (e) { }
    try { await db.exec(`CREATE INDEX IF NOT EXISTS idx_conversas_tel ON conversas(telefone, ts)`); } catch (e) { }
    try { await db.exec(`CREATE INDEX IF NOT EXISTS idx_conversas_ts ON conversas(ts DESC)`); } catch (e) { }
    // Limpa contatos falsos de canais/listas de transmissão (@broadcast) que
    // entraram antes do filtro cobrir esse padrão — poluíam a lista de Conversas.
    try { await db.exec(`DELETE FROM conversas WHERE telefone LIKE '%@broadcast'`); } catch (e) { }
    try { await db.exec(`DELETE FROM leads WHERE telefone LIKE '%@broadcast'`); } catch (e) { }

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
    const num = telefone.replace('@c.us', '').replace('@lid', '');
    if (nomeContatos.has(num)) return nomeContatos.get(num);
    try {
        const vinculo = await db.get('SELECT nome FROM vinculo_pacto WHERE telefone LIKE ?', [`%${num}%`]);
        if (vinculo?.nome) { nomeContatos.set(num, vinculo.nome); return vinculo.nome; }
    } catch (_) { }
    try {
        // Contato criado manualmente ou importado por planilha — nunca mandou
        // mensagem, então não tem pushname nem entrada em vinculo_pacto, mas já
        // tem nome cadastrado em leads (mesma fonte usada na tela de Contatos).
        const lead = await db.get(
            'SELECT nome FROM leads WHERE telefone = ? OR telefone = ? OR telefone = ?',
            [num, `${num}@c.us`, `${num}@lid`]
        );
        if (lead?.nome) { nomeContatos.set(num, lead.nome); return lead.nome; }
    } catch (_) { }
    return num;
}

// Matrícula do aluno, pro placeholder {matricula} em Regras/Automação —
// vem do mesmo vínculo com o CRM Pacto usado na coluna Matrícula de Contatos.
// Sem vínculo (contato que nunca se matriculou/nunca conversou sobre isso),
// devolve string vazia — o placeholder some da mensagem em vez de mostrar "null".
const matriculaContatos = new Map();
async function resolverMatriculaContato(telefone) {
    const num = telefone.replace('@c.us', '').replace('@lid', '');
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
    } catch (_) { }
    try {
        const vinculo = await db.get('SELECT matricula FROM vinculo_pacto WHERE telefone LIKE ?', [`%${num}%`]);
        const matricula = vinculo?.matricula || '';
        matriculaContatos.set(num, matricula);
        return matricula;
    } catch (_) { return ''; }
}

// Substitui {nome}/{nome_completo}/{matricula}/{saudacao} (e a forma com
// colchetes) por dados reais do contato — usado tanto quando o ROBÔ dispara
// uma regra automaticamente quanto no envio manual pelo Bate Papo ao Vivo.
// Sem isso no envio manual, digitar {nome} na caixa de texto manda a chave
// crua pro cliente em vez do nome dele (foi exatamente o bug relatado).
async function substituirPlaceholdersPessoais(texto, telefone) {
    const hora = moment.tz('America/Sao_Paulo').hours();
    const saudacao = hora >= 5 && hora < 12 ? 'Bom dia' : hora >= 12 && hora < 18 ? 'Boa tarde' : 'Boa noite';
    const num = telefone.replace('@c.us', '').replace('@lid', '');
    const nomeContato = await resolverNomeContato(num);
    const nomeExibir = (nomeContato && nomeContato !== num) ? nomeContato.split(' ')[0] : '';
    const nomeCompletoExibir = (nomeContato && nomeContato !== num) ? nomeContato : '';
    const matriculaExibir = await resolverMatriculaContato(num);
    return texto
        .replace(/{saudacao}/gi, saudacao)
        .replace(/\[nome\]/gi, nomeExibir || '')
        .replace(/{nome}/gi, nomeExibir || '')
        .replace(/\[nome_completo\]/gi, nomeCompletoExibir || '')
        .replace(/{nome_completo}/gi, nomeCompletoExibir || '')
        .replace(/\[matricula\]/gi, matriculaExibir || '')
        .replace(/{matricula}/gi, matriculaExibir || '');
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
async function salvarNaConversa(telefone, nome, direcao, texto, tipo = 'text', tsReal = null, manual = false, mediaPath = null, canal = 'whatsapp') {
    const num = telefone.replace('@c.us', '').replace('@lid', '');
    const ts = tsReal ? new Date(tsReal * 1000).toISOString() : new Date().toISOString();
    const lida = direcao === 'out' ? 1 : 0;
    const resultado = await db.run(
        'INSERT INTO conversas (telefone, nome, direcao, texto, tipo, ts, lida, manual, media_path, canal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [num, nome || num, direcao, texto, tipo, ts, lida, manual ? 1 : 0, mediaPath, canal]
    );
    // Conta não lidas deste telefone
    const naoLidas = await db.get('SELECT COUNT(*) as c FROM conversas WHERE telefone=? AND lida=0 AND direcao="in"', num);
    io.emit('nova_mensagem', { id: resultado.lastID, telefone: num, nome: nome || num, texto, direcao, tipo, ts, nao_lidas: naoLidas.c, manual, media_path: mediaPath, canal });

    // Qualquer mensagem nova (do cliente OU pro cliente — bot, automação,
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
    return resultado.lastID;
}

// =====================================
// IA — APRENDER COM RESPOSTAS REAIS DAS CONSULTORAS (RAG, sem fine-tuning)
// =====================================
// Toda vez que uma consultora responde manualmente pelo Bate Papo ao Vivo,
// guardamos o par (pergunta do cliente, resposta dela) com um embedding da
// pergunta. Na hora da IA responder, buscamos os exemplos mais parecidos com
// a mensagem atual e colocamos como referência de tom/estilo no prompt — sem
// nenhum retreinamento de modelo, só cresce sozinho a cada resposta manual.

// Redação básica de PII (best-effort — pega CPF/e-mail/sequências longas de
// dígitos em formato comum, não é uma garantia de anonimização completa).
function redigirPII(texto) {
    if (!texto) return texto;
    return texto
        .replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '[dado removido]')
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[dado removido]')
        .replace(/\b\d{10,11}\b/g, '[dado removido]');
}

// Embeddings SEMPRE usam a API da OpenAI (Groq não tem endpoint de
// embeddings) — chave PRÓPRIA e separada (ia_embeddings_api_key), não
// reaproveita openai_api_key: esse campo só é editável na tela quando o
// provider de chat está em "OpenAI", então se o provider está em "Groq" (como
// neste projeto) o campo openai_api_key pode estar com um valor antigo/errado
// sem ninguém perceber — foi exatamente o que aconteceu aqui (tinha uma
// chave do Groq salva nesse campo por engano).
async function gerarEmbeddingsEmLote(textos) {
    if (!Array.isArray(textos) || textos.length === 0) return [];
    const row = await db.get("SELECT valor FROM configuracoes WHERE chave = 'ia_embeddings_api_key'");
    const apiKey = row?.valor;
    if (!apiKey) return [];
    const openai = new OpenAI({ apiKey });
    const resultado = await openai.embeddings.create({ model: 'text-embedding-3-small', input: textos });
    return resultado.data.map(d => d.embedding);
}
async function gerarEmbedding(texto) {
    const [embedding] = await gerarEmbeddingsEmLote([texto]);
    return embedding || null;
}

function similaridadeCosseno(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// O filtro de tamanho só vale pra RESPOSTA da consultora (é o que a IA vai
// imitar — "ok"/"👍"/"de nada" não ensinam nada de tom/estilo). A pergunta do
// cliente serve só de contexto e em conversa real é comum ser curta ("4170",
// "sim", um emoji) — exigir 15 caracteres nela também descartava quase tudo
// (confirmado ao vivo: 217 conversas revisadas, 0 indexadas, porque a
// pergunta anterior era um número de matrícula ou um "obrigada" curto).
const IA_EXEMPLO_RESPOSTA_TAMANHO_MINIMO = 15;
const IA_EXEMPLO_PERGUNTA_TAMANHO_MINIMO = 2;

// Fire-and-forget: chamada dentro de registrarMensagemEnviada quando
// manual===true. Nunca deve derrubar o envio real da mensagem — qualquer
// erro aqui só loga e segue.
async function indexarExemploConsultora(telefone, respostaTexto) {
    try {
        const configRow = await db.get("SELECT valor FROM configuracoes WHERE chave = 'ia_aprender_com_consultoras'");
        if (configRow?.valor !== 'true') return;
        if (!respostaTexto || respostaTexto.trim().length < IA_EXEMPLO_RESPOSTA_TAMANHO_MINIMO) return;

        const numLimpo = telefone.replace('@c.us', '').replace('@lid', '');
        const ultimaPergunta = await db.get(
            "SELECT texto FROM conversas WHERE telefone = ? AND direcao = 'in' ORDER BY ts DESC LIMIT 1",
            numLimpo
        );
        if (!ultimaPergunta?.texto || ultimaPergunta.texto.trim().length < IA_EXEMPLO_PERGUNTA_TAMANHO_MINIMO) return;

        const perguntaLimpa = redigirPII(ultimaPergunta.texto.trim());
        const respostaLimpa = redigirPII(respostaTexto.trim());
        const embedding = await gerarEmbedding(perguntaLimpa);
        if (!embedding) return;

        await db.run(
            'INSERT INTO ia_exemplos_consultoras (telefone, pergunta_cliente, resposta_consultora, embedding) VALUES (?, ?, ?, ?)',
            [numLimpo, perguntaLimpa, respostaLimpa, JSON.stringify(embedding)]
        );
    } catch (e) {
        console.error('Erro ao indexar exemplo de consultora:', e.message);
    }
}

// Busca os exemplos mais parecidos com a mensagem atual do cliente — carrega
// a tabela inteira e compara em JS (sem extensão de vetor no SQLite);
// tranquilo no volume esperado. Devolve [] sem custo se o recurso estiver
// desligado ou não tiver chave OpenAI configurada.
const IA_EXEMPLOS_SIMILARIDADE_MINIMA = 0.75;
async function buscarExemplosRelevantes(textoCliente, topK = 3) {
    try {
        const configRow = await db.get("SELECT valor FROM configuracoes WHERE chave = 'ia_aprender_com_consultoras'");
        if (configRow?.valor !== 'true') return [];
        if (!textoCliente || textoCliente.trim().length < 5) return [];

        const embeddingAtual = await gerarEmbedding(textoCliente);
        if (!embeddingAtual) return [];

        const exemplos = await db.all('SELECT pergunta_cliente, resposta_consultora, embedding FROM ia_exemplos_consultoras');
        if (exemplos.length === 0) return [];

        return exemplos
            .map(e => {
                let vetor;
                try { vetor = JSON.parse(e.embedding); } catch (_) { return null; }
                return { pergunta_cliente: e.pergunta_cliente, resposta_consultora: e.resposta_consultora, similaridade: similaridadeCosseno(embeddingAtual, vetor) };
            })
            .filter(e => e && e.similaridade >= IA_EXEMPLOS_SIMILARIDADE_MINIMA)
            .sort((a, b) => b.similaridade - a.similaridade)
            .slice(0, topK);
    } catch (e) {
        console.error('Erro ao buscar exemplos relevantes de consultoras:', e.message);
        return [];
    }
}

// Registra no histórico permanente cada mensagem realmente enviada pelo robô.
// É a única fonte da contagem "Mensagens Enviadas" — se está no contador, está nesta tabela.
async function registrarMensagemEnviada(telefone, texto, nome, msgId = null, manual = false, tipo = 'text', mediaPath = null, canal = 'whatsapp') {
    const numeroLimpo = telefone.replace('@c.us', '').replace('@lid', '');
    marcarMensagemComoDoSistema(msgId, numeroLimpo, texto);
    await db.run('INSERT INTO mensagens_enviadas (telefone, texto) VALUES (?, ?)', [numeroLimpo, texto]);
    stats.sent++;
    await salvarNaConversa(numeroLimpo, nome, 'out', texto, tipo, null, manual, mediaPath, canal);
    io.emit('message_out', { to: numeroLimpo, text: texto, ts: Date.now() });
    io.emit('stats', stats);
    if (manual) indexarExemploConsultora(numeroLimpo, texto).catch(e => console.error('Erro ao indexar exemplo (fire-and-forget):', e.message));
}

async function registerLead(telefone, canal = 'whatsapp') {
    stats.received++;
    if (!leadsSet.has(telefone)) {
        leadsSet.add(telefone);
        stats.leads++;
        await db.run('INSERT INTO leads (telefone, canal) VALUES (?, ?)', [telefone, canal]);
        io.emit('new_lead', { telefone, data_captura: new Date().toISOString() });
    } else {
        await db.run('UPDATE leads SET mensagens_recebidas = mensagens_recebidas + 1 WHERE telefone = ?', telefone);
    }
    io.emit('stats', stats);
}

// =====================================
// INTEGRAÇÃO COM INSTAGRAM (DMs via Meta Graph API)
// =====================================
// Token/App Secret/Verify Token ficam em `configuracoes` (tela de
// Configurações), não em variável de ambiente — dá pra trocar sem redeploy.
async function obterConfigInstagram() {
    const rows = await db.all("SELECT chave, valor FROM configuracoes WHERE chave LIKE 'instagram_%'");
    const config = {};
    rows.forEach(r => config[r.chave] = r.valor);
    return {
        pageAccessToken: config.instagram_page_access_token || null,
        appSecret: config.instagram_app_secret || null,
        verifyToken: config.instagram_verify_token || null,
    };
}

// Handshake de verificação do webhook — a Meta chama essa rota (GET) uma
// vez ao salvar a configuração no painel de desenvolvedor dela.
app.get('/webhook/instagram', async (req, res) => {
    try {
        const { verifyToken } = await obterConfigInstagram();
        const modo = req.query['hub.mode'];
        const tokenRecebido = req.query['hub.verify_token'];
        if (modo === 'subscribe' && verifyToken && tokenRecebido === verifyToken) {
            console.log('✅ Webhook do Instagram verificado pela Meta.');
            return res.status(200).send(req.query['hub.challenge']);
        }
        res.sendStatus(403);
    } catch (e) {
        console.error('Erro na verificação do webhook do Instagram:', e.message);
        res.sendStatus(500);
    }
});

// Evento de verdade (nova mensagem etc). `express.raw` só nessa rota — a
// assinatura (X-Hub-Signature-256) precisa ser calculada sobre o corpo CRU,
// antes de qualquer JSON.parse; o `express.json()` global do resto do app
// já teria consumido/parseado o corpo antes da gente conseguir os bytes crus.
app.post('/webhook/instagram', express.raw({ type: 'application/json' }), async (req, res) => {
    // Responde 200 JÁ — a Meta reenvia agressivamente se demorar ou não
    // receber 200 (mesmo padrão "responde na hora, processa depois" já
    // usado em /api/broadcast/start).
    res.sendStatus(200);
    try {
        const { appSecret } = await obterConfigInstagram();
        const assinatura = req.headers['x-hub-signature-256'];
        if (!verificarAssinaturaWebhook(req.body, assinatura, appSecret)) {
            console.error('⚠️ Webhook do Instagram: assinatura inválida — evento ignorado.');
            return;
        }
        const payload = JSON.parse(req.body.toString('utf8'));
        await processarWebhookInstagram(payload);
    } catch (e) {
        console.error('Erro ao processar webhook do Instagram:', e.message);
    }
});

async function processarWebhookInstagram(payload) {
    if (payload?.object !== 'instagram') return;
    for (const entry of payload.entry || []) {
        for (const evento of entry.messaging || []) {
            try {
                await processarMensagemInstagram(evento);
            } catch (e) {
                console.error('Erro ao processar mensagem do Instagram:', e.message);
            }
        }
    }
}

// Espelha, pro Instagram, o mesmo fluxo do client.on('message') do WhatsApp
// (registerLead → salvarNaConversa → conversas_humano → modo humano/robô),
// só que a entrega final passa por enviarRespostaCanal em vez de
// enviarResposta(msg,...) direto — ver seção "DESPACHO DE RESPOSTA POR CANAL".
async function processarMensagemInstagram(evento) {
    // Ignora eco (mensagem que a própria Página mandou, ecoada de volta) e
    // qualquer evento sem texto de verdade (read/delivery receipt, postback).
    if (evento.message?.is_echo) return;
    const igsid = evento.sender?.id;
    const texto = evento.message?.text;
    const mid = evento.message?.mid;
    if (!igsid || !texto) return;

    if (mid) {
        const jaProcessado = await db.get('SELECT 1 FROM instagram_mensagens_processadas WHERE mid = ?', mid);
        if (jaProcessado) return; // reentrega do mesmo evento — Meta não garante entrega única
        await db.run('INSERT OR IGNORE INTO instagram_mensagens_processadas (mid) VALUES (?)', mid);
    }

    const { pageAccessToken } = await obterConfigInstagram();
    const nomeContato = await obterNomeUsuarioInstagram(igsid, pageAccessToken);
    const textoNormalizado = texto.trim().toLowerCase();

    registerLead(igsid, 'instagram').catch(e => console.error('Erro ao registrar lead do Instagram:', e.message));
    await salvarNaConversa(igsid, nomeContato, 'in', texto, 'text', null, false, null, 'instagram');
    io.emit('message_in', { from: igsid, nome: nomeContato, text: texto, ts: Date.now() });

    const assumidaPorHumano = await db.get('SELECT 1 FROM conversas_humano WHERE telefone = ?', igsid);
    if (assumidaPorHumano) return;

    // Shim: processarComoRobo/agendarFallbackHumano só leem UMA propriedade
    // do objeto "msg" (msg.body) — tudo o mais que fariam com um Message de
    // verdade do whatsapp-web.js passa pelo despachante de canal, não pelo
    // shim. Ver comentário em cima de enviarRespostaCanal.
    const msgShim = { body: texto };

    const { modo, mensagemHumano, timezone } = await obterModoAtual();
    if (modo === 'humano') {
        const hoje = moment.tz(timezone || 'America/Sao_Paulo').format('YYYY-MM-DD');
        if (mensagemHumano && ultimaMsgModoHumano.get(igsid) !== hoje) {
            const mensagemHumanoFinal = await substituirPlaceholdersPessoais(mensagemHumano, igsid);
            const sentHumano = await enviarRespostaCanal('instagram', msgShim, igsid, mensagemHumanoFinal);
            if (sentHumano) {
                ultimaMsgModoHumano.set(igsid, hoje);
                await registrarMensagemEnviada(igsid, mensagemHumanoFinal, nomeContato, null, false, 'text', null, 'instagram');
            }
        }
        await agendarFallbackHumano(msgShim, igsid, textoNormalizado, igsid, nomeContato, 'instagram');
        return;
    }

    await processarComoRobo(msgShim, igsid, textoNormalizado, igsid, nomeContato, 'instagram');
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
// API REST — CONFIGURAÇÕES (genérico, chave/valor)
// =====================================
// Essa rota não tem autenticação e virou um dump genérico usado por várias
// telas que não têm nada a ver com IA (Delay de resposta, intervalo de
// Automação, etc.) — por isso as chaves de API NUNCA voltam aqui, senão
// qualquer um com a URL do painel conseguiria ler a chave da OpenAI/Groq
// em texto puro. Quem realmente precisa da chave (tela Inteligência
// Artificial, pra mostrar/editar o que já está salvo) usa /api/ia/config.
const CONFIG_CHAVES_SENSIVEIS = ['openai_api_key', 'groq_api_key', 'instagram_page_access_token', 'instagram_app_secret', 'instagram_verify_token', 'gympulse_webhook_key'];
app.get('/api/configuracoes', async (req, res) => {
    const rows = await db.all('SELECT * FROM configuracoes');
    const config = {};
    rows.forEach(r => { if (!CONFIG_CHAVES_SENSIVEIS.includes(r.chave)) config[r.chave] = r.valor; });
    res.json(config);
});

app.put('/api/configuracoes', async (req, res) => {
    const keys = Object.keys(req.body);
    for (const key of keys) {
        await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', [key, String(req.body[key])]);
    }
    res.json({ success: true });
});

// Config completa da IA (inclui a chave de API em texto puro) — usada só
// pela tela Inteligência Artificial, que precisa mostrar/editar a chave já
// salva. Deliberadamente separada da rota genérica acima.
app.get('/api/ia/config', async (req, res) => {
    const rows = await db.all('SELECT * FROM configuracoes');
    const config = {};
    rows.forEach(r => config[r.chave] = r.valor);
    res.json(config);
});

// Config do Instagram (token/secret/verify token em texto puro) — só pra
// tela de Configurações, que precisa mostrar/editar o que já foi salvo.
// Mesma separação de /api/ia/config: a rota genérica /api/configuracoes
// nunca devolve essas chaves.
app.get('/api/instagram/config', async (req, res) => {
    const rows = await db.all("SELECT chave, valor FROM configuracoes WHERE chave LIKE 'instagram_%'");
    const config = {};
    rows.forEach(r => config[r.chave] = r.valor);
    res.json({
        page_access_token: config.instagram_page_access_token || '',
        app_secret: config.instagram_app_secret || '',
        verify_token: config.instagram_verify_token || '',
    });
});

app.put('/api/instagram/config', async (req, res) => {
    const { page_access_token, app_secret, verify_token } = req.body;
    if (page_access_token !== undefined) await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['instagram_page_access_token', page_access_token]);
    if (app_secret !== undefined) await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['instagram_app_secret', app_secret]);
    if (verify_token !== undefined) await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['instagram_verify_token', verify_token]);
    res.json({ success: true });
});

// =====================================
// INTEGRAÇÃO COM GYMPULSE (resumo diário de treino → WhatsApp do aluno)
// =====================================
// A chave fica salva em "configuracoes" (mesmo padrão do resto das
// integrações) em vez de variável de ambiente — assim dá pra ver/regerar
// pela tela de Integração sem precisar mexer no Railway. Gera sozinha na
// primeira vez que alguém pede a config, pra já vir com um valor pronto pra
// colar no Gympulse sem precisar de um passo manual de "criar senha".
async function obterConfigGympulse() {
    const row = await db.get("SELECT valor FROM configuracoes WHERE chave = 'gympulse_webhook_key'");
    if (row?.valor) return { webhookKey: row.valor };
    const novaChave = require('crypto').randomBytes(24).toString('hex');
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['gympulse_webhook_key', novaChave]);
    return { webhookKey: novaChave };
}

app.get('/api/gympulse/config', async (req, res) => {
    const { webhookKey } = await obterConfigGympulse();
    res.json({ webhook_key: webhookKey });
});

// Regenerar invalida a chave antiga na hora — quem ainda usa a velha do lado
// do Gympulse passa a tomar 401 até atualizarem lá também.
app.put('/api/gympulse/config', async (req, res) => {
    const novaChave = require('crypto').randomBytes(24).toString('hex');
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['gympulse_webhook_key', novaChave]);
    res.json({ success: true, webhook_key: novaChave });
});

// Chamado pelo Gympulse toda vez que um aluno termina o treino do dia.
// matricula é a chave de ligação entre os dois sistemas — o BotPro já
// conhece o telefone de cada aluno pela matrícula (mesmo cadastro usado em
// Regras/Automação/Relatório).
app.post('/webhooks/gympulse-daily-report', async (req, res) => {
    try {
        const { webhookKey } = await obterConfigGympulse();
        const auth = req.headers['authorization'] || '';
        const tokenRecebido = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
        if (!webhookKey || tokenRecebido !== webhookKey) {
            return res.status(401).json({ error: 'Não autorizado.' });
        }

        const { matricula, studentName, totalCalories, totalPoints, totalDurationMin, zoneData } = req.body || {};
        if (!matricula) return res.status(400).json({ error: 'Campo "matricula" é obrigatório.' });

        // Mesmo padrão leading-zero-safe usado em /api/contatos/resolver-lista —
        // leads.matricula é TEXT e pode estar com ou sem zeros à esquerda
        // ("4284" vs "004284"), então compara tanto o texto quanto o número.
        const lead = await db.get(
            `SELECT telefone, nome FROM leads
             WHERE matricula IS NOT NULL AND TRIM(matricula) != '' AND (
                TRIM(matricula) = ?
                OR CAST(matricula AS INTEGER) = CAST(? AS INTEGER)
             )`,
            [String(matricula), String(matricula)]
        );
        if (!lead) return res.status(404).json({ error: 'Aluno não encontrado para esta matrícula.' });

        if (!isConnected) return res.status(503).json({ error: 'WhatsApp não está conectado no momento.' });

        let chatId;
        try {
            chatId = await resolverChatId(client, lead.telefone);
        } catch (e) {
            return res.status(422).json({ error: 'Aluno sem WhatsApp cadastrado.' });
        }

        const nomeExibir = studentName || lead.nome || lead.telefone;
        const primeiroNome = (nomeExibir.split(' ')[0] || nomeExibir);

        let mensagem = `Oi ${primeiroNome}! 💪 Resumo do seu treino de hoje:\n`;
        mensagem += `🔥 ${totalCalories ?? '-'} kcal\n`;
        mensagem += `🏆 ${totalPoints ?? '-'} pontos\n`;
        mensagem += `⏱️ ${totalDurationMin ?? '-'} min\n`;
        if (Array.isArray(zoneData) && zoneData.length > 0) {
            mensagem += `\n📊 Zonas de frequência:\n`;
            zoneData.forEach(z => {
                mensagem += `• ${z.name}: ${z.minutes} min (${z.percent}%)\n`;
            });
        }
        mensagem += `\nContinue assim! 🎉`;

        // Mesmo caminho de envio usado pelo disparo de Automação (direto,
        // sem o delay/digitando/pausa-por-humano do fluxo conversacional do
        // robô — isso é uma notificação de sistema, não uma resposta a algo
        // que o aluno perguntou).
        const sentMsg = await client.sendMessage(chatId, mensagem);
        await registrarMensagemEnviada(lead.telefone, mensagem, nomeExibir, sentMsg?.id?._serialized);

        res.json({ success: true });
    } catch (err) {
        console.error('Erro no webhook do Gympulse:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/ia/exemplos/contagem', async (req, res) => {
    const row = await db.get('SELECT COUNT(*) AS total FROM ia_exemplos_consultoras');
    res.json({ total: row.total });
});

// Varredura única do histórico de conversas.out(manual=1) que ainda não foi
// indexado (via origem_conversa_id) — sem isso o recurso começa vazio e não
// ajuda em nada até acumular semanas de conversas novas. Roda em background,
// disparada manualmente (não automática no boot), mesmo padrão de progresso
// via socket usado pela varredura de Situação Financeira do CRM Pacto.
let iaExemplosImportacaoRunning = false;
let iaExemplosImportacaoProgress = { total: 0, processados: 0, indexados: 0, running: false };

async function importarHistoricoExemplosConsultoras() {
    try {
        const respostasManuais = await db.all(`
            SELECT id, telefone, texto, ts FROM conversas
            WHERE direcao = 'out' AND manual = 1
              AND id NOT IN (SELECT origem_conversa_id FROM ia_exemplos_consultoras WHERE origem_conversa_id IS NOT NULL)
            ORDER BY ts ASC
        `);
        iaExemplosImportacaoProgress.total = respostasManuais.length;
        io.emit('ia_exemplos_progress', iaExemplosImportacaoProgress);

        const TAMANHO_LOTE = 40; // reduz chamadas de embedding — a API aceita várias entradas por requisição
        for (let i = 0; i < respostasManuais.length; i += TAMANHO_LOTE) {
            const lote = respostasManuais.slice(i, i + TAMANHO_LOTE);
            const paresValidos = [];
            for (const r of lote) {
                iaExemplosImportacaoProgress.processados++;
                if (!r.texto || r.texto.trim().length < IA_EXEMPLO_RESPOSTA_TAMANHO_MINIMO) continue;
                const numLimpo = r.telefone.replace('@c.us', '').replace('@lid', '');
                const perguntaRow = await db.get(
                    "SELECT texto FROM conversas WHERE telefone = ? AND direcao = 'in' AND ts < ? ORDER BY ts DESC LIMIT 1",
                    [numLimpo, r.ts]
                );
                if (!perguntaRow?.texto || perguntaRow.texto.trim().length < IA_EXEMPLO_PERGUNTA_TAMANHO_MINIMO) continue;
                paresValidos.push({
                    conversaId: r.id,
                    telefone: numLimpo,
                    pergunta: redigirPII(perguntaRow.texto.trim()),
                    resposta: redigirPII(r.texto.trim()),
                });
            }
            if (paresValidos.length > 0) {
                const embeddings = await gerarEmbeddingsEmLote(paresValidos.map(p => p.pergunta));
                for (let j = 0; j < paresValidos.length; j++) {
                    if (!embeddings[j]) continue;
                    const p = paresValidos[j];
                    try {
                        await db.run(
                            'INSERT OR IGNORE INTO ia_exemplos_consultoras (telefone, pergunta_cliente, resposta_consultora, embedding, origem_conversa_id) VALUES (?, ?, ?, ?, ?)',
                            [p.telefone, p.pergunta, p.resposta, JSON.stringify(embeddings[j]), p.conversaId]
                        );
                        iaExemplosImportacaoProgress.indexados++;
                    } catch (e) {
                        console.error('Erro ao gravar exemplo do backfill:', e.message);
                    }
                }
            }
            io.emit('ia_exemplos_progress', iaExemplosImportacaoProgress);
        }
    } catch (e) {
        console.error('Erro no backfill de exemplos de consultoras:', e.message);
    } finally {
        iaExemplosImportacaoRunning = false;
        iaExemplosImportacaoProgress.running = false;
        io.emit('ia_exemplos_done', iaExemplosImportacaoProgress);
    }
}

app.post('/api/ia/exemplos/importar-historico', async (req, res) => {
    if (iaExemplosImportacaoRunning) return res.status(400).json({ error: 'Já tem uma importação em andamento.' });
    const row = await db.get("SELECT valor FROM configuracoes WHERE chave = 'ia_embeddings_api_key'");
    if (!row?.valor) return res.status(400).json({ error: 'Configure a chave da OpenAI pra embeddings (campo dedicado, abaixo de "Aprender com Consultoras") antes de importar.' });
    iaExemplosImportacaoRunning = true;
    iaExemplosImportacaoProgress = { total: 0, processados: 0, indexados: 0, running: true };
    res.json({ success: true });
    importarHistoricoExemplosConsultoras();
});

app.get('/api/ia/exemplos/status', (req, res) => res.json(iaExemplosImportacaoProgress));

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
        fallback_ativo: config.horario_fallback_ativo === 'true',
        fallback_segundos: config.horario_fallback_segundos ? Number(config.horario_fallback_segundos) : 180,
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
    const { ativo, modo_padrao, mensagem_humano, fallback_ativo, fallback_segundos, faixas } = req.body;
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['horario_ativo', ativo ? 'true' : 'false']);
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['horario_modo_padrao', modo_padrao === 'humano' ? 'humano' : 'robo']);
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['horario_mensagem_humano', mensagem_humano || '']);
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['horario_fallback_ativo', fallback_ativo ? 'true' : 'false']);
    const segundosNum = parseInt(fallback_segundos, 10);
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['horario_fallback_segundos', String(segundosNum > 0 ? segundosNum : 180)]);

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

// Estatísticas agregadas pro Painel de Controle: mensagens, atendimento,
// contatos e automações num período (7/30/90 dias). Período capado em 90 pra
// não pesar a subquery correlacionada de tempo médio de resposta.
app.get('/api/estatisticas', async (req, res) => {
    const dias = Math.min(parseInt(req.query.dias) || 30, 90);
    try {
        const desdeMoment = moment.tz('America/Sao_Paulo').subtract(dias - 1, 'days').startOf('day');
        const desdeSql = desdeMoment.utc().format('YYYY-MM-DD HH:mm:ss');

        // ---- Mensagens ----
        const totaisMsg = await db.get(`
            SELECT
                SUM(CASE WHEN direcao='in' THEN 1 ELSE 0 END) AS recebidas,
                SUM(CASE WHEN direcao='out' AND manual=1 THEN 1 ELSE 0 END) AS manuais,
                SUM(CASE WHEN direcao='out' AND manual=0 THEN 1 ELSE 0 END) AS automaticas
            FROM conversas WHERE ts >= ?
        `, desdeSql);

        const naoRespondidas = await db.get(`
            SELECT COUNT(*) AS n FROM (
                SELECT telefone,
                    MAX(CASE WHEN direcao='in' THEN ts END) AS ult_in,
                    MAX(CASE WHEN direcao='out' THEN ts END) AS ult_out
                FROM conversas WHERE ts >= ?
                GROUP BY telefone
            ) WHERE ult_in IS NOT NULL AND (ult_out IS NULL OR ult_out < ult_in)
        `, desdeSql);

        // Um ponto por dia — mesmo padrão de /api/leads/por-dia: agrupa em JS
        // convertendo UTC → America/Sao_Paulo, pra não errar o dia por fuso.
        const msgRows = await db.all('SELECT direcao, ts FROM conversas WHERE ts >= ?', desdeSql);
        const porDiaMap = new Map();
        msgRows.forEach(r => {
            const dia = moment.utc(r.ts).tz('America/Sao_Paulo').format('YYYY-MM-DD');
            if (!porDiaMap.has(dia)) porDiaMap.set(dia, { recebidas: 0, enviadas: 0 });
            const b = porDiaMap.get(dia);
            if (r.direcao === 'in') b.recebidas++;
            else if (r.direcao === 'out') b.enviadas++;
        });
        const porDia = [];
        for (let i = dias - 1; i >= 0; i--) {
            const m = moment.tz('America/Sao_Paulo').subtract(i, 'days');
            const chave = m.format('YYYY-MM-DD');
            const b = porDiaMap.get(chave) || { recebidas: 0, enviadas: 0 };
            porDia.push({ data: chave, diaMes: m.format('DD'), recebidas: b.recebidas, enviadas: b.enviadas });
        }

        // ---- Atendimento ----
        const porStatusRaw = await db.all(`
            SELECT COALESCE(cs.status, 'aberta') AS status, COUNT(*) AS n
            FROM (SELECT DISTINCT telefone FROM conversas) c
            LEFT JOIN conversas_status cs ON cs.telefone = c.telefone
            GROUP BY COALESCE(cs.status, 'aberta')
        `);
        const aguardandoHumano = await db.get('SELECT COUNT(*) AS n FROM conversas_humano');

        // Tempo médio de resposta: primeira mensagem "out" depois de cada "in"
        // dentro do período. idx_conversas_tel(telefone, ts) cobre a subquery.
        const tempoResp = await db.get(`
            SELECT AVG(diff) AS segundos FROM (
                SELECT (julianday(m2.ts) - julianday(m1.ts)) * 86400 AS diff
                FROM conversas m1
                JOIN conversas m2 ON m2.telefone = m1.telefone AND m2.direcao = 'out'
                    AND m2.ts = (
                        SELECT MIN(ts) FROM conversas x
                        WHERE x.telefone = m1.telefone AND x.direcao = 'out' AND x.ts > m1.ts
                    )
                WHERE m1.direcao = 'in' AND m1.ts >= ?
            ) WHERE diff BETWEEN 0 AND 86400
        `, desdeSql);

        // ---- Contatos ----
        const totalContatos = await db.get('SELECT COUNT(*) AS n FROM leads');
        const novosContatos = await db.get('SELECT COUNT(*) AS n FROM leads WHERE data_captura >= ?', desdeSql);
        const inativos = await db.get(`
            SELECT COUNT(*) AS n FROM leads l
            WHERE NOT EXISTS (
                SELECT 1 FROM conversas c WHERE c.telefone = l.telefone AND c.ts >= datetime('now', '-30 days')
            )
        `);
        const porEtiqueta = await db.all(`
            SELECT e.nome, e.cor, COUNT(ce.telefone) AS total
            FROM etiquetas e
            LEFT JOIN contato_etiquetas ce ON ce.etiqueta_id = e.id
            GROUP BY e.id
            ORDER BY total DESC
        `);

        // ---- Automação (mesmos campos de /api/automacoes) ----
        const fluxos = await db.all(`
            SELECT a.nome, a.ativo, e.nome AS etiqueta_nome, e.cor AS etiqueta_cor,
                   a.total_concluidos AS concluidos_total,
                   (SELECT COUNT(*) FROM contato_automacao_estado WHERE automacao_id = a.id) AS em_andamento
            FROM automacoes a
            LEFT JOIN etiquetas e ON e.id = a.etiqueta_id
            ORDER BY em_andamento DESC, a.criado_em DESC
        `);

        // ---- IA: uso e custo estimado (custoEstimadoIA/PRECO_POR_1K_TOKENS) ----
        const usoIaRows = await db.all('SELECT provedor, modelo, prompt_tokens, completion_tokens FROM ia_uso_log WHERE ts >= ?', desdeSql);
        let iaChamadas = 0, iaTokensTotais = 0, iaCustoTotal = 0;
        const porModeloMap = new Map();
        usoIaRows.forEach(r => {
            iaChamadas++;
            iaTokensTotais += (r.prompt_tokens || 0) + (r.completion_tokens || 0);
            const custo = custoEstimadoIA(r.provedor, r.modelo, r.prompt_tokens || 0, r.completion_tokens || 0);
            iaCustoTotal += custo;
            const chave = `${r.provedor}::${r.modelo}`;
            if (!porModeloMap.has(chave)) porModeloMap.set(chave, { provedor: r.provedor, modelo: r.modelo, chamadas: 0, custo_estimado_usd: 0 });
            const m = porModeloMap.get(chave);
            m.chamadas++;
            m.custo_estimado_usd += custo;
        });
        const iaPorModelo = [...porModeloMap.values()].map(m => ({ ...m, custo_estimado_usd: Math.round(m.custo_estimado_usd * 10000) / 10000 }));

        // ---- Conexão: desconexões/crashes no período + última desconexão ----
        const conexaoContagem = await db.all(`
            SELECT tipo, COUNT(*) AS n FROM conexao_eventos_log
            WHERE ts >= ? AND tipo IN ('desconectado', 'crash')
            GROUP BY tipo
        `, desdeSql);
        const ultimaDesconexao = await db.get(`
            SELECT tipo, motivo, ts FROM conexao_eventos_log
            WHERE tipo IN ('desconectado', 'crash') ORDER BY ts DESC LIMIT 1
        `);

        // ---- Disparos: entrega/falha com motivo ----
        const totaisDisparo = await db.get(`
            SELECT
                SUM(CASE WHEN sucesso = 1 THEN 1 ELSE 0 END) AS enviados,
                SUM(CASE WHEN sucesso = 0 THEN 1 ELSE 0 END) AS falhas
            FROM disparo_envios_log WHERE enviado_em >= ?
        `, desdeSql);
        const principaisErrosDisparo = await db.all(`
            SELECT erro, COUNT(*) AS n FROM disparo_envios_log
            WHERE sucesso = 0 AND enviado_em >= ? AND erro IS NOT NULL
            GROUP BY erro ORDER BY n DESC LIMIT 5
        `, desdeSql);

        res.json({
            periodo_dias: dias,
            mensagens: {
                recebidas: totaisMsg.recebidas || 0,
                enviadas: (totaisMsg.manuais || 0) + (totaisMsg.automaticas || 0),
                respostas_automaticas: totaisMsg.automaticas || 0,
                respostas_manuais: totaisMsg.manuais || 0,
                nao_respondidas: naoRespondidas.n || 0,
                por_dia: porDia,
            },
            atendimento: {
                por_status: porStatusRaw.map(r => ({ status: r.status, total: r.n })),
                aguardando_humano: aguardandoHumano.n || 0,
                tempo_medio_resposta_min: tempoResp.segundos ? Math.round(tempoResp.segundos / 60) : 0,
            },
            contatos: {
                total: totalContatos.n || 0,
                novos_periodo: novosContatos.n || 0,
                inativos_30d: inativos.n || 0,
                por_etiqueta: porEtiqueta,
            },
            automacao: { fluxos },
            ia: {
                chamadas: iaChamadas,
                tokens_totais: iaTokensTotais,
                custo_estimado_usd: Math.round(iaCustoTotal * 10000) / 10000,
                por_modelo: iaPorModelo,
            },
            conexao: {
                desconexoes_periodo: conexaoContagem.find(c => c.tipo === 'desconectado')?.n || 0,
                crashes_periodo: conexaoContagem.find(c => c.tipo === 'crash')?.n || 0,
                ultima_desconexao: ultimaDesconexao ? { tipo: ultimaDesconexao.tipo, motivo: ultimaDesconexao.motivo, ts: sqliteTsParaIso(ultimaDesconexao.ts) } : null,
            },
            disparos: {
                enviados_periodo: totaisDisparo.enviados || 0,
                falhas_periodo: totaisDisparo.falhas || 0,
                taxa_entrega_pct: (totaisDisparo.enviados || totaisDisparo.falhas)
                    ? Math.round(((totaisDisparo.enviados || 0) / ((totaisDisparo.enviados || 0) + (totaisDisparo.falhas || 0))) * 100)
                    : 100,
                principais_erros: principaisErrosDisparo.map(e => ({ erro: e.erro, n: e.n })),
            },
        });
    } catch (err) {
        console.error('Erro ao calcular estatísticas:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Export Leads como CSV
app.get('/api/leads/export', async (req, res) => {
    const leads = await db.all('SELECT telefone, data_captura, mensagens_recebidas FROM leads ORDER BY data_captura DESC');
    const csv = ['Telefone,Data de Captura,Mensagens Recebidas',
        ...leads.map(l => `${l.telefone.replace('@c.us', '').replace('@lid', '')},${l.data_captura},${l.mensagens_recebidas}`)
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
// Roda a mesclagem de leads duplicados sob demanda (ver mesclarLeadsDuplicados)
// — não depende de esperar o processo reiniciar num deploy novo.
app.post('/api/admin/mesclar-leads-duplicados', async (req, res) => {
    try {
        const relatorio = await mesclarLeadsDuplicados();
        res.json({ success: true, gruposMesclados: relatorio.length, detalhe: relatorio });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reconsulta a Pacto por matrícula pra preencher data_nascimento de quem já
// foi importado sem ela (ex: import antigo que rodou antes da API devolver
// esse campo, ou matrículas que vieram sem telefone/data na 1ª tentativa).
// Só ATUALIZA quem está com data_nascimento NULL — nunca sobrescreve uma
// data já preenchida (manual ou de import anterior). Se o corpo não trouxer
// "matriculas", varre sozinho todo mundo com matrícula mas sem data.
app.post('/api/admin/preencher-datas-nascimento', async (req, res) => {
    try {
        let matriculas = Array.isArray(req.body?.matriculas) ? req.body.matriculas : null;
        if (!matriculas) {
            const linhas = await db.all("SELECT matricula FROM leads WHERE matricula IS NOT NULL AND TRIM(matricula) != '' AND data_nascimento IS NULL");
            matriculas = linhas.map(l => l.matricula);
        }

        const resultado = { total: matriculas.length, atualizados: 0, sem_data_na_pacto: 0, nao_encontrados: 0, erros: [] };
        const CONCORRENCIA = 5;

        async function processar(matriculaBruta) {
            const matricula = String(matriculaBruta).trim().padStart(6, '0');
            try {
                const aluno = await buscarAlunoPorMatricula(matricula);
                if (!aluno) { resultado.nao_encontrados++; return; }
                const dataNascimento = aluno.pessoa?.datanasc ? String(aluno.pessoa.datanasc).slice(0, 10) : null;
                if (!dataNascimento) { resultado.sem_data_na_pacto++; return; }
                // Mesma comparação dual (texto exato OU valor numérico) usada em
                // Importar Lista de Transmissão — cobre "4844" batendo com
                // "004844" salvo com zeros à esquerda.
                const r = await db.run(
                    `UPDATE leads SET data_nascimento = ?
                     WHERE data_nascimento IS NULL AND matricula IS NOT NULL AND TRIM(matricula) != '' AND (
                        TRIM(matricula) = ? OR CAST(matricula AS INTEGER) = CAST(? AS INTEGER)
                     )`,
                    [dataNascimento, String(matriculaBruta).trim(), String(matriculaBruta).trim()]
                );
                if (r.changes > 0) resultado.atualizados++;
            } catch (e) {
                resultado.erros.push({ matricula: matriculaBruta, erro: e.message });
            }
        }

        let indice = 0;
        while (indice < matriculas.length) {
            const lote = matriculas.slice(indice, indice + CONCORRENCIA);
            await Promise.all(lote.map(processar));
            indice += lote.length;
        }
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

// =====================================
// API REST — RELATÓRIO (erros de WhatsApp + cadastro incompleto)
// =====================================
// Une as duas fontes de erro de envio que já existem no sistema — automação
// (automacao_envios_erros_log, log permanente — NUNCA ler de
// contato_automacao_estado.ultimo_erro aqui, esse campo é apagado assim que o
// contato sai da fila e faria o relatório zerar sozinho) e disparo em massa
// (disparo_envios_log) — numa lista só, com quem tem o erro mais recente.
// "Corrigido" (relatorio_dispensados) só esconde da lista, não mexe no
// histórico real; se o MESMO contato falhar de novo depois de já ter sido
// marcado corrigido, ele reaparece (compara o timestamp da dispensa com o do
// erro mais recente).
app.get('/api/relatorio/erros-whatsapp', async (req, res) => {
    try {
        const errosAutomacao = await db.all(`
            SELECT telefone, erro, ocorrido_em
            FROM automacao_envios_erros_log
        `);
        const errosDisparo = await db.all(`
            SELECT telefone, erro, enviado_em AS ocorrido_em
            FROM disparo_envios_log WHERE sucesso = 0
        `);

        // Uma linha por telefone — fica só com a ocorrência mais recente entre
        // as duas fontes (comparação lexicográfica funciona porque as duas
        // colunas de origem são DATETIME no mesmo formato 'YYYY-MM-DD HH:MM:SS').
        const porTelefone = new Map();
        [...errosAutomacao, ...errosDisparo].forEach(e => {
            if (!e.telefone) return;
            const telefoneLimpo = e.telefone.replace('@c.us', '').replace('@lid', '');
            const ocorridoEm = e.ocorrido_em || '';
            const atual = porTelefone.get(telefoneLimpo);
            if (!atual || ocorridoEm > atual.ocorrido_em) {
                porTelefone.set(telefoneLimpo, { telefone: telefoneLimpo, erro: e.erro, ocorrido_em: ocorridoEm });
            }
        });

        const nomes = await db.all(`
            SELECT c.telefone, c.nome FROM conversas c
            INNER JOIN (SELECT telefone, MAX(ts) AS max_ts FROM conversas GROUP BY telefone) latest
                ON c.telefone = latest.telefone AND c.ts = latest.max_ts
        `);
        const nomePorTelefone = new Map(nomes.map(n => [n.telefone, n.nome]));
        const leadsRows = await db.all('SELECT telefone, nome, matricula FROM leads');
        const leadPorTelefone = new Map(leadsRows.map(l => [l.telefone.replace('@c.us', '').replace('@lid', ''), l]));
        const vinculos = await db.all('SELECT telefone, matricula FROM vinculo_pacto WHERE matricula IS NOT NULL');
        function matriculaDoTelefone(telefoneLimpo) {
            const v = vinculos.find(v => v.telefone.includes(telefoneLimpo) || telefoneLimpo.includes(v.telefone));
            return v?.matricula || null;
        }

        // Dois checkboxes independentes ("Corrigido BotPro" e "Corrigido Pacto")
        // — só sai da lista quando os DOIS estiverem marcados. Cada um só conta
        // como válido se for mais recente que o erro (mesma regra de sempre: um
        // erro novo depois de marcado derruba a validade da marcação antiga).
        const dispensados = await db.all("SELECT telefone, motivo, dispensado_em FROM relatorio_dispensados WHERE tipo = 'erro_whatsapp'");
        const dispensadosPorTelefone = new Map();
        dispensados.forEach(d => {
            if (!dispensadosPorTelefone.has(d.telefone)) dispensadosPorTelefone.set(d.telefone, {});
            dispensadosPorTelefone.get(d.telefone)[d.motivo] = d.dispensado_em;
        });

        const resultado = [...porTelefone.values()]
            .map(e => {
                const dispensas = dispensadosPorTelefone.get(e.telefone) || {};
                const corrigidoBotpro = !!dispensas.botpro && dispensas.botpro >= e.ocorrido_em;
                const corrigidoPacto = !!dispensas.pacto && dispensas.pacto >= e.ocorrido_em;
                const lead = leadPorTelefone.get(e.telefone);
                return {
                    telefone: e.telefone,
                    nome: lead?.nome || nomePorTelefone.get(e.telefone) || e.telefone,
                    matricula: lead?.matricula || matriculaDoTelefone(e.telefone),
                    erro: e.erro,
                    ocorrido_em: sqliteTsParaIso(e.ocorrido_em),
                    corrigido_botpro: corrigidoBotpro,
                    corrigido_pacto: corrigidoPacto,
                };
            })
            .filter(c => !(c.corrigido_botpro && c.corrigido_pacto))
            .sort((a, b) => (b.ocorrido_em || '').localeCompare(a.ocorrido_em || ''));
        res.json(resultado);
    } catch (err) {
        console.error('Erro /api/relatorio/erros-whatsapp:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Contatos sem matrícula OU sem data de nascimento (falta qualquer uma das
// duas já entra na lista) — mesma resolução de matrícula usada em
// /api/contatos (prioriza leads.matricula, cai pro vínculo Pacto).
app.get('/api/relatorio/sem-cadastro', async (req, res) => {
    try {
        const leads = await db.all('SELECT telefone, nome, matricula, data_nascimento FROM leads');
        const nomes = await db.all(`
            SELECT c.telefone, c.nome FROM conversas c
            INNER JOIN (SELECT telefone, MAX(ts) AS max_ts FROM conversas GROUP BY telefone) latest
                ON c.telefone = latest.telefone AND c.ts = latest.max_ts
        `);
        const nomePorTelefone = new Map(nomes.map(n => [n.telefone, n.nome]));
        const vinculos = await db.all('SELECT telefone, matricula FROM vinculo_pacto WHERE matricula IS NOT NULL');
        function matriculaDoTelefone(telefoneLimpo) {
            const v = vinculos.find(v => v.telefone.includes(telefoneLimpo) || telefoneLimpo.includes(v.telefone));
            return v?.matricula || null;
        }
        // Aqui os dois checkboxes ("Corrigido" e "Não é aluno") são alternativos —
        // marcar QUALQUER um dos dois já tira da lista (não precisa dos dois).
        const dispensados = await db.all("SELECT telefone FROM relatorio_dispensados WHERE tipo = 'sem_cadastro'");
        const dispensadosSet = new Set(dispensados.map(d => d.telefone));

        const resultado = leads
            .map(l => {
                const telefone = l.telefone.replace('@c.us', '').replace('@lid', '');
                const matricula = l.matricula || matriculaDoTelefone(telefone);
                return {
                    telefone,
                    nome: l.nome || nomePorTelefone.get(telefone) || telefone,
                    falta_matricula: !matricula,
                    falta_nascimento: !l.data_nascimento,
                };
            })
            .filter(c => (c.falta_matricula || c.falta_nascimento) && !dispensadosSet.has(c.telefone));
        res.json(resultado);
    } catch (err) {
        console.error('Erro /api/relatorio/sem-cadastro:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Motivos válidos por tipo de relatório — Erros de WhatsApp precisa dos DOIS
// marcados (botpro + pacto) pra sair da lista; Sem Cadastro sai com QUALQUER
// um dos dois (corrigido OU não é aluno). `checked: false` desmarca (apaga a
// dispensa), pro usuário poder desfazer um clique errado.
const RELATORIO_MOTIVOS_VALIDOS = {
    erro_whatsapp: ['botpro', 'pacto'],
    sem_cadastro: ['corrigido', 'nao_aluno'],
};
app.post('/api/relatorio/dispensar', async (req, res) => {
    const { tipo, telefone, motivo, checked } = req.body;
    if (!RELATORIO_MOTIVOS_VALIDOS[tipo]?.includes(motivo) || !telefone) {
        return res.status(400).json({ error: 'tipo/motivo/telefone inválidos.' });
    }
    try {
        if (checked === false) {
            await db.run('DELETE FROM relatorio_dispensados WHERE tipo = ? AND motivo = ? AND telefone = ?', [tipo, motivo, telefone]);
        } else {
            await db.run(
                `INSERT INTO relatorio_dispensados (tipo, motivo, telefone) VALUES (?, ?, ?)
                 ON CONFLICT(tipo, motivo, telefone) DO UPDATE SET dispensado_em = CURRENT_TIMESTAMP`,
                [tipo, motivo, telefone]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =====================================
// RELATÓRIO — CONTRATOS SEM ASSINAR (importado de PDF do Pacto)
// =====================================
// Cada consultora tem seu próprio relatório "Sem Assinatura de Contrato" no
// Pacto, exportado como link de PDF temporário — ela cola esse link aqui e a
// gente baixa/lê o PDF sozinho, sem precisar digitar aluno por aluno.
//
// Usa pdf-parse@1.1.1 (não a versão mais nova da lib) DE PROPÓSITO: a v2
// depende de `process.getBuiltinModule`, uma API do Node só disponível a
// partir da v22.3 — funcionou perfeito no ambiente local (Node mais novo),
// mas derrubou o processo inteiro assim que subiu no Railway (Node mais
// antigo por lá), porque o require da lib já falha na hora de carregar,
// antes mesmo de processar qualquer PDF. A v1.1.1 é a versão clássica,
// usada há anos em produção, sem essa dependência de API recente.
const CONTRATOS_CONSULTORAS_VALIDAS = ['juliana', 'isadora'];

// Só aceita baixar PDF do próprio domínio do Pacto — sem essa checagem, esse
// endpoint vira um "baixador de URL genérico" que aceitaria qualquer link
// (risco de SSRF: alguém usar esse formulário pra fazer o servidor buscar uma
// URL arbitrária, inclusive endereços internos da rede do Railway).
const CONTRATOS_PDF_HOST_PERMITIDO = /(^|\.)pactosolucoes\.com\.br$/i;
const CONTRATOS_PDF_TAMANHO_MAX = 15 * 1024 * 1024; // 15MB — relatório é só texto, sobra bastante margem

function baixarPdfDoPacto(url) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (_) { return reject(new Error('Link inválido.')); }
        if (parsed.protocol !== 'https:' || !CONTRATOS_PDF_HOST_PERMITIDO.test(parsed.hostname)) {
            return reject(new Error('Só aceito links do próprio pactosolucoes.com.br.'));
        }
        const req = https.get(parsed, { timeout: 20000 }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                return reject(new Error(`Pacto devolveu HTTP ${res.statusCode} pra esse link — confira se ele ainda não expirou.`));
            }
            const chunks = [];
            let tamanho = 0;
            res.on('data', (chunk) => {
                tamanho += chunk.length;
                if (tamanho > CONTRATOS_PDF_TAMANHO_MAX) {
                    req.destroy(new Error('Arquivo maior do que o esperado pra esse relatório.'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Demorou demais pra baixar o PDF do Pacto.')));
    });
}

// O relatório do Pacto vem no formato paisagem/rotacionado — o renderizador
// padrão do pdf-parse já devolve um item de texto por linha nesse caso
// (cada célula da tabela vira sua própria linha, na ordem de leitura), então
// dá pra reconstruir a tabela sem precisar mexer em coordenada/rotação: só
// reconhecendo os valores pelo formato (número sequencial = nova linha,
// primeiro all-digit = matrícula, o resto por padrão de conteúdo).
const CONTRATOS_CABECALHOS_TABELA = new Set(['#', 'Nome', 'Matrícula', 'Situação', 'CPF', 'Contrato', 'Plano', 'Duração', 'Telefone']);

// Remove cabeçalho/rodapé que se repete em toda página do relatório. O
// "Página X de Y" às vezes vem quebrado em duas linhas (o total de páginas cai
// numa linha própria, ex: "Página 1 de" + "4") — nesse caso a linha seguinte
// (um número curto solto) é lixo de rodapé também, não telefone/matrícula, e
// se não for removida junto gruda no fim do telefone do último contato da página.
function removerRuidoDePaginacaoPdf(linhasCru) {
    const out = [];
    for (let i = 0; i < linhasCru.length; i++) {
        const l = linhasCru[i];
        if (!l) continue;
        if (CONTRATOS_CABECALHOS_TABELA.has(l)) continue;
        if (/^Sem Assinatura De Contrato/.test(l)) continue;
        if (/^Academia /.test(l)) continue;
        if (/^Gerado dia/.test(l)) continue;
        if (/^Página \d+ de\b/i.test(l)) {
            if (i + 1 < linhasCru.length && /^\d{1,2}$/.test(linhasCru[i + 1])) i++;
            continue;
        }
        out.push(l);
    }
    return out;
}

// Telefone pode vir com vários números separados por ";" (aluno com vários
// contratos, cada um com seu telefone) e às vezes quebrado no meio pela quebra
// de linha do PDF. Só uma linha com "(" (parêntese do DDD) é sinal inequívoco
// de telefone nesse relatório — Contrato/Duração também são números soltos de
// 4-5 dígitos, então não dá pra confiar em "parece número" sozinho. Uma linha
// só de dígitos logo DEPOIS de uma linha com "(" é tratada como continuação do
// mesmo número (quebrou no meio); qualquer outra coisa encerra a sequência.
function extrairTelefoneDoBlocoContrato(linhasResto) {
    let atual = '';
    const runs = [];
    for (const linha of linhasResto) {
        if (linha.includes('(')) {
            if (atual) runs.push(atual);
            atual = linha;
        } else if (atual && /^[\d)]+$/.test(linha)) {
            atual += linha;
        } else {
            if (atual) runs.push(atual);
            atual = '';
        }
    }
    if (atual) runs.push(atual);
    for (const run of runs) {
        const candidatos = run.split(';').map(s => s.trim()).filter(Boolean);
        for (const candidato of candidatos) {
            const digitos = candidato.replace(/\D/g, '');
            // Quando o próprio relatório do Pacto exporta o número truncado
            // (acontece, é limitação da fonte, não do parser), fica sem
            // telefone em vez de inventar um número errado.
            if (digitos.length === 10 || digitos.length === 11) return digitos;
        }
    }
    return null;
}

function parsearContratosSemAssinarTexto(texto) {
    const linhas = removerRuidoDePaginacaoPdf(texto.split('\n').map(l => l.trim()));
    const contatos = [];
    let esperado = 1;
    let i = 0;
    while (i < linhas.length) {
        if (linhas[i] === String(esperado)) {
            const proximoIndice = String(esperado + 1);
            let j = i + 1;
            const bloco = [];
            while (j < linhas.length && linhas[j] !== proximoIndice) {
                bloco.push(linhas[j]);
                j++;
            }
            let k = 0;
            // Às vezes um fragmento de telefone/duração de OUTRO contrato do
            // aluno anterior (ex: "(42)999949098" ou "12" sozinho) sobra e cai
            // no início do bloco desse aluno, antes do nome de verdade — nome
            // sempre tem letra, então pula qualquer coisa sem letra ANTES de
            // começar a juntar o nome (esse lixo já não tem como ser
            // reatribuído com confiança a quem era, então só é descartado).
            while (k < bloco.length && !/[A-Za-zÀ-ÿ]/.test(bloco[k])) k++;
            const nomeLinhas = [];
            while (k < bloco.length && !/^\d{3,7}$/.test(bloco[k])) { nomeLinhas.push(bloco[k]); k++; }
            const matricula = bloco[k];
            const nome = nomeLinhas.join(' ').trim();
            if (nome && matricula) {
                const telefone = extrairTelefoneDoBlocoContrato(bloco.slice(k + 1));
                contatos.push({ nome, matricula, telefone });
            }
            esperado++;
            i = j;
        } else {
            i++;
        }
    }
    return contatos;
}

async function parsearContratosSemAssinarPdf(buffer) {
    const data = await pdfParse(buffer);
    return parsearContratosSemAssinarTexto(data.text);
}

app.post('/api/relatorio/contratos-sem-assinar/importar', async (req, res) => {
    const { consultora, url } = req.body;
    if (!CONTRATOS_CONSULTORAS_VALIDAS.includes(consultora)) return res.status(400).json({ error: 'Consultora inválida.' });
    if (!url) return res.status(400).json({ error: 'Cole o link do relatório antes de importar.' });
    try {
        const buffer = await baixarPdfDoPacto(url);
        const contatos = await parsearContratosSemAssinarPdf(buffer);
        if (contatos.length === 0) return res.status(400).json({ error: 'Não encontrei nenhum contato nesse PDF — confira se o link é do relatório certo.' });

        let semTelefone = 0;
        for (const c of contatos) {
            if (!c.telefone) semTelefone++;
            // ON CONFLICT + WHERE assinado=0: reimportar a mesma lista atualiza
            // nome/telefone de quem ainda está pendente, mas nunca "ressuscita"
            // quem já foi marcado como Assinado (a linha existe, o UPDATE só não
            // se aplica por causa do WHERE, então o assinado=1 nunca é mexido).
            await db.run(
                `INSERT INTO contratos_sem_assinar (consultora, nome, matricula, telefone) VALUES (?, ?, ?, ?)
                 ON CONFLICT(consultora, matricula) DO UPDATE SET nome = excluded.nome, telefone = excluded.telefone
                 WHERE contratos_sem_assinar.assinado = 0`,
                [consultora, c.nome, c.matricula, c.telefone]
            );
        }
        const totalAgora = await db.get('SELECT COUNT(*) AS n FROM contratos_sem_assinar WHERE consultora = ? AND assinado = 0', consultora);
        io.emit('contratos_sem_assinar_atualizados', { consultora });
        res.json({ success: true, total_no_pdf: contatos.length, sem_telefone: semTelefone, total_pendente: totalAgora.n });
    } catch (err) {
        console.error(`Erro ao importar Contratos Sem Assinar (${consultora}):`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/relatorio/contratos-sem-assinar', async (req, res) => {
    const { consultora } = req.query;
    if (!CONTRATOS_CONSULTORAS_VALIDAS.includes(consultora)) return res.status(400).json({ error: 'Consultora inválida.' });
    try {
        const lista = await db.all(
            'SELECT id, nome, matricula, telefone FROM contratos_sem_assinar WHERE consultora = ? AND assinado = 0 ORDER BY nome ASC',
            consultora
        );
        res.json(lista);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/relatorio/contratos-sem-assinar/:id/assinado', async (req, res) => {
    try {
        await db.run('UPDATE contratos_sem_assinar SET assinado = 1, assinado_em = CURRENT_TIMESTAMP WHERE id = ?', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Tira um contato da lista SEM marcar como assinado — pro caso de o parser ter
// pego alguém errado, ou de corrigir uma importação de teste sem "assinar" o
// contrato de ninguém à toa (assinado é uma afirmação de que o aluno realmente
// assinou, não um jeito de tirar da lista).
app.delete('/api/relatorio/contratos-sem-assinar/:id', async (req, res) => {
    try {
        await db.run('DELETE FROM contratos_sem_assinar WHERE id = ?', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Limpa a lista inteira de uma consultora (ex: importou uma lista de teste
// por engano) — apaga tudo dela, inclusive quem já tinha sido marcado como
// assinado, pra dar pra começar do zero com uma importação de verdade.
app.delete('/api/relatorio/contratos-sem-assinar', async (req, res) => {
    const { consultora } = req.query;
    if (!CONTRATOS_CONSULTORAS_VALIDAS.includes(consultora)) return res.status(400).json({ error: 'Consultora inválida.' });
    try {
        const resultado = await db.run('DELETE FROM contratos_sem_assinar WHERE consultora = ?', consultora);
        io.emit('contratos_sem_assinar_atualizados', { consultora });
        res.json({ success: true, removidos: resultado.changes });
    } catch (err) {
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
// pra Disparos e Automação.
app.post('/api/contatos', async (req, res) => {
    const { nome, telefone, matricula, data_nascimento, etiqueta_id } = req.body;
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
            'INSERT INTO leads (telefone, nome, origem, matricula, data_nascimento) VALUES (?, ?, ?, ?, ?)',
            [telefoneNormalizado, nome.trim(), 'manual', (matricula || '').toString().trim() || null, (data_nascimento || '').trim() || null]
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

// Resolve uma lista de matrículas OU nomes pro telefone correspondente —
// alimenta o "Importar Lista de Transmissão" dos Disparos (usuário cola uma
// lista de matrícula/nome, sem precisar saber o telefone de cada um).
// Nunca adivinha: nome duplicado (2+ contatos com o mesmo nome) volta como
// "ambíguo" em vez de escolher um dos dois à toa — mandar mensagem pra pessoa
// errada é pior que pedir pra resolver na mão.
app.post('/api/contatos/resolver-lista', async (req, res) => {
    const { tipo, valores } = req.body;
    if (tipo !== 'matricula' && tipo !== 'nome') return res.status(400).json({ error: 'Tipo inválido — use "matricula" ou "nome".' });
    if (!Array.isArray(valores) || valores.length === 0) return res.status(400).json({ error: 'Lista vazia.' });

    const encontrados = [];
    const naoEncontrados = [];
    const ambiguos = [];
    const jaVistos = new Set(); // evita duplicar se a mesma matrícula/nome aparecer 2x na lista colada

    try {
        for (const valorBruto of valores) {
            const valor = String(valorBruto || '').trim();
            if (!valor || jaVistos.has(valor.toLowerCase())) continue;
            jaVistos.add(valor.toLowerCase());

            let linhas;
            if (tipo === 'matricula') {
                // Compara tanto o texto exato quanto o valor numérico (cobre
                // "4284" batendo com "004284" salvo com zeros à esquerda).
                linhas = await db.all(
                    `SELECT telefone, nome, matricula FROM leads
                     WHERE matricula IS NOT NULL AND TRIM(matricula) != '' AND (
                        TRIM(matricula) = ?
                        OR CAST(matricula AS INTEGER) = CAST(? AS INTEGER)
                     )`,
                    [valor, valor]
                );
            } else {
                linhas = await db.all(
                    `SELECT telefone, nome, matricula FROM leads WHERE LOWER(TRIM(nome)) = LOWER(?)`,
                    valor
                );
            }
            const unicos = [...new Map(linhas.map(l => [l.telefone, l])).values()];
            if (unicos.length === 0) naoEncontrados.push(valor);
            else if (unicos.length === 1) encontrados.push({ valor, telefone: unicos[0].telefone, nome: unicos[0].nome, matricula: unicos[0].matricula });
            else ambiguos.push({ valor, opcoes: unicos.map(u => ({ telefone: u.telefone, nome: u.nome, matricula: u.matricula })) });
        }
        res.json({ encontrados, nao_encontrados: naoEncontrados, ambiguos });
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

// relatorio_dispensados tem UNIQUE de 3 colunas (tipo, motivo, telefone) —
// mesmo caso especial de mensagem_personalizada_enviada acima.
async function moverRelatorioDispensado(de, para) {
    const linhas = await db.all('SELECT tipo, motivo FROM relatorio_dispensados WHERE telefone = ?', de);
    for (const { tipo, motivo } of linhas) {
        const jaExiste = await db.get(
            'SELECT 1 FROM relatorio_dispensados WHERE telefone = ? AND tipo = ? AND motivo = ?',
            [para, tipo, motivo]
        );
        if (jaExiste) {
            await db.run('DELETE FROM relatorio_dispensados WHERE telefone = ? AND tipo = ? AND motivo = ?', [de, tipo, motivo]);
        } else {
            await db.run('UPDATE relatorio_dispensados SET telefone = ? WHERE telefone = ? AND tipo = ? AND motivo = ?', [para, de, tipo, motivo]);
        }
    }
}

// Move TODAS as tabelas relacionadas (exceto leads) de um telefone pra outro
// — usado tanto na mesclagem de duplicados quanto na edição manual de
// telefone (editar contato). NUNCA mexe em leads: cada chamador decide se é
// rename simples (UPDATE) ou mesclagem de verdade (combinar 2 leads).
async function moverTodasTabelasDoTelefone(de, canonico) {
    await moverLinhaSimples('conversas', de, canonico);
    await moverLinhaSimples('mensagens_enviadas', de, canonico);
    await moverLinhaSimples('automacao_envios_log', de, canonico);
    await moverLinhaSimples('automacao_envios_erros_log', de, canonico);
    await moverLinhaSimples('agenda_avaliacoes_hoje', de, canonico);
    await moverLinhaSimples('ia_uso_log', de, canonico);
    await moverLinhaSimples('disparo_envios_log', de, canonico);
    await moverLinhaSimples('ia_exemplos_consultoras', de, canonico);
    await moverLinhaPkTelefone('vinculo_pacto', de, canonico);
    await moverLinhaPkTelefone('conversas_humano', de, canonico);
    await moverLinhaPkTelefone('conversas_status', de, canonico);
    await moverLinhaPkTelefone('pacto_inadimplentes', de, canonico);
    await moverLinhaPkTelefone('pacto_vencem_hoje', de, canonico);
    await moverLinhasChaveComposta('contato_etiquetas', 'etiqueta_id', de, canonico);
    await moverLinhasChaveComposta('contato_automacao_estado', 'automacao_id', de, canonico);
    await moverRelatorioDispensado(de, canonico);
    await moverMensagemPersonalizadaEnviada(de, canonico);
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
        await moverTodasTabelasDoTelefone(de, canonico);
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
        // Também processa grupo de 1 lead só cujo telefone não bate com o
        // canônico — não é uma "duplicata" (nada pra mesclar), mas ainda tem
        // formato errado (ex: falta o 9º dígito) e precisa corrigir sozinho.
        // Sem isso, contato SEM duplicata nenhuma jamais tinha o telefone
        // corrigido — só quem tinha 2+ registros conflitantes era tratado.
        const gruposDuplicados = [...grupos.entries()].filter(([canonico, ls]) => ls.length > 1 || ls[0].telefone !== canonico);

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

// Edita um contato na Audiência (usado pela modal de edição). leads.telefone
// vem de fontes diferentes com formatos diferentes: mensagens do WhatsApp
// gravam com sufixo (@c.us/@lid), importação por planilha grava limpo — por
// isso o WHERE tenta todos os formatos, não só o número limpo que o front manda.
//
// Editar o telefone é mais que um UPDATE: ele é chave primária de leads e
// aparece em outras 17 tabelas (conversas, etiquetas, fila de automação
// etc) — reaproveita moverTodasTabelasDoTelefone (mesma lógica usada na
// mesclagem de duplicados) pra mover tudo antes de trocar a chave. Se o
// número novo já pertence a OUTRO contato, não mescla silenciosamente (typo
// aqui juntaria duas pessoas de verdade) — pede pra usar a mesclagem de
// duplicados de propósito.
app.put('/api/contatos/:telefone', async (req, res) => {
    const { telefone } = req.params;
    const { nome, matricula, data_nascimento, telefone: telefoneNovoBruto } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
    try {
        const atual = await db.get(
            'SELECT telefone FROM leads WHERE telefone = ? OR telefone = ? OR telefone = ?',
            [telefone, `${telefone}@c.us`, `${telefone}@lid`]
        );
        if (!atual) return res.status(404).json({ error: 'Contato não encontrado.' });

        let telefoneFinal = atual.telefone;
        if (telefoneNovoBruto !== undefined && telefoneNovoBruto !== null && telefoneNovoBruto !== '') {
            const telefoneNovo = normalizarTelefoneImportado(telefoneNovoBruto);
            if (!telefoneNovo) return res.status(400).json({ error: 'Telefone inválido. Informe com DDD (ex: 46999998888).' });
            const atualLimpo = atual.telefone.replace('@c.us', '').replace('@lid', '');
            if (telefoneNovo !== atualLimpo) {
                const conflito = await db.get(
                    'SELECT 1 FROM leads WHERE telefone = ? OR telefone = ? OR telefone = ?',
                    [telefoneNovo, `${telefoneNovo}@c.us`, `${telefoneNovo}@lid`]
                );
                if (conflito) {
                    return res.status(400).json({ error: 'Já existe outro contato com esse número. Use "Mesclar Duplicados" pra unir os dois de propósito.' });
                }
                await moverTodasTabelasDoTelefone(atual.telefone, telefoneNovo);
                await db.run('UPDATE leads SET telefone = ? WHERE telefone = ?', [telefoneNovo, atual.telefone]);
                telefoneFinal = telefoneNovo;
                // leadsSet cacheia quem já é lead pra registerLead() não tentar
                // INSERT duplicado quando essa pessoa mandar mensagem de verdade
                // — sem isso, a primeira mensagem dela depois da correção
                // colidiria com a PRIMARY KEY que acabamos de criar aqui.
                leadsSet.add(telefoneNovo);
                io.emit('stats', stats);
            }
        }

        await db.run(
            'UPDATE leads SET nome = ?, matricula = ?, data_nascimento = ? WHERE telefone = ?',
            [nome.trim(), (matricula || '').trim() || null, (data_nascimento || '').trim() || null, telefoneFinal]
        );
        res.json({ success: true, telefone: telefoneFinal, nome: nome.trim(), matricula: (matricula || '').trim() || null, data_nascimento: (data_nascimento || '').trim() || null });
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

// Aplica uma etiqueta a um contato (idempotente). NÃO matricula em nenhuma
// automação sozinho — matrícula só acontece quando alguém clica "Importar
// Lista" no card da automação. Ponto único usado por toda aplicação de
// etiqueta no sistema (regras automáticas, import de planilha e aplicação
// manual).
async function aplicarEtiquetaContato(telefone, etiquetaId) {
    // normalizarTelefoneBR além de tirar @c.us/@lid — é o ponto mais usado do
    // sistema pra aplicar etiqueta; se algum chamador passar um número sem o
    // 9º dígito (import antigo, ver mesclarGrupoDeTelefones), aqui é onde
    // isso mais provavelmente criaria uma etiqueta/conversa fantasma separada
    // da conversa real do contato. Idempotente: número já certo não muda.
    const numLimpo = normalizarTelefoneBR(telefone.replace('@c.us', '').replace('@lid', ''));
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
    return { changes: jaTinha ? 0 : 1 };
}

// Remove uma etiqueta de um contato e cancela qualquer automação em andamento
// vinculada a ela — a etapa que ainda não foi cumprida não faz mais sentido.
async function removerEtiquetaContato(telefone, etiquetaId) {
    const numLimpo = normalizarTelefoneBR(telefone.replace('@c.us', '').replace('@lid', ''));
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
        SELECT e.*, ce.expira_em FROM contato_etiquetas ce
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
async function obterConfigDelayAutomacao() {
    const configRows = await db.all(
        "SELECT chave, valor FROM configuracoes WHERE chave IN ('automacao_delay_segundos', 'automacao_delay_modo', 'automacao_delay_velocidade')"
    );
    return Object.fromEntries(configRows.map(r => [r.chave, r.valor]));
}
// Um delay por chamada — no modo aleatório, sorteia de novo a cada contato
// (não reaproveita o mesmo valor). Usada tanto pro envio de verdade quanto
// pra estimativa de "horário previsto" (calcularDelayAutomacao abaixo), que
// antes usava a MÉDIA fixa da faixa pra todo mundo — dava uma lista de
// horários previstos com o mesmíssimo intervalo entre cada contato, parecendo
// "programado demais" mesmo com o modo aleatório configurado.
function calcularDelayAutomacao(configMap) {
    if (configMap.automacao_delay_modo !== 'aleatorio') return (parseInt(configMap.automacao_delay_segundos) || 5) * 1000;
    const [min, max] = FAIXAS_VELOCIDADE[configMap.automacao_delay_velocidade] || FAIXAS_VELOCIDADE.medio;
    return Math.floor(min + Math.random() * (max - min));
}
async function obterProximoDelayAutomacao() {
    return calcularDelayAutomacao(await obterConfigDelayAutomacao());
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
    const numLimpo = telefone.replace('@c.us', '').replace('@lid', '');
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
// Sinal de pausa cooperativo — dispararMensagensDaAutomacao olha isso ANTES
// de cada contato e para no meio da fila sem terminar (contato atual só, os
// que ainda não foram tentados ficam intactos na fila pra um próximo disparo).
let automacaoDisparoPausado = {};

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
        if (automacaoDisparoPausado[automacaoId]) {
            console.log(`⏸️ Disparo da automação #${automacaoId} pausado pelo usuário — parou antes de ${estado.telefone}, resto da fila intacto.`);
            break;
        }
        // "primeiro" precisa virar false ANTES de qualquer await — se o passo
        // de delay/sorteio de mensagem abaixo falhar (ver catch mais adiante),
        // o próximo contato da fila ainda precisa saber que não é mais o 1º.
        const ehPrimeiro = primeiro;
        primeiro = false;

        try {
            // O cálculo do delay e o sorteio/gravação da mensagem também entram
            // no try — antes ficavam FORA dele, e uma falha aqui (ex: erro
            // pontual de leitura no SQLite) derrubava a função inteira sem
            // exceção tratada, abandonando o resto da fila em silêncio: os
            // contatos seguintes ficavam sem mensagem sorteada E sem erro
            // registrado (foi exatamente o que aconteceu com a automação
            // Aniversariante: parou no meio, sem nenhum log do motivo).
            if (!ehPrimeiro) await delay(await obterProximoDelayAutomacao());

            let mensagemId = estado.mensagem_id;
            if (!mensagemId) {
                if (pool.length === 0) { io.emit('automacoes_atualizadas'); continue; } // nenhuma mensagem configurada nas etapas — nada pra mandar
                mensagemId = pool[Math.floor(Math.random() * pool.length)].id;
                await db.run('UPDATE contato_automacao_estado SET mensagem_id = ? WHERE telefone = ? AND automacao_id = ?', [mensagemId, estado.telefone, automacaoId]);
            }

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
                    // Canal do contato decide COMO entregar — resolverChatId/
                    // client.sendMessage são específicos do WhatsApp, então só
                    // roda esse lado pra quem é 'whatsapp' (o normal, canal
                    // default de quem já existia antes dessa coluna existir).
                    const leadRow = await db.get('SELECT canal FROM leads WHERE telefone = ?', numLimpo);
                    const canalContato = leadRow?.canal || 'whatsapp';
                    const chatId = canalContato === 'instagram' ? null : await resolverChatId(client, numLimpo);
                    const nome = await resolverNomeContato(numLimpo);
                    const primeiroNome = (nome && nome !== numLimpo) ? nome.split(' ')[0] : '';
                    const nomeCompleto = (nome && nome !== numLimpo) ? nome : '';
                    const matricula = await resolverMatriculaContato(numLimpo);
                    const inadimplente = await db.get(
                        'SELECT * FROM pacto_inadimplentes WHERE telefone = ? OR telefone = ? OR telefone = ?',
                        [numLimpo, `${numLimpo}@c.us`, `${numLimpo}@lid`]
                    );
                    // {parcelas} e {valor} também precisam preencher pra quem está na
                    // lista "Vence Hoje" (pacto_vencem_hoje) — não só inadimplente/
                    // parcela atrasada. Sem isso, uma mensagem de campanha "Vence Hoje"
                    // que usa {valor} manda o placeholder vazio (foi o bug relatado:
                    // "Sua parcela no valor de  reais vence hoje", sem o valor).
                    const venceHoje = !inadimplente ? await db.get(
                        'SELECT * FROM pacto_vencem_hoje WHERE telefone = ? OR telefone = ? OR telefone = ?',
                        [numLimpo, `${numLimpo}@c.us`, `${numLimpo}@lid`]
                    ) : null;
                    const parcelasStr = inadimplente ? String(inadimplente.qtd_parcelas_atrasadas)
                        : venceHoje ? String(venceHoje.qtd_parcelas) : '';
                    const valorStr = inadimplente ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(inadimplente.valor_total_atrasado)
                        : venceHoje ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(venceHoje.valor_total) : '';
                    // {dias_atrasados} continua só pra inadimplente/parcela atrasada —
                    // "vence hoje" não está atrasado, não faz sentido ter dias de atraso.
                    const diasAtrasadosStr = inadimplente ? String(inadimplente.dias_atraso_mais_antiga) : '';
                    const agendamentoAF = await db.get(
                        'SELECT * FROM agenda_avaliacoes_hoje WHERE telefone = ? OR telefone = ? OR telefone = ?',
                        [numLimpo, `${numLimpo}@c.us`, `${numLimpo}@lid`]
                    );
                    const horarioStr = agendamentoAF?.horario || '';
                    const professorStr = agendamentoAF?.professor || '';
                    const texto = (msg.texto || '')
                        .replace(/\{nome\}/gi, primeiroNome).replace(/\[nome\]/gi, primeiroNome)
                        .replace(/\{nome_completo\}/gi, nomeCompleto).replace(/\[nome_completo\]/gi, nomeCompleto)
                        .replace(/\{matricula\}/gi, matricula).replace(/\[matricula\]/gi, matricula)
                        .replace(/\{parcelas\}/gi, parcelasStr).replace(/\[parcelas\]/gi, parcelasStr)
                        .replace(/\{valor\}/gi, valorStr).replace(/\[valor\]/gi, valorStr)
                        .replace(/\{dias_atrasados\}/gi, diasAtrasadosStr).replace(/\[dias_atrasados\]/gi, diasAtrasadosStr)
                        .replace(/\{horario\}/gi, horarioStr).replace(/\[horario\]/gi, horarioStr)
                        .replace(/\{professor\}/gi, professorStr).replace(/\[professor\]/gi, professorStr);

                    let sucesso = false;
                    if (canalContato === 'instagram') {
                        // Mídia ainda não é suportada pro Instagram nessa 1ª versão
                        // (ver plano) — pula a mídia, manda só o texto se tiver.
                        // Falha aqui (ex: fora da janela de 24h da Meta) sobe pro
                        // catch de fora igual qualquer outro erro de envio.
                        if (msg.media_path && !texto) {
                            console.log(`ℹ️ Automação #${automacaoId}: mensagem só tem mídia (sem texto) e mídia ainda não é suportada pro Instagram — nada enviado pra ${numLimpo}.`);
                        } else if (texto) {
                            const { pageAccessToken } = await obterConfigInstagram();
                            const resultado = await enviarMensagemInstagram(numLimpo, texto, pageAccessToken);
                            await registrarMensagemEnviada(numLimpo, texto, nome, resultado?.message_id || null, false, 'text', null, 'instagram');
                            sucesso = true;
                        }
                    } else if (msg.media_path) {
                        const mediaFullPath = path.join(__dirname, 'public', msg.media_path.replace(/^\//, ''));
                        if (fs.existsSync(mediaFullPath)) {
                            const media = MessageMedia.fromFilePath(mediaFullPath);
                            const sent = await client.sendMessage(chatId, media, texto ? { caption: texto } : undefined);
                            // client.sendMessage pode devolver undefined (sem lançar erro) mesmo
                            // quando a mensagem FOI entregue de verdade — é um comportamento
                            // conhecido do whatsapp-web.js: o envio em si acontece, só a
                            // construção do objeto de retorno (wrapper local) que às vezes falha
                            // por uma corrida interna da lib. Confirmado na prática: mensagem
                            // marcada como "erro" aqui, mas o cliente recebeu normalmente. Por
                            // isso só protege a leitura de .id (evita o crash de antes,
                            // "Cannot read properties of undefined"), sem tratar como falha.
                            const tipoMedia = msg.media_tipo === 'file' ? 'document' : (msg.media_tipo || 'document');
                            await registrarMensagemEnviada(numLimpo, texto || '[mídia]', nome, sent?.id?._serialized, false, tipoMedia, msg.media_path);
                            sucesso = true;
                        } else {
                            console.error(`Disparo automação #${automacaoId}: mídia não encontrada (${msg.media_path}) pra ${numLimpo}`);
                        }
                    } else if (texto) {
                        const sent = await client.sendMessage(chatId, texto);
                        await registrarMensagemEnviada(numLimpo, texto, nome, sent?.id?._serialized);
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
                'UPDATE contato_automacao_estado SET ultimo_erro = ?, ultimo_erro_em = CURRENT_TIMESTAMP WHERE telefone = ? AND automacao_id = ?',
                [e.message, estado.telefone, automacaoId]
            );
            // Log permanente, independente da fila — contato_automacao_estado.ultimo_erro
            // é apagado assim que o contato sai da fila (reenvio deu certo, automação
            // pausada, etiqueta removida), o que fazia o Relatório de Erros zerar sozinho
            // sem ninguém marcar "Corrigido". Esse log só é limpo pelo próprio Relatório.
            await db.run(
                'INSERT INTO automacao_envios_erros_log (automacao_id, telefone, erro) VALUES (?, ?, ?)',
                [automacaoId, estado.telefone, e.message]
            );
        }
        io.emit('automacoes_atualizadas');
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
    // disparo_ativo vem do estado em memória (automacaoDisparoRodando), não do
    // banco — é o mesmo flag que /progresso usa, só que aqui pra TODAS de uma
    // vez, pra dar pra filtrar "só disparando agora" na lista sem uma chamada
    // por automação.
    automacoes.forEach(a => { a.disparo_ativo = !!automacaoDisparoRodando[a.id]; });
    res.json(automacoes);
});

// =====================================
// MENSAGENS PERSONALIZADAS — aniversário automático
// =====================================
app.get('/api/mensagens-personalizadas', async (req, res) => {
    const { categoria } = req.query;
    const mensagens = categoria
        ? await db.all('SELECT * FROM mensagens_personalizadas WHERE categoria = ? ORDER BY criado_em DESC', categoria)
        : await db.all('SELECT * FROM mensagens_personalizadas ORDER BY criado_em DESC');
    res.json(mensagens);
});

app.post('/api/mensagens-personalizadas', async (req, res) => {
    const { nome, texto, media_path, media_tipo, categoria } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
    if (!texto || !texto.trim()) return res.status(400).json({ error: 'Mensagem é obrigatória.' });
    try {
        const result = await db.run(
            'INSERT INTO mensagens_personalizadas (nome, texto, media_path, media_tipo, categoria) VALUES (?, ?, ?, ?, ?)',
            [nome.trim(), texto.trim(), media_path || null, media_tipo || null, categoria || null]
        );
        res.json({ success: true, id: result.lastID });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/mensagens-personalizadas/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, texto, media_path, media_tipo, categoria } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
    if (!texto || !texto.trim()) return res.status(400).json({ error: 'Mensagem é obrigatória.' });
    try {
        const result = await db.run(
            'UPDATE mensagens_personalizadas SET nome = ?, texto = ?, media_path = ?, media_tipo = ?, categoria = ? WHERE id = ?',
            [nome.trim(), texto.trim(), media_path || null, media_tipo || null, categoria || null, id]
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
        // Respiro entre cada contato — não muda o envio (que agora só sai via
        // "Importar Lista" + "Disparar Mensagens"), mas evita um lote grande de
        // escritas simultâneas quando várias pessoas fazem aniversário no mesmo dia.
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

// Automação aqui só organiza contatos por etiqueta — não manda mensagem
// nenhuma (isso é papel de Disparos). "Importar" sincroniza a fila com quem
// tem a etiqueta AGORA: quem perdeu a etiqueta desde a última importação sai
// da fila (não faz sentido continuar numa automação de cobrança quem já
// pagou, por exemplo), e quem ganhou a etiqueta entra. A fila vira sempre um
// espelho exato de "quem tem essa etiqueta neste momento" — nunca acumula
// gente que não devia mais estar lá.
async function importarContatosParaAutomacao(automacaoId) {
    const automacao = await db.get('SELECT * FROM automacoes WHERE id = ?', automacaoId);
    if (!automacao) return { importados: 0, removidos: 0 };
    const contatos = await db.all('SELECT telefone FROM contato_etiquetas WHERE etiqueta_id = ?', automacao.etiqueta_id);
    const telefonesAtuais = contatos.map(c => c.telefone);

    const naFila = await db.all('SELECT telefone FROM contato_automacao_estado WHERE automacao_id = ?', automacaoId);
    let removidos = 0;
    for (const f of naFila) {
        if (!telefonesAtuais.includes(f.telefone)) {
            await db.run('DELETE FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?', [f.telefone, automacaoId]);
            removidos++;
        }
    }

    // Importar Lista roda de novo várias vezes no mesmo dia (clique manual +
    // Programação de 5 em 5 min) — pra automação cuja etiqueta fica o dia
    // INTEIRO no contato (ex: Agendamento AF, que só sai quando a avaliação
    // deixa de estar na agenda de HOJE), um contato já enviado com sucesso
    // ainda "qualifica" (tem a etiqueta) e voltava pra fila sozinho a cada
    // reimportação, tomando uma segunda mensagem idêntica no mesmo dia. Antes
    // de readicionar, confere se já não foi enviado por essa automação hoje.
    const hojeInicio = moment.tz('America/Sao_Paulo').startOf('day').utc().format('YYYY-MM-DD HH:mm:ss');
    const hojeFim = moment.tz('America/Sao_Paulo').endOf('day').utc().format('YYYY-MM-DD HH:mm:ss');

    let importados = 0;
    for (const c of contatos) {
        const jaMatriculado = await db.get(
            'SELECT 1 FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?',
            [c.telefone, automacaoId]
        );
        if (jaMatriculado) continue;
        const jaEnviadoHoje = await db.get(
            'SELECT 1 FROM automacao_envios_log WHERE automacao_id = ? AND telefone = ? AND enviado_em BETWEEN ? AND ?',
            [automacaoId, c.telefone, hojeInicio, hojeFim]
        );
        if (jaEnviadoHoje) continue;
        await db.run(
            `INSERT INTO contato_automacao_estado (telefone, automacao_id, etapa_atual, entrou_em, proxima_execucao_em)
             VALUES (?, ?, 0, CURRENT_TIMESTAMP, NULL)`,
            [c.telefone, automacaoId]
        );
        importados++;
    }
    return { importados, removidos };
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

// Valida as mesmas guardas de sempre (WhatsApp conectado, automação ativa,
// dentro do horário configurado, sem outro disparo já rodando pra ela) e, se
// tudo certo, inicia o envio em background — usado tanto pelo disparo manual
// (POST /api/automacoes/:id/disparar) quanto pelo scheduler de Programação
// (checarProgramacoes). `origem` é só pro log, pra saber quem pediu.
async function dispararAutomacaoComGuardas(id, origem = 'manual') {
    if (automacaoDisparoRodando[id]) return { ok: false, error: 'Já tem um disparo rodando pra essa automação.' };
    if (!isConnected) return { ok: false, error: 'WhatsApp não está conectado.' };
    const automacao = await db.get('SELECT * FROM automacoes WHERE id = ?', id);
    if (!automacao) return { ok: false, error: 'Automação não encontrada.' };
    if (!automacao.ativo) return { ok: false, error: 'Essa automação está pausada — ative-a antes de disparar.' };
    if (!dentroDoHorarioAutomacao(automacao)) {
        return { ok: false, error: `Fora do horário configurado pra essa automação (${automacao.horario_inicio}–${automacao.horario_fim}).` };
    }
    automacaoDisparoRodando[id] = true;
    automacaoDisparoPausado[id] = false; // reseta pausa de uma rodada anterior
    console.log(`🚀 Disparo da automação #${id} (${automacao.nome}) iniciado — origem: ${origem}`);
    dispararMensagensDaAutomacao(id)
        .catch(e => console.error('Erro ao disparar automação:', e.message))
        .finally(() => { automacaoDisparoRodando[id] = false; automacaoDisparoPausado[id] = false; });
    return { ok: true };
}

// Sinal cooperativo pro disparo em andamento parar antes do próximo contato —
// não cancela o envio que já está no meio (ver dispararMensagensDaAutomacao),
// só impede de começar o próximo. Fila continua intacta pra retomar depois.
app.post('/api/automacoes/:id/pausar', async (req, res) => {
    const { id } = req.params;
    if (!automacaoDisparoRodando[id]) return res.status(400).json({ error: 'Essa automação não está disparando agora.' });
    automacaoDisparoPausado[id] = true;
    console.log(`⏸️ Pausa solicitada pra automação #${id}.`);
    res.json({ success: true });
});

// Remove UM contato específico da fila "em andamento" — não manda mensagem
// nenhuma, só tira ele da lista (ex: cliente já pagou, quer excluir só esse).
app.delete('/api/automacoes/:id/contatos/:telefone', async (req, res) => {
    const { id, telefone } = req.params;
    try {
        const result = await db.run('DELETE FROM contato_automacao_estado WHERE telefone = ? AND automacao_id = ?', [telefone, id]);
        if (result.changes === 0) return res.status(404).json({ error: 'Contato não encontrado na fila dessa automação.' });
        io.emit('automacoes_atualizadas');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Dispara de verdade os contatos "em andamento" dessa automação — cada um
// recebe a mensagem sorteada pra ele (ver dispararMensagensDaAutomacao).
// Roda em background (espaçado, pode levar minutos) — front acompanha pelo
// socket "automacoes_atualizadas", que já dispara a cada contato concluído.
app.post('/api/automacoes/:id/disparar', async (req, res) => {
    const resultado = await dispararAutomacaoComGuardas(req.params.id, 'manual');
    if (!resultado.ok) return res.status(400).json({ error: resultado.error });
    res.json({ success: true });
});

// =====================================
// API REST — PROGRAMAÇÃO (agenda dias/horário pra disparar automações sozinhas)
// =====================================
// Cada programação agrupa nome + dias da semana + horário + uma ou mais
// automações (programacao_acoes) — no horário configurado, dispara TODAS as
// automações da lista, em ordem, do mesmo jeito que o botão manual "Disparar
// Mensagens" já faz (ver dispararAutomacaoComGuardas). Não roda "Importar
// Lista" sozinha — só manda pra quem já está na fila de cada automação.
app.get('/api/programacoes', async (req, res) => {
    try {
        const programacoes = await db.all('SELECT * FROM programacoes ORDER BY criado_em DESC');
        const acoesRows = await db.all(`
            SELECT pa.programacao_id, pa.automacao_id, pa.ordem, pa.intervalo_depois_segundos, pa.tipo, pa.campanha_chave,
                   a.nome, a.ativo AS automacao_ativa, e.nome AS etiqueta_nome, e.cor AS etiqueta_cor
            FROM programacao_acoes pa
            INNER JOIN automacoes a ON a.id = pa.automacao_id
            LEFT JOIN etiquetas e ON e.id = a.etiqueta_id
            ORDER BY pa.programacao_id, pa.ordem ASC
        `);
        const resultado = programacoes.map(p => ({
            id: p.id,
            nome: p.nome,
            dias: p.dias.split(',').filter(Boolean).map(Number),
            horario: p.horario,
            ativo: !!p.ativo,
            ultima_execucao_em: p.ultima_execucao_em,
            acoes: acoesRows
                .filter(a => a.programacao_id === p.id)
                .map(a => ({
                    automacao_id: a.automacao_id, nome: a.nome, ativo: !!a.automacao_ativa,
                    etiqueta_nome: a.etiqueta_nome, etiqueta_cor: a.etiqueta_cor,
                    intervalo_depois_segundos: a.intervalo_depois_segundos ?? 60,
                    tipo: a.tipo || 'disparo', campanha_chave: a.campanha_chave || null,
                })),
        }));
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function validarPayloadProgramacao(body) {
    const { nome, dias, horario, acoes } = body;
    if (!nome || !nome.trim()) return 'Nome é obrigatório.';
    if (!Array.isArray(dias) || dias.length === 0) return 'Escolha pelo menos um dia da semana.';
    if (!horario || !/^\d{1,2}:\d{2}$/.test(horario)) return 'Horário inválido.';
    if (!Array.isArray(acoes) || acoes.length === 0) return 'Escolha pelo menos uma automação pra disparar.';
    return null;
}

app.post('/api/programacoes', async (req, res) => {
    const erro = validarPayloadProgramacao(req.body);
    if (erro) return res.status(400).json({ error: erro });
    const { nome, dias, horario, acoes, ativo } = req.body;
    try {
        const result = await db.run(
            'INSERT INTO programacoes (nome, dias, horario, ativo) VALUES (?, ?, ?, ?)',
            [nome.trim(), dias.join(','), horario, ativo === false ? 0 : 1]
        );
        const programacaoId = result.lastID;
        let ordem = 0;
        for (const acao of acoes) {
            await db.run(
                'INSERT INTO programacao_acoes (programacao_id, automacao_id, ordem, intervalo_depois_segundos, tipo, campanha_chave) VALUES (?, ?, ?, ?, ?, ?)',
                [programacaoId, acao.automacao_id, ordem++, parseInt(acao.intervalo_depois_segundos) || 60, acao.tipo === 'automacao' ? 'automacao' : 'disparo', acao.campanha_chave || null]
            );
        }
        res.json({ success: true, id: programacaoId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/programacoes/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, dias, horario, acoes, ativo } = req.body;
    // Update parcial nos campos simples — só mexe no que veio no body, mesmo
    // padrão de PUT /api/automacoes/:id (toggle de "Ativo" não deve apagar o resto).
    const sets = [];
    const params = [];
    if (nome !== undefined) { sets.push('nome = ?'); params.push(nome.trim()); }
    if (dias !== undefined) {
        if (!Array.isArray(dias) || dias.length === 0) return res.status(400).json({ error: 'Escolha pelo menos um dia da semana.' });
        sets.push('dias = ?'); params.push(dias.join(','));
    }
    if (horario !== undefined) { sets.push('horario = ?'); params.push(horario); }
    if (ativo !== undefined) { sets.push('ativo = ?'); params.push(ativo ? 1 : 0); }
    try {
        if (sets.length > 0) {
            params.push(id);
            await db.run(`UPDATE programacoes SET ${sets.join(', ')} WHERE id = ?`, params);
        }
        if (acoes !== undefined) {
            if (!Array.isArray(acoes) || acoes.length === 0) return res.status(400).json({ error: 'Escolha pelo menos uma automação pra disparar.' });
            await db.run('DELETE FROM programacao_acoes WHERE programacao_id = ?', id);
            let ordem = 0;
            for (const acao of acoes) {
                await db.run(
                    'INSERT INTO programacao_acoes (programacao_id, automacao_id, ordem, intervalo_depois_segundos, tipo, campanha_chave) VALUES (?, ?, ?, ?, ?, ?)',
                    [id, acao.automacao_id, ordem++, parseInt(acao.intervalo_depois_segundos) || 60, acao.tipo === 'automacao' ? 'automacao' : 'disparo', acao.campanha_chave || null]
                );
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/programacoes/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.run('DELETE FROM programacao_acoes WHERE programacao_id = ?', id);
        await db.run('DELETE FROM programacoes WHERE id = ?', id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
        leadsComNome.forEach(l => nomePorTelefone.set(l.telefone.replace('@c.us', '').replace('@lid', ''), l.nome));

        // Nome da mensagem já sorteada pra cada contato (sorteio é lento — só
        // acontece quando o disparo passa por ele, ver dispararMensagensDaAutomacao)
        // — quem ainda não chegou nesse ponto mostra null (front exibe "será sorteada").
        const pool = await poolMensagensDaAutomacao(id);
        const nomeMensagemPorId = new Map(pool.map(m => [m.id, m.nome]));

        // "Horário previsto" só faz sentido enquanto o disparo está rodando de
        // verdade — sem isso, a fila pode ficar parada por dias esperando alguém
        // clicar em "Disparar Mensagens", e prever um horário seria enganoso.
        const disparoAtivo = !!automacaoDisparoRodando[id];
        const configDelay = disparoAtivo ? await obterConfigDelayAutomacao() : null;
        let acumuladoMs = 0;

        // Primeiro da fila é enviado quase na hora (o disparo real só espera
        // ANTES do 2º em diante — ver "if (!primeiro) await delay(...)" em
        // dispararMensagensDaAutomacao) — daí o acúmulo começar depois do 1º.
        // Sorteia um delay NOVO a cada contato (calcularDelayAutomacao) em vez
        // de repetir uma média fixa — no modo aleatório, a lista de horários
        // previstos varia contato a contato, igual o envio de verdade vai variar.
        const contatos = estados.map((e, i) => {
            if (disparoAtivo && i > 0) acumuladoMs += calcularDelayAutomacao(configDelay);
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
        ),
        base AS (
            SELECT
                c.telefone,
                COALESCE(mn.nome, c.nome) AS nome,
                c.texto AS ultimo_texto,
                c.direcao AS ultima_direcao,
                c.tipo AS ultimo_tipo,
                c.ts AS ultimo_ts,
                (SELECT COUNT(*) FROM conversas WHERE telefone = c.telefone AND lida = 0 AND direcao = 'in') AS nao_lidas,
                (CASE WHEN ch.telefone IS NULL THEN 0 ELSE 1 END) AS assumida_humano,
                COALESCE(cs.status, 'aberta') AS status,
                COALESCE(c.canal, 'whatsapp') AS canal
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
        )
        -- O corte de 200 só vale pras conversas JÁ FECHADAS (histórico, menos
        -- urgente) — uma "Aberta" nunca pode ficar de fora, senão ela some da
        -- lista pro atendente mesmo tendo mensagem não lida de verdade (foi
        -- exatamente o bug relatado: com mais de 200 conversas no total, mais
        -- da metade sumia da tela a cada refresh/reconexão, aberta ou não).
        SELECT * FROM base WHERE status = 'aberta'
        UNION ALL
        SELECT * FROM (SELECT * FROM base WHERE status != 'aberta' ORDER BY ultimo_ts DESC LIMIT 200)
        ORDER BY ultimo_ts DESC
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

    // Matrícula pra mostrar do lado do nome na lista — mesma fonte/prioridade
    // já usada em Regras/Automação (resolverMatriculaContato, com cache).
    const comMatricula = await Promise.all(conversas.map(async c => ({
        ...c,
        matricula: await resolverMatriculaContato(c.telefone),
        etiquetas: etiquetasPorTelefone.get(c.telefone) || [],
    })));
    return comMatricula;
}

// Lista todas as conversas (uma por contato, com o último texto e count de não lidas)
app.get('/api/conversas', async (req, res) => {
    try {
        const conversas = await listarConversasComEtiquetas();
        res.json(conversas);
    } catch (err) {
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
// Essa heurística é toda baseada em FORMATO de telefone brasileiro — só faz
// sentido pra conversas do WhatsApp. Um IGSID do Instagram (número longo,
// ~15-17 dígitos) cairia sempre no "NOT GLOB" e seria marcado como fantasma
// por engano, canal inteiro incluído. Por isso o filtro por canal vem ANTES
// de tudo, não só mais uma condição no meio do OR.
const QUERY_FANTASMAS = `
    SELECT telefone, nome, texto FROM conversas c1
    WHERE id = (SELECT MAX(id) FROM conversas c2 WHERE c2.telefone = c1.telefone)
      AND (c1.canal IS NULL OR c1.canal = 'whatsapp')
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
    } catch (err) {
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
        // Mesma substituição de {nome}/{nome_completo}/{matricula}/{saudacao}
        // que já existe pra Regras/Automação — sem isso, digitar {nome} na
        // caixa de texto manual manda a chave crua pro cliente em vez do nome dele.
        const textoFinal = await substituirPlaceholdersPessoais(texto.trim(), telefone);
        const chatId = telefone.includes('@') ? telefone : await resolverChatId(client, telefone);
        const sentMsg = await client.sendMessage(chatId, textoFinal);
        const nome = await resolverNomeContato(telefone);
        await registrarMensagemEnviada(telefone, textoFinal, nome, sentMsg?.id?._serialized, true);
        res.json({ success: true });
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Envia um arquivo (imagem, documento, etc.) pelo dashboard para um contato
app.post('/api/conversas/:telefone/enviar-arquivo', upload.single('arquivo'), async (req, res) => {
    const telefone = normalizarTelefoneBR(req.params.telefone); // ver comentário na rota /enviar
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp não está conectado.' });
    try {
        const chatId = telefone.includes('@') ? telefone : await resolverChatId(client, telefone);
        const media = MessageMedia.fromFilePath(req.file.path);
        const legendaBruta = (req.body.legenda || '').trim();
        // Mesma substituição de {nome}/{matricula}/{saudacao} do envio manual de
        // texto — legenda de arquivo é digitada pelo mesmo operador do mesmo jeito.
        const legenda = legendaBruta ? await substituirPlaceholdersPessoais(legendaBruta, telefone) : legendaBruta;
        const sentMsg = await client.sendMessage(chatId, media, legenda ? { caption: legenda } : undefined);
        // Mantém o arquivo em public/uploads (não apaga mais) — é o que permite
        // reabrir a imagem/documento clicando na bolha depois.
        const mediaUrl = '/uploads/' + req.file.filename;

        const tipo = req.file.mimetype.startsWith('image/') ? 'image'
            : req.file.mimetype.startsWith('video/') ? 'video'
                : req.file.mimetype.startsWith('audio/') ? 'audio'
                    : 'document';
        const nome = await resolverNomeContato(telefone);
        const numeroLimpo = telefone.replace('@c.us', '').replace('@lid', '');
        // Chave de conteúdo usa "legenda" crua (o que msg.body de verdade vai
        // trazer no message_create, vazio se não teve legenda) — não o nome do
        // arquivo, que só é usado como texto de exibição quando falta legenda.
        marcarMensagemComoDoSistema(sentMsg?.id?._serialized, numeroLimpo, legenda);
        await salvarNaConversa(numeroLimpo, nome, 'out', legenda || req.file.originalname, tipo, null, true, mediaUrl);
        io.emit('stats', stats);
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao enviar arquivo:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// =====================================
// API REST — BROADCAST (DISPAROS EM MASSA)
// =====================================
let broadcastRunning = false;
let broadcastProgress = { total: 0, sent: 0, failed: 0, running: false };
let ultimoDisparoIniciadoEm = null; // 'YYYY-MM-DD HH:mm:ss' (mesmo formato do SQLite) — filtra /api/broadcast/falhas no disparo mais recente

app.get('/api/broadcast/status', (req, res) => res.json({ ...broadcastProgress, filaTamanho: filaDisparos.length }));

// Detalhe de falhas do disparo em massa mais recente — telefone + motivo,
// pra quem acabou de rodar um disparo entender NA HORA quem falhou e por quê,
// sem precisar caçar log de servidor. Some/reseta a cada novo disparo (filtra
// por ultimoDisparoIniciadoEm), então só mostra a campanha mais recente.
app.get('/api/broadcast/falhas', async (req, res) => {
    if (!ultimoDisparoIniciadoEm) return res.json([]);
    try {
        const falhas = await db.all(
            'SELECT telefone, erro, enviado_em FROM disparo_envios_log WHERE sucesso = 0 AND enviado_em >= ? ORDER BY enviado_em DESC LIMIT 200',
            ultimoDisparoIniciadoEm
        );
        res.json(falhas);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Lista detalhada (com nome) do disparo em massa mais recente — clicando em
// Total/Enviados/Falhas na tela. disparo_envios_log guarda só o telefone cru
// (sem DDI, como foi digitado na lista), então normaliza pro formato usado
// em Contatos (normalizarTelefoneBR) antes de casar com leads.telefone.
app.get('/api/broadcast/detalhe', async (req, res) => {
    if (!ultimoDisparoIniciadoEm) return res.json([]);
    const filtro = req.query.filtro;
    try {
        let sql = 'SELECT telefone, sucesso, erro, numero_envio, enviado_em FROM disparo_envios_log WHERE enviado_em >= ?';
        const params = [ultimoDisparoIniciadoEm];
        if (filtro === 'enviados') sql += ' AND sucesso = 1';
        else if (filtro === 'falhas') sql += ' AND sucesso = 0';
        sql += ' ORDER BY enviado_em ASC LIMIT 500';
        const linhas = await db.all(sql, params);

        const numerosNormalizados = linhas.map(l => normalizarTelefoneBR(l.telefone));
        const variantes = [...new Set(numerosNormalizados.flatMap(n => [n, `${n}@c.us`, `${n}@lid`]))];
        const contatos = variantes.length
            ? await db.all(`SELECT telefone, nome FROM leads WHERE telefone IN (${variantes.map(() => '?').join(',')})`, variantes)
            : [];
        const nomePorTelefone = new Map();
        contatos.forEach(c => nomePorTelefone.set(c.telefone.replace('@c.us', '').replace('@lid', ''), c.nome));

        res.json(linhas.map((l, i) => ({
            telefone: l.telefone,
            nome: nomePorTelefone.get(numerosNormalizados[i]) || null,
            sucesso: !!l.sucesso,
            erro: l.erro,
            numeroEnvio: l.numero_envio || null,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fila de disparos: se o usuário criar um novo disparo com um anterior ainda
// rodando, ele não é rejeitado nem roda em paralelo (mandar de duas listas
// ao mesmo tempo pelo mesmo WhatsApp aumenta risco de bloqueio) — entra
// aqui e começa sozinho assim que o disparo atual terminar.
let filaDisparos = [];

function iniciarBroadcast(job) {
    const { listaNumeros, mensagem, mediaFile, delay_ms, delay_modo, delay_velocidade } = job;

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
    ultimoDisparoIniciadoEm = moment.utc().format('YYYY-MM-DD HH:mm:ss');
    io.emit('broadcast_progress', broadcastProgress);
    io.emit('broadcast_started', broadcastProgress);

    // Executa o broadcast de forma assíncrona. Disparo nunca usa o client
    // principal — só números do pool de Disparo (ver POOL DE NÚMEROS PARA
    // DISPARO), pra tirar esse risco de banimento do número principal.
    (async () => {
        for (const numero of listaNumeros) {
            if (!broadcastRunning) break;

            const entryEnvio = proximoClienteDoPool(job.numerosPermitidosIds);
            if (!entryEnvio) {
                // Nenhum número do pool (elegível pra essa campanha) segue
                // conectado — aborta o resto da lista em vez de gastar o
                // delay inteiro só pra logar falha contato por contato.
                console.error('❌ Disparo abortado: nenhum número de disparo conectado.');
                db.run('INSERT INTO disparo_envios_log (telefone, sucesso, erro) VALUES (?, 0, ?)', [numero, 'Nenhum número de disparo conectado.']).catch(() => { });
                broadcastProgress.failed++;
                io.emit('broadcast_progress', broadcastProgress);
                broadcastRunning = false;
                break;
            }

            try {
                const numeroCompleto = numero.startsWith('55') ? numero : `55${numero}`;
                const chatId = await resolverChatId(entryEnvio.client, numeroCompleto);
                // Cada número da lista tem seu próprio nome/matrícula — substitui
                // {nome}/{matricula}/{saudacao} POR DESTINATÁRIO (mesmo texto
                // "mensagem" cru, mas personalizado a cada envio do laço).
                const textoPersonalizado = await substituirPlaceholdersPessoais(mensagem, numeroCompleto);
                await entryEnvio.client.sendMessage(chatId, textoPersonalizado);

                if (mediaFile) {
                    const media = MessageMedia.fromFilePath(mediaFile.path);
                    await entryEnvio.client.sendMessage(chatId, media);
                }

                broadcastProgress.sent++;
                db.run('INSERT INTO disparo_envios_log (telefone, sucesso, numero_envio) VALUES (?, 1, ?)', [numero, entryEnvio.nome]).catch(() => { });
            } catch (err) {
                console.error(`❌ Falha ao enviar para ${numero}:`, err.message);
                broadcastProgress.failed++;
                db.run('INSERT INTO disparo_envios_log (telefone, sucesso, erro, numero_envio) VALUES (?, 0, ?, ?)', [numero, err.message, entryEnvio.nome]).catch(() => { });
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

        // Próximo da fila (se tiver) começa sozinho, sem precisar de ação do usuário.
        if (filaDisparos.length > 0) {
            const proximo = filaDisparos.shift();
            io.emit('broadcast_fila_atualizada', { tamanho: filaDisparos.length });
            iniciarBroadcast(proximo);
        }
    })();
}

app.post('/api/broadcast/start', upload.single('media'), async (req, res) => {
    // Disparo é feito pelo pool de Números de Envio, dedicados a isso (ver
    // POOL DE NÚMEROS PARA DISPARO). TEMPORÁRIO (pedido do usuário): nesse
    // primeiro momento, enquanto o pool ainda está sendo montado, o
    // principal também libera o Disparo — ver mesmo fallback em
    // proximoClienteDoPool. Remover o "|| isConnected" assim que o pool
    // tiver números suficientes conectados.
    const algumPoolConectado = [...poolClients.values()].some(e => e.status === 'connected');
    if (!algumPoolConectado && !isConnected) {
        return res.status(400).json({ error: 'Nenhum número de disparo conectado. Conecte pelo menos um em "Números de Envio" antes de disparar.' });
    }

    const { numeros, mensagem, delay_ms, delay_modo, delay_velocidade, categoria } = req.body;
    const listaNumeros = numeros.split('\n').map(n => n.trim().replace(/\D/g, '')).filter(n => n.length >= 10);

    if (listaNumeros.length === 0) return res.status(400).json({ error: 'Nenhum número válido encontrado.' });
    if (!mensagem) return res.status(400).json({ error: 'Mensagem obrigatória.' });

    // Roteamento por campanha: se a mensagem usada tem uma categoria (ver
    // Mensagens Personalizadas) e existe uma regra configurada em
    // disparo_roteamento pra ela, restringe o rodízio a só os números
    // atribuídos (1 = exclusivo daquele número; 2+ = revezam só entre eles).
    let numerosPermitidosIds = null;
    if (categoria) {
        const regra = await db.get('SELECT numeros_ids FROM disparo_roteamento WHERE campanha_chave = ?', categoria);
        if (regra?.numeros_ids) numerosPermitidosIds = regra.numeros_ids.split(',').filter(Boolean).map(Number);
    }

    const mediaFile = req.file ? { path: req.file.path, mimetype: req.file.mimetype, filename: req.file.originalname } : null;
    const job = { listaNumeros, mensagem, mediaFile, delay_ms, delay_modo, delay_velocidade, numerosPermitidosIds };

    if (broadcastRunning) {
        filaDisparos.push(job);
        io.emit('broadcast_fila_atualizada', { tamanho: filaDisparos.length });
        return res.json({ success: true, queued: true, posicaoNaFila: filaDisparos.length, total: listaNumeros.length });
    }

    res.json({ success: true, queued: false, total: listaNumeros.length });
    iniciarBroadcast(job);
});

app.post('/api/broadcast/stop', (req, res) => {
    broadcastRunning = false;
    // "Parar" cancela tudo, não só a lista atual — sem isso, um disparo
    // enfileirado começaria sozinho logo em seguida, surpreendendo quem
    // clicou Parar justamente pra não mandar mais nada.
    const tinhaFila = filaDisparos.length > 0;
    filaDisparos = [];
    if (tinhaFila) io.emit('broadcast_fila_atualizada', { tamanho: 0 });
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

// Importação em massa Contatos ← Pacto. A API da Pacto não tem endpoint de
// listagem (só busca por matrícula exata — testado ao vivo), então varremos
// um intervalo de matrículas numéricas em paralelo (a faixa 000001–009000
// cobre com folga o intervalo real de matrículas usadas, amostrado manualmente antes de
// implementar isso). Roda em background — várias milhares de chamadas
// levariam minutos demais pra segurar a requisição HTTP do dashboard aberta.
let pactoImportRunning = false;
let pactoImportProgress = { total: 0, verificadas: 0, importados: 0, ja_existiam: 0, sem_telefone: 0, nao_encontrados: 0, running: false };
const PACTO_IMPORT_MATRICULA_MIN = 1;
const PACTO_IMPORT_MATRICULA_MAX = 9000;
const PACTO_IMPORT_CONCORRENCIA = 5;

app.get('/api/pacto/importar-contatos/status', (req, res) => res.json(pactoImportProgress));

async function processarImportacaoPactoContatos() {
    if (pactoImportRunning) return;
    const total = PACTO_IMPORT_MATRICULA_MAX - PACTO_IMPORT_MATRICULA_MIN + 1;
    pactoImportRunning = true;
    pactoImportProgress = { total, verificadas: 0, importados: 0, ja_existiam: 0, sem_telefone: 0, nao_encontrados: 0, running: true };
    io.emit('pacto_import_progress', pactoImportProgress);

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

            // UPSERT atômico (em vez do antigo "confere, depois decide INSERT
            // ou UPDATE" em dois passos separados) — fecha uma janela de
            // corrida real: se uma mensagem de WhatsApp desse mesmo aluno
            // chegasse (registerLead) bem entre o SELECT acima e um INSERT
            // separado, os dois processos inseriam ao mesmo tempo e criavam
            // DUAS linhas pro mesmo telefone — foi exatamente o que aconteceu
            // com pelo menos 3 contatos (telefone é PRIMARY KEY, mas com dois
            // INSERTs concorrentes sem essa proteção, ambos passavam). Só
            // completa data_nascimento se estiver faltando, sem tocar em
            // nome/matrícula pra não sobrescrever edição manual de quem já existia.
            await db.run(
                `INSERT INTO leads (telefone, nome, origem, matricula, data_nascimento) VALUES (?, ?, 'pacto', ?, ?)
                     ON CONFLICT(telefone) DO UPDATE SET data_nascimento = excluded.data_nascimento
                     WHERE leads.data_nascimento IS NULL AND excluded.data_nascimento IS NOT NULL`,
                [telefone, aluno.pessoa?.nome || null, aluno.matricula || matricula, dataNascimento]
            );

            if (existente) {
                pactoImportProgress.ja_existiam++;
            } else {
                leadsSet.add(telefone);
                stats.leads++;
                pactoImportProgress.importados++;
            }
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
}

app.post('/api/pacto/importar-contatos', (req, res) => {
    if (pactoImportRunning) return res.status(400).json({ error: 'Uma importação do Pacto já está em andamento.' });
    res.json({ success: true, total: PACTO_IMPORT_MATRICULA_MAX - PACTO_IMPORT_MATRICULA_MIN + 1 });
    processarImportacaoPactoContatos().catch(e => console.error('Erro ao importar contatos do Pacto:', e.message));
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

// "Parcela Atrasada" — mesma varredura de inadimplência, mas pra quem está
// com atraso mais recente (até 30 dias). Duas etiquetas separadas pra dar
// pra montar duas Automações de cobrança diferentes (tom mais brando pra
// quem venceu há pouco, mais firme pra quem já passou de 30 dias).
const NOME_ETIQUETA_PARCELA_ATRASADA = 'Parcela Atrasada';
const LIMITE_DIAS_ATRASO_LONGO = 30;
async function garantirEtiquetaParcelaAtrasada() {
    const existente = await db.get('SELECT id FROM etiquetas WHERE LOWER(nome) = LOWER(?)', NOME_ETIQUETA_PARCELA_ATRASADA);
    if (existente) return existente.id;
    const result = await db.run('INSERT INTO etiquetas (nome, cor) VALUES (?, ?)', [NOME_ETIQUETA_PARCELA_ATRASADA, '#f59e0b']);
    return result.lastID;
}

let pactoInadimplentesRunning = false;
let pactoInadimplentesProgress = { total: 0, verificados: 0, inadimplentes: 0, parcelasAtrasadas: 0, running: false };

app.get('/api/pacto/inadimplentes/status', async (req, res) => {
    // Última varredura concluída fica salva em `configuracoes` (sobrevive a
    // reinício/deploy) — pactoInadimplentesProgress é só o estado em memória
    // da varredura atual/mais recente desde que o processo subiu.
    const row = await db.get("SELECT valor FROM configuracoes WHERE chave = 'pacto_inadimplentes_ultima_atualizacao'");
    res.json({ ...pactoInadimplentesProgress, ultima_atualizacao: row?.valor || null });
});

app.get('/api/pacto/inadimplentes', async (req, res) => {
    const lista = await db.all('SELECT * FROM pacto_inadimplentes ORDER BY dias_atraso_mais_antiga DESC');
    res.json(lista);
});

// Remoção manual: some da lista e desvincula a etiqueta (seja "Inadimplente"
// ou "Parcela Atrasada" — remove as duas, sem custo remover a que ele não
// tinha) na hora. Se ele ainda estiver mesmo em atraso, volta a aparecer na
// próxima verificação (Integração → Atualizar Lista) — isso aqui só limpa a leitura atual.
app.delete('/api/pacto/inadimplentes/:telefone', async (req, res) => {
    const { telefone } = req.params;
    try {
        const etiquetaLongaId = await garantirEtiquetaInadimplente();
        const etiquetaRecenteId = await garantirEtiquetaParcelaAtrasada();
        await removerEtiquetaContato(telefone, etiquetaLongaId);
        await removerEtiquetaContato(telefone, etiquetaRecenteId);
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
    if (pactoInadimplentesRunning) return;
    pactoInadimplentesRunning = true;
    const contatos = await db.all("SELECT telefone, matricula FROM leads WHERE matricula IS NOT NULL AND matricula != ''");
    const etiquetaLongaId = await garantirEtiquetaInadimplente();
    const etiquetaRecenteId = await garantirEtiquetaParcelaAtrasada();
    // "Vence Hoje" sai da MESMA varredura — usa a mesma chamada de
    // obterParcelasEmAberto já feita pra cada aluno, só classificando o
    // resultado numa terceira categoria, em vez de rodar o scan completo
    // (~3800 contatos, lento) de novo só pra isso.
    const etiquetaVenceHojeId = await garantirEtiquetaVenceHoje();
    const hojeYMD = moment.tz('America/Sao_Paulo').format('YYYY-MM-DD');

    pactoInadimplentesProgress = { total: contatos.length, verificados: 0, inadimplentes: 0, parcelasAtrasadas: 0, vencemHoje: 0, running: true };
    io.emit('pacto_inadimplentes_progress', pactoInadimplentesProgress);

    const CONCORRENCIA = 5;
    let indice = 0;

    async function processarContato(contato) {
        // normalizarTelefoneBR (não só tirar @c.us/@lid) — leads.telefone pode
        // estar salvo sem o 9º dígito (import antigo do Pacto, ver migração de
        // mesclarGrupoDeTelefones); sem isso, essa varredura cria/atualiza a
        // etiqueta num telefone diferente do que o contato realmente conversa,
        // gerando uma conversa fantasma separada da real.
        const numLimpo = normalizarTelefoneBR(contato.telefone.replace('@c.us', '').replace('@lid', ''));
        try {
            const aluno = await buscarAlunoPorMatricula(contato.matricula);
            const estaAtivo = aluno?.situacao?.codigo === 'AT';
            let parcelas = [];
            if (estaAtivo) {
                parcelas = (await obterParcelasEmAberto(aluno.pessoa.codigo)) || [];
            }
            const parcelasVencidas = parcelas.filter(p => p.vencida);
            const parcelasHoje = parcelas.filter(p =>
                p.dataVencimentoDt && moment.tz(p.dataVencimentoDt, 'America/Sao_Paulo').format('YYYY-MM-DD') === hojeYMD
            );

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
                // Etiqueta certa pelo tempo de atraso — e sempre remove a OUTRA,
                // pro caso de ter mudado de faixa desde a última varredura (pagou
                // a parcela mais antiga e a próxima com menos dias virou a mais
                // velha, por exemplo). Remover uma etiqueta que o contato não tem
                // é um DELETE de 0 linhas, sem custo real.
                if (diasAtraso > LIMITE_DIAS_ATRASO_LONGO) {
                    await aplicarEtiquetaContato(numLimpo, etiquetaLongaId);
                    await removerEtiquetaContato(numLimpo, etiquetaRecenteId);
                    pactoInadimplentesProgress.inadimplentes++;
                } else {
                    await aplicarEtiquetaContato(numLimpo, etiquetaRecenteId);
                    await removerEtiquetaContato(numLimpo, etiquetaLongaId);
                    pactoInadimplentesProgress.parcelasAtrasadas++;
                }
            } else if (jaEstavaNoCache) {
                // Não é mais ativo ou já quitou as parcelas — some do cache e das
                // duas etiquetas (só porque sabemos que fomos nós que aplicamos).
                await db.run('DELETE FROM pacto_inadimplentes WHERE telefone = ?', numLimpo);
                await removerEtiquetaContato(numLimpo, etiquetaLongaId);
                await removerEtiquetaContato(numLimpo, etiquetaRecenteId);
            }

            // "Vence Hoje" é independente da inadimplência: um aluno pode estar
            // em dia e ainda assim ter uma parcela vencendo hoje (aviso
            // antecipado, não cobrança), ou até ter as duas etiquetas ao mesmo
            // tempo (uma parcela antiga em atraso + uma nova vencendo hoje).
            const jaEstavaNoCacheHoje = await db.get('SELECT 1 FROM pacto_vencem_hoje WHERE telefone = ?', numLimpo);
            if (estaAtivo && parcelasHoje.length > 0) {
                const valorHoje = parcelasHoje.reduce((soma, p) => soma + (p.valor || 0), 0);
                await db.run(
                    `INSERT INTO pacto_vencem_hoje (telefone, nome, matricula, qtd_parcelas, valor_total, atualizado_em)
                     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(telefone) DO UPDATE SET nome = excluded.nome, matricula = excluded.matricula,
                        qtd_parcelas = excluded.qtd_parcelas, valor_total = excluded.valor_total, atualizado_em = CURRENT_TIMESTAMP`,
                    [numLimpo, aluno.pessoa?.nome || null, aluno.matricula || contato.matricula, parcelasHoje.length, valorHoje]
                );
                await aplicarEtiquetaContato(numLimpo, etiquetaVenceHojeId);
                pactoInadimplentesProgress.vencemHoje++;
            } else if (jaEstavaNoCacheHoje) {
                await db.run('DELETE FROM pacto_vencem_hoje WHERE telefone = ?', numLimpo);
                await removerEtiquetaContato(numLimpo, etiquetaVenceHojeId);
            }
        } catch (err) {
            console.error(`❌ Erro ao checar situação financeira da matrícula ${contato.matricula}:`, err.message);
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
    const ultimaAtualizacao = new Date().toISOString();
    await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['pacto_inadimplentes_ultima_atualizacao', ultimaAtualizacao]);
    io.emit('pacto_inadimplentes_progress', pactoInadimplentesProgress);
    io.emit('pacto_inadimplentes_done', { ...pactoInadimplentesProgress, ultima_atualizacao: ultimaAtualizacao });
    console.log(`✅ Varredura finalizada: ${pactoInadimplentesProgress.inadimplentes} inadimplente(s), ${pactoInadimplentesProgress.parcelasAtrasadas} com parcela atrasada, ${pactoInadimplentesProgress.vencemHoje} vencendo hoje, de ${pactoInadimplentesProgress.verificados} verificados.`);
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
        const etiquetaLongaId = await garantirEtiquetaInadimplente();
        const etiquetaRecenteId = await garantirEtiquetaParcelaAtrasada();
        const expirados = await db.all(
            `SELECT telefone FROM pacto_inadimplentes WHERE atualizado_em <= datetime('now', ?)`,
            `-${INADIMPLENTE_EXPIRACAO_HORAS} hours`
        );
        for (const c of expirados) {
            // Remove as duas — não sabemos aqui qual das duas o contato tinha
            // sem reconsultar, e remover a que ele não tem não custa nada.
            await removerEtiquetaContato(c.telefone, etiquetaLongaId);
            await removerEtiquetaContato(c.telefone, etiquetaRecenteId);
            await db.run('DELETE FROM pacto_inadimplentes WHERE telefone = ?', c.telefone);
        }
        if (expirados.length > 0) console.log(`⏳ ${expirados.length} etiqueta(s) de inadimplência expirada(s) após ${INADIMPLENTE_EXPIRACAO_HORAS}h.`);
    } catch (e) {
        console.error('Erro ao expirar inadimplentes antigos:', e.message);
    }
}
setInterval(expirarInadimplentesAntigos, 30 * 60 * 1000);
setTimeout(expirarInadimplentesAntigos, 90 * 1000);

// =====================================
// INTEGRAÇÃO — CRM PACTO (PARCELA VENCE HOJE)
// =====================================
// "Vence Hoje" é calculado DENTRO de processarInadimplentesPacto (mesma
// varredura, mesma chamada de obterParcelasEmAberto por aluno) — não tem
// scan próprio. Só a etiqueta, a leitura da lista e a remoção manual ficam
// aqui, mais a expiração por tempo.
const NOME_ETIQUETA_VENCE_HOJE = 'Vence Hoje';
async function garantirEtiquetaVenceHoje() {
    const existente = await db.get('SELECT id FROM etiquetas WHERE LOWER(nome) = LOWER(?)', NOME_ETIQUETA_VENCE_HOJE);
    if (existente) return existente.id;
    const result = await db.run('INSERT INTO etiquetas (nome, cor) VALUES (?, ?)', [NOME_ETIQUETA_VENCE_HOJE, '#3b82f6']);
    return result.lastID;
}

app.get('/api/pacto/vencem-hoje', async (req, res) => {
    const lista = await db.all('SELECT * FROM pacto_vencem_hoje ORDER BY valor_total DESC');
    res.json(lista);
});

app.delete('/api/pacto/vencem-hoje/:telefone', async (req, res) => {
    const { telefone } = req.params;
    try {
        const etiquetaId = await garantirEtiquetaVenceHoje();
        await removerEtiquetaContato(telefone, etiquetaId);
        await db.run('DELETE FROM pacto_vencem_hoje WHERE telefone = ?', telefone);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// "Vence Hoje" só faz sentido no dia — expira em 24h desde a última
// confirmação (mais folgado que as 20h do Inadimplente, que é recorrente;
// aqui é só pra não ficar preso caso ninguém rode a varredura de novo).
const VENCE_HOJE_EXPIRACAO_HORAS = 24;
async function expirarVencemHojeAntigos() {
    if (!db) return;
    try {
        const etiquetaId = await garantirEtiquetaVenceHoje();
        const expirados = await db.all(
            `SELECT telefone FROM pacto_vencem_hoje WHERE atualizado_em <= datetime('now', ?)`,
            `-${VENCE_HOJE_EXPIRACAO_HORAS} hours`
        );
        for (const c of expirados) {
            await removerEtiquetaContato(c.telefone, etiquetaId);
            await db.run('DELETE FROM pacto_vencem_hoje WHERE telefone = ?', c.telefone);
        }
        if (expirados.length > 0) console.log(`⏳ ${expirados.length} etiqueta(s) "Vence Hoje" expirada(s) após ${VENCE_HOJE_EXPIRACAO_HORAS}h.`);
    } catch (e) {
        console.error('Erro ao expirar vencem hoje antigos:', e.message);
    }
}
setInterval(expirarVencemHojeAntigos, 30 * 60 * 1000);
setTimeout(expirarVencemHojeAntigos, 95 * 1000);

// =====================================
// INTEGRAÇÃO — AGENDA DE AVALIAÇÃO FÍSICA (confirmação via WhatsApp)
// =====================================
const NOME_ETIQUETA_AGENDAMENTO_AF = 'Agendamento AF';
async function garantirEtiquetaAgendamentoAF() {
    const existente = await db.get('SELECT id FROM etiquetas WHERE LOWER(nome) = LOWER(?)', NOME_ETIQUETA_AGENDAMENTO_AF);
    if (existente) return existente.id;
    const result = await db.run('INSERT INTO etiquetas (nome, cor) VALUES (?, ?)', [NOME_ETIQUETA_AGENDAMENTO_AF, '#14b8a6']);
    return result.lastID;
}

let agendaAvaliacaoRunning = false;
let agendaAvaliacaoProgress = { total: 0, encontrados: 0, sem_whatsapp: 0, running: false, erro: null };

app.get('/api/agenda-avaliacao/status', async (req, res) => {
    const row = await db.get("SELECT valor FROM configuracoes WHERE chave = 'agenda_avaliacao_ultima_atualizacao'");
    res.json({ ...agendaAvaliacaoProgress, ultima_atualizacao: row?.valor || null });
});

app.get('/api/agenda-avaliacao', async (req, res) => {
    const lista = await db.all('SELECT * FROM agenda_avaliacoes_hoje ORDER BY horario ASC');
    res.json(lista);
});

// Chave é appointment_id, não telefone — quem não tem WhatsApp válido cadastrado
// na Pacto também precisa aparecer aqui (é exatamente quem mais precisa de
// correção antes de automatizar), e não dá pra usar telefone como chave pra
// linha que ainda não tem telefone nenhum.
app.delete('/api/agenda-avaliacao/:appointmentId', async (req, res) => {
    const { appointmentId } = req.params;
    try {
        const linha = await db.get('SELECT telefone FROM agenda_avaliacoes_hoje WHERE appointment_id = ?', appointmentId);
        if (linha?.telefone) {
            const etiquetaId = await garantirEtiquetaAgendamentoAF();
            await removerEtiquetaContato(linha.telefone, etiquetaId);
        }
        await db.run('DELETE FROM agenda_avaliacoes_hoje WHERE appointment_id = ?', appointmentId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Corrige nome/matrícula/horário/professor/telefone ANTES de disparar a
// confirmação — os 4 primeiros alimentam direto os placeholders {nome}/
// {matricula}/{horario}/{professor} da automação "Agendamento Avaliação".
// Telefone É editável aqui de propósito: é o caso de uso principal — aluno
// sem WhatsApp cadastrado (ou cadastrado errado) na Pacto só ganha a etiqueta
// "Agendamento AF" (e entra na fila de disparo) depois de alguém corrigir o
// número aqui.
app.put('/api/agenda-avaliacao/:appointmentId', async (req, res) => {
    const { appointmentId } = req.params;
    const { nome, matricula, horario, professor, telefone } = req.body;
    try {
        const linha = await db.get('SELECT * FROM agenda_avaliacoes_hoje WHERE appointment_id = ?', appointmentId);
        if (!linha) return res.status(404).json({ error: 'Agendamento não encontrado.' });

        const telefoneDigitado = (telefone || '').trim();
        const telefoneNovo = telefoneDigitado ? normalizarTelefoneImportado(telefoneDigitado) : null;
        if (telefoneDigitado && !telefoneNovo) {
            return res.status(400).json({ error: 'Número de WhatsApp inválido — confira o DDD e o número.' });
        }

        await db.run(
            'UPDATE agenda_avaliacoes_hoje SET nome = ?, matricula = ?, horario = ?, professor = ?, telefone = ? WHERE appointment_id = ?',
            [(nome || '').trim() || null, (matricula || '').trim() || null, (horario || '').trim() || null, (professor || '').trim() || null, telefoneNovo, appointmentId]
        );

        if (linha.telefone !== telefoneNovo) {
            const etiquetaId = await garantirEtiquetaAgendamentoAF();
            if (linha.telefone) await removerEtiquetaContato(linha.telefone, etiquetaId);
            if (telefoneNovo) await aplicarEtiquetaContato(telefoneNovo, etiquetaId);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Varre a agenda de avaliação física do dia (via Supabase da Planeta Corpo) e
// etiqueta cada aluno como "Agendamento AF" — NÃO manda mensagem nenhuma
// sozinha. A automação "Agendamento Avaliação" (já configurada pelo usuário,
// vinculada a essa mesma etiqueta) é quem cuida do envio, e só dispara quando
// alguém clica "Importar Lista" + "Disparar Mensagens" nela, igual toda
// automação do sistema — essa varredura só alimenta a etiqueta/lista, não
// põe ninguém na fila de envio sozinha.
//
// Essa integração (sistema de agendamento, NADA a ver com a Pacto) só traz
// matrícula/horário/professor — não vem telefone nenhum dela. O telefone é
// resolvido correlacionando a matrícula com um contato que já existe aqui
// (tabela leads) — sem isso, a linha fica sem WhatsApp e sem etiqueta até
// alguém corrigir manualmente na tela (editar → WhatsApp).
async function processarAgendaAvaliacao() {
    if (agendaAvaliacaoRunning) return;
    agendaAvaliacaoRunning = true;
    agendaAvaliacaoProgress = { total: 0, encontrados: 0, sem_whatsapp: 0, running: true, erro: null };
    io.emit('agenda_avaliacao_progress', agendaAvaliacaoProgress);
    try {
        const etiquetaId = await garantirEtiquetaAgendamentoAF();
        const resposta = await buscarAgendaDoDia();
        const agendamentos = resposta?.appointments || [];
        agendaAvaliacaoProgress.total = agendamentos.length;

        const jaEstavam = await db.all('SELECT appointment_id, telefone FROM agenda_avaliacoes_hoje');
        const idsNovos = new Set();

        for (const ag of agendamentos) {
            // appointment_id é a chave da linha agora (telefone pode não existir
            // ainda) — sem ele não dá pra rastrear esse agendamento entre
            // varreduras nem editar depois, então esse caso raro é pulado de verdade.
            const appointmentId = ag.appointment_id ? String(ag.appointment_id) : null;
            if (!appointmentId) {
                console.log(`⚠️ Agenda de Avaliação: agendamento de ${ag.aluno?.nome || 'aluno'} sem appointment_id — pulado.`);
                continue;
            }
            idsNovos.add(appointmentId);

            // Correlaciona pela matrícula com um contato já existente (leads) —
            // é a única fonte de telefone aqui, a agenda não traz WhatsApp.
            const matricula = ag.aluno?.matricula ? String(ag.aluno.matricula).trim() : null;
            let numLimpo = null;
            if (matricula) {
                // Compara tanto o texto exato quanto o valor numérico — a Agenda de
                // Avaliação (Planeta Corpo) manda a matrícula sem zeros à esquerda
                // (ex: "4079"), enquanto o Pacto costuma salvar em Contatos com
                // zeros à esquerda (ex: "004079"); sem isso, o correlacionamento
                // falhava silenciosamente pra todo aluno com matrícula < 6 dígitos.
                const contato = await db.get(
                    `SELECT telefone FROM leads
                     WHERE matricula IS NOT NULL AND TRIM(matricula) != '' AND (
                        TRIM(matricula) = ?
                        OR CAST(matricula AS INTEGER) = CAST(? AS INTEGER)
                     )`,
                    [matricula, matricula]
                );
                // normalizarTelefoneBR — leads.telefone pode estar sem o 9º dígito
                // (import antigo do Pacto); sem isso a etiqueta vai pro telefone
                // errado e cria uma conversa fantasma separada da real.
                if (contato?.telefone) numLimpo = normalizarTelefoneBR(contato.telefone.replace('@c.us', '').replace('@lid', ''));
            }
            // Sem contato correlacionado: a linha AINDA é salva (aparece na tela
            // pra alguém corrigir o WhatsApp manualmente antes de automatizar) —
            // só não ganha a etiqueta, já que não tem telefone nenhum pra aplicar.
            if (!numLimpo) {
                agendaAvaliacaoProgress.sem_whatsapp++;
                console.log(`⚠️ Agenda de Avaliação: ${ag.aluno?.nome || 'aluno'} (matrícula ${matricula || '?'}) sem contato correlacionado nos Contatos — sem etiqueta até corrigir na tela.`);
            }

            const horario = (ag.time || '').slice(0, 5);
            await db.run(
                `INSERT INTO agenda_avaliacoes_hoje (appointment_id, telefone, nome, matricula, horario, professor, atualizado_em)
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(appointment_id) DO UPDATE SET telefone = excluded.telefone, nome = excluded.nome,
                    matricula = excluded.matricula, horario = excluded.horario, professor = excluded.professor,
                    atualizado_em = CURRENT_TIMESTAMP`,
                [appointmentId, numLimpo, ag.aluno?.nome || null, ag.aluno?.matricula || null, horario, ag.professor?.nome || null]
            );
            if (numLimpo) {
                await aplicarEtiquetaContato(numLimpo, etiquetaId);
                agendaAvaliacaoProgress.encontrados++;
            }
        }

        // Quem estava na lista de uma varredura anterior mas não está na de
        // agora: sai da lista e perde a etiqueta (não é mais um agendamento
        // válido pra hoje — foi cancelado, remarcado ou já passou o dia).
        for (const c of jaEstavam) {
            if (!idsNovos.has(c.appointment_id)) {
                await db.run('DELETE FROM agenda_avaliacoes_hoje WHERE appointment_id = ?', c.appointment_id);
                if (c.telefone) await removerEtiquetaContato(c.telefone, etiquetaId);
            }
        }

        const ultimaAtualizacao = new Date().toISOString();
        await db.run('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)', ['agenda_avaliacao_ultima_atualizacao', ultimaAtualizacao]);
        agendaAvaliacaoProgress.running = false;
        io.emit('agenda_avaliacao_progress', agendaAvaliacaoProgress);
        io.emit('agenda_avaliacao_done', { ...agendaAvaliacaoProgress, ultima_atualizacao: ultimaAtualizacao });
        console.log(`✅ Agenda de Avaliação: ${agendaAvaliacaoProgress.encontrados} aluno(s) etiquetado(s), ${agendaAvaliacaoProgress.sem_whatsapp} sem WhatsApp válido, de ${agendaAvaliacaoProgress.total} agendamento(s) hoje.`);
    } catch (e) {
        console.error('❌ Erro na varredura da Agenda de Avaliação:', e.message);
        agendaAvaliacaoProgress.running = false;
        agendaAvaliacaoProgress.erro = e.message;
        io.emit('agenda_avaliacao_progress', agendaAvaliacaoProgress);
    } finally {
        agendaAvaliacaoRunning = false;
    }
}

app.post('/api/agenda-avaliacao/atualizar', async (req, res) => {
    if (agendaAvaliacaoRunning) return res.status(400).json({ error: 'Uma atualização da Agenda de Avaliação já está em andamento.' });
    res.json({ success: true });
    processarAgendaAvaliacao().catch(e => console.error('Erro ao processar agenda de avaliação:', e.message));
});

// Programações de Integração — cada card em Integração ("Importar Contatos
// do Pacto", "Situação Financeira", "Agenda de Avaliação") pode ter sua
// própria programação (dias da semana + horário), configurável em
// Integração → "Criar Programação" e guardada em `integracao_programacoes`.
// Roda a mesma varredura a cada 5min: se o dia da semana bate, já passou do
// horário configurado e ainda não rodou hoje, dispara a ação daquela
// integração. `ultima_execucao_em` sobrevive a deploy/restart (senão um
// reinício logo depois do horário faria rodar de novo, ou nunca).
const INTEGRACAO_PROCESSADORES = {
    pacto_importar: processarImportacaoPactoContatos,
    situacao_financeira: processarInadimplentesPacto,
    agenda_avaliacao: processarAgendaAvaliacao,
};

async function checarProgramacoesIntegracao() {
    if (!db) return;
    try {
        const agora = moment.tz('America/Sao_Paulo');
        const diaAtual = agora.day();
        const minutoAtual = agora.hours() * 60 + agora.minutes();
        const hojeYMD = agora.format('YYYY-MM-DD');
        const programacoes = await db.all('SELECT * FROM integracao_programacoes WHERE ativo = 1');
        for (const prog of programacoes) {
            if (prog.ultima_execucao_em === hojeYMD) continue; // já rodou hoje
            const dias = prog.dias.split(',').filter(Boolean).map(Number);
            if (!dias.includes(diaAtual)) continue;
            const [h, m] = prog.horario.split(':').map(Number);
            if (minutoAtual < h * 60 + m) continue; // ainda não chegou o horário
            const processador = INTEGRACAO_PROCESSADORES[prog.chave];
            if (!processador) continue;
            await db.run('UPDATE integracao_programacoes SET ultima_execucao_em = ? WHERE chave = ?', [hojeYMD, prog.chave]);
            console.log(`🗓️ Programação de integração "${prog.chave}": disparando...`);
            processador().catch(e => console.error(`Erro na programação de integração "${prog.chave}":`, e.message));
        }
    } catch (e) {
        console.error('Erro ao checar programações de integração:', e.message);
    }
}
setInterval(checarProgramacoesIntegracao, 5 * 60 * 1000);
setTimeout(checarProgramacoesIntegracao, 110 * 1000);

app.get('/api/integracoes/programacoes', async (req, res) => {
    try {
        const linhas = await db.all('SELECT chave, dias, horario, ativo, ultima_execucao_em FROM integracao_programacoes');
        res.json(linhas.map(l => ({ ...l, dias: l.dias.split(',').filter(Boolean).map(Number) })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/integracoes/programacoes/:chave', async (req, res) => {
    const { chave } = req.params;
    if (!INTEGRACAO_PROCESSADORES[chave]) return res.status(400).json({ error: 'Integração desconhecida.' });
    const { dias, horario } = req.body;
    if (!Array.isArray(dias) || dias.length === 0) return res.status(400).json({ error: 'Escolha pelo menos um dia da semana.' });
    if (!/^\d{2}:\d{2}$/.test(horario || '')) return res.status(400).json({ error: 'Escolha um horário.' });
    try {
        await db.run(
            `INSERT INTO integracao_programacoes (chave, dias, horario, ativo) VALUES (?, ?, ?, 1)
             ON CONFLICT(chave) DO UPDATE SET dias = excluded.dias, horario = excluded.horario, ativo = 1`,
            [chave, dias.join(','), horario]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/integracoes/programacoes/:chave', async (req, res) => {
    try {
        await db.run('DELETE FROM integracao_programacoes WHERE chave = ?', req.params.chave);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Mesmo padrão das duas varreduras acima, só que generalizado: N programações
// configuráveis pelo usuário (dias da semana + horário próprios cada uma) em
// vez de um horário fixo no código. No horário configurado, dispara TODAS as
// automações vinculadas àquela programação, em ordem — uma travada (pausada,
// fora do horário dela, já rodando) só pula essa e segue pras outras, não
// derruba a programação inteira (ver dispararAutomacaoComGuardas).
async function checarProgramacoes() {
    if (!db) return;
    try {
        const agora = moment.tz('America/Sao_Paulo');
        const diaAtual = agora.day();
        const minutoAtual = agora.hours() * 60 + agora.minutes();
        const hojeYMD = agora.format('YYYY-MM-DD');
        const programacoes = await db.all('SELECT * FROM programacoes WHERE ativo = 1');
        for (const prog of programacoes) {
            if (prog.ultima_execucao_em === hojeYMD) continue; // já rodou hoje
            const dias = prog.dias.split(',').filter(Boolean).map(Number);
            if (!dias.includes(diaAtual)) continue;
            const [h, m] = prog.horario.split(':').map(Number);
            if (minutoAtual < h * 60 + m) continue; // ainda não chegou o horário
            console.log(`🗓️ Programação "${prog.nome}": disparando...`);
            // Só marca "já rodou hoje" se o WhatsApp estava conectado na hora —
            // sem isso, uma Programação que cai bem na janela de uma reconexão
            // travada (ex: deploy, crash) falha silenciosamente e ainda assim
            // fica marcada como "rodou hoje", sem tentar de novo até o dia
            // seguinte (foi o que aconteceu com a Aniversariante das 08:00 no
            // meio do loop de reconexão). Falha por outro motivo (pausada, fora
            // do horário da própria automação) não vale a pena tentar de novo
            // no mesmo dia, mas continua marcando — só a desconexão é transitória.
            let falhouPorDesconexao = false;
            const acoes = await db.all('SELECT automacao_id, intervalo_depois_segundos, tipo FROM programacao_acoes WHERE programacao_id = ? ORDER BY ordem ASC', prog.id);
            for (let i = 0; i < acoes.length; i++) {
                const acao = acoes[i];
                if (acao.tipo === 'automacao') {
                    // "Automação" = Importar Lista: sincroniza a fila da automação
                    // com quem tem a etiqueta agora (mesmo que o botão manual faz).
                    try {
                        const r = await importarContatosParaAutomacao(acao.automacao_id);
                        console.log(`📥 Programação "${prog.nome}": lista importada pra automação #${acao.automacao_id} (${r.importados} novo(s), ${r.removidos} removido(s))`);
                        io.emit('automacoes_atualizadas');
                    } catch (e) {
                        console.log(`⚠️ Programação "${prog.nome}": erro ao importar lista da automação #${acao.automacao_id} — ${e.message}`);
                    }
                } else {
                    // "Disparo" = Disparar Mensagens. Importa a lista sozinho ANTES de
                    // disparar — importarContatosParaAutomacao é idempotente (só
                    // sincroniza a fila com quem tem a etiqueta agora, não manda
                    // mensagem nem duplica quem já está na fila), então isso não tem
                    // efeito colateral nenhum. Sem isso, uma Programação com só a ação
                    // "Disparo" (sem uma ação "Automação" separada antes) rodava sem
                    // erro nenhum mas não mandava nada pra ninguém — fila vazia — e
                    // parecia silenciosamente quebrado pro usuário.
                    try {
                        const r = await importarContatosParaAutomacao(acao.automacao_id);
                        console.log(`📥 Programação "${prog.nome}": lista importada pra automação #${acao.automacao_id} antes do disparo (${r.importados} novo(s), ${r.removidos} removido(s))`);
                        io.emit('automacoes_atualizadas');
                    } catch (e) {
                        console.log(`⚠️ Programação "${prog.nome}": erro ao importar lista da automação #${acao.automacao_id} antes do disparo — ${e.message}`);
                    }
                    const resultado = await dispararAutomacaoComGuardas(acao.automacao_id, `Programação "${prog.nome}"`);
                    if (!resultado.ok) {
                        console.log(`⚠️ Programação "${prog.nome}": automação #${acao.automacao_id} não disparou — ${resultado.error}`);
                        if (resultado.error === 'WhatsApp não está conectado.') falhouPorDesconexao = true;
                    }
                }
                // Espera o intervalo configurado ANTES da próxima ação da mesma
                // programação — não espera a ação atual terminar (o disparo roda
                // em background e pode levar minutos sozinho), só espaça o
                // INÍCIO de uma ação e da próxima (ex: dar tempo do import
                // acontecer antes do disparo seguinte tentar mandar mensagem).
                if (i < acoes.length - 1) await delay((acao.intervalo_depois_segundos || 60) * 1000);
            }
            if (falhouPorDesconexao) {
                console.log(`⏳ Programação "${prog.nome}": WhatsApp estava desconectado — não marca como rodada hoje, tenta de novo no próximo check (5min).`);
            } else {
                await db.run('UPDATE programacoes SET ultima_execucao_em = ? WHERE id = ?', [hojeYMD, prog.id]);
            }
        }
    } catch (e) {
        console.error('Erro ao checar programações:', e.message);
    }
}
setInterval(checarProgramacoes, 5 * 60 * 1000);
setTimeout(checarProgramacoes, 150 * 1000);

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

// Apaga do volume a mídia recebida/enviada manualmente há mais de 10 dias
// (conversas.media_path) — sem isso, toda imagem/documento que passa pelo
// Bate Papo ao Vivo fica salva pra sempre e o volume persistente (limitado)
// enche sozinho com o tempo. NUNCA apaga um arquivo que ainda está configurado
// como mídia de uma regra/etapa de automação/mensagem personalizada — nesse
// caso só solta o vínculo daquela mensagem específica (media_path = NULL),
// sem tocar no arquivo de verdade, que continua sendo usado pelos próximos envios.
const RETENCAO_MIDIA_CONVERSA_DIAS = 10;
async function limparMidiaAntigaConversas() {
    if (!db) return;
    try {
        const antigas = await db.all(
            `SELECT id, media_path FROM conversas WHERE media_path IS NOT NULL AND ts <= datetime('now', ?)`,
            `-${RETENCAO_MIDIA_CONVERSA_DIAS} days`
        );
        let apagados = 0;
        for (const c of antigas) {
            const emUso = await db.get(
                `SELECT 1 AS x
                 FROM respostas WHERE media_path = ?
                 UNION SELECT 1 FROM automacao_etapas WHERE media_path = ?
                 UNION SELECT 1 FROM mensagens_personalizadas WHERE media_path = ?`,
                [c.media_path, c.media_path, c.media_path]
            );
            if (!emUso) {
                const fullPath = path.join(__dirname, 'public', c.media_path.replace(/^\//, ''));
                try {
                    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
                    apagados++;
                } catch (e) {
                    console.error(`Erro ao apagar mídia antiga (${c.media_path}):`, e.message);
                }
            }
            // Solta o vínculo mesmo se o arquivo era compartilhado com uma
            // config ativa (emUso) — essa mensagem específica não precisa
            // mais apontar pra ele, só o registro de "o que foi enviado".
            await db.run('UPDATE conversas SET media_path = NULL WHERE id = ?', c.id);
        }
        if (apagados > 0) console.log(`🧹 Limpeza de mídia: ${apagados} arquivo(s) com mais de ${RETENCAO_MIDIA_CONVERSA_DIAS} dias removido(s) do volume.`);
    } catch (e) {
        console.error('Erro na limpeza de mídia antiga:', e.message);
    }
}
setInterval(limparMidiaAntigaConversas, 6 * 60 * 60 * 1000); // a cada 6h
setTimeout(limparMidiaAntigaConversas, 3 * 60 * 1000);

// Limpeza dos logs novos de estatísticas (custo de IA, eventos de conexão,
// disparo) — mesmo padrão acima, só pra não crescer sem limite no volume.
// Eventos de conexão são poucos (não crescem como mensagem), então a
// retenção é bem mais longa (1 ano) só por higiene.
async function limparLogsEstatisticasAntigos() {
    if (!db) return;
    try {
        const r1 = await db.run("DELETE FROM ia_uso_log WHERE ts <= datetime('now', '-90 days')");
        const r2 = await db.run("DELETE FROM disparo_envios_log WHERE enviado_em <= datetime('now', '-90 days')");
        const r3 = await db.run("DELETE FROM conexao_eventos_log WHERE ts <= datetime('now', '-365 days')");
        const total = (r1.changes || 0) + (r2.changes || 0) + (r3.changes || 0);
        if (total > 0) console.log(`🧹 Limpeza de logs de estatísticas: ${total} linha(s) antiga(s) removida(s).`);
    } catch (e) {
        console.error('Erro na limpeza de logs de estatísticas:', e.message);
    }
}
setInterval(limparLogsEstatisticasAntigos, 6 * 60 * 60 * 1000); // a cada 6h
setTimeout(limparLogsEstatisticasAntigos, 3 * 60 * 1000);

app.post('/api/disconnect', async (req, res) => {
    // Responde imediatamente para não travar o frontend
    res.json({ success: true });
    io.emit('disconnected', 'Desconectado manualmente');

    // Remove sessão do volume para forçar novo QR Code no próximo start
    try {
        const authDir = path.join(DATA_DIR, '.wwebjs_auth');
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    } catch (_) { }

    // Tenta logout suave com timeout de 5s, depois força destroy e reinicia processo
    const exitClean = () => { console.log('🔄 Reiniciando para gerar novo QR Code...'); process.exit(1); };
    const timer = setTimeout(exitClean, 5000);
    try {
        await Promise.race([
            client.logout(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
        ]);
    } catch (_) {
        try { await client.destroy(); } catch (__) { }
    }
    clearTimeout(timer);
    exitClean();
});

// =====================================
// CONFIGURAÇÃO DO CLIENTE WHATSAPP
// =====================================

// Mata qualquer Chrome residual de inicializações anteriores
try { require('child_process').execSync('pkill -f chrome || true', { stdio: 'ignore' }); } catch (_) { }

// Usa chromium do sistema se disponível (evita download do Chrome pelo puppeteer)
const chromiumPath = (() => {
    const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
    for (const p of candidates) {
        try { if (require('fs').existsSync(p)) return p; } catch (_) { }
    }
    return undefined;
})();
if (chromiumPath) console.log(`🌐 Usando Chromium do sistema: ${chromiumPath}`);

// Chrome grava um SingletonLock (symlink com hostname+PID do processo que
// abriu o profile) na pasta de perfil, pra impedir duas instâncias abrindo o
// mesmo profile ao mesmo tempo. Só que a sessão do WhatsApp fica num volume
// PERSISTENTE (sobrevive a redeploy), enquanto cada redeploy/restart do
// Railway sobe um CONTAINER NOVO (hostname/PID novos) — o lock de um
// container anterior nunca é liberado de verdade, e o Chrome se recusa a
// abrir achando que "outro processo" ainda está usando o profile ("Failed to
// launch... Code: 21" / "profile appears to be in use by another Chromium
// process"). Uma vez que isso trava, TODA tentativa de reconectar falha pra
// sempre, inclusive as tentativas automáticas do watchdog — foi exatamente o
// loop infinito relatado ("mesmo erro" de ficar preso em "Iniciando
// conexão..." depois de reiniciar). Remover esses arquivos antes de cada
// initialize() é seguro: só rodamos 1 processo Node por vez (Railway), nunca
// existe de verdade um outro processo vivo usando esse profile — o lock
// encontrado é sempre lixo de um container anterior que já morreu.
function removerLocksChromeStale(clientId) {
    const sessionDir = path.join(DATA_DIR, '.wwebjs_auth', clientId ? `session-${clientId}` : 'session');
    for (const arquivo of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try { fs.rmSync(path.join(sessionDir, arquivo), { force: true }); } catch (_) { }
    }
}

// Fábrica compartilhada entre o client principal (atendimento) e os clients
// do pool de Disparo (só envio — ver seção "POOL DE NÚMEROS PARA DISPARO"
// mais abaixo). Sem clientId (client principal), o LocalAuth usa a pasta
// 'session/' de sempre — comportamento idêntico ao de antes dessa função
// existir, sem risco nenhum de forçar um novo QR do número principal. Com
// clientId (números do pool), cada um ganha sua própria pasta
// 'session-<clientId>/', totalmente isolada.
function criarClienteWhatsApp(clientId) {
    return new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(DATA_DIR, '.wwebjs_auth'),
            ...(clientId && { clientId }),
        }),
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
}

const client = criarClienteWhatsApp();

let currentQR = null;
let isConnected = false;
let clientReadyForPairing = false;
let restartInProgress = false; // Evita loop de restart: só uma reinicialização por vez

// Watchdog de inicialização: algumas vezes o Puppeteer/Chromium trava no
// meio do boot e o client nunca chega a emitir NEM 'qr' NEM 'ready' — o
// painel fica preso em "Iniciando conexão..." pra sempre, sem nenhum
// mecanismo existente pra detectar isso (o crash-recovery do handler
// 'ready' só cobre travamento DEPOIS de já ter conectado uma vez). Sem
// esse watchdog, alguém precisa notar manualmente e reiniciar. Com ele,
// se o client não sair do estado inicial dentro do prazo, tenta reiniciar
// sozinho em processo; se travar de novo na 2ª tentativa, derruba o
// processo inteiro (Railway sobe um container novo do zero — resolve
// travamentos mais teimosos que o restart em processo não resolve).
const INIT_WATCHDOG_MS = 90 * 1000;
let initWatchdogTimer = null;
let initWatchdogTentativas = 0;

function armarInitWatchdog() {
    if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
    initWatchdogTimer = setTimeout(async () => {
        initWatchdogTentativas++;
        console.error(`⏱️ WhatsApp não saiu de "iniciando" em ${INIT_WATCHDOG_MS / 1000}s (tentativa ${initWatchdogTentativas}).`);
        registrarEventoConexao('watchdog_timeout', `tentativa ${initWatchdogTentativas}`);
        if (initWatchdogTentativas >= 2) {
            console.error('🔄 Já travou 2x seguidas — reiniciando o processo inteiro.');
            process.exit(1);
            return;
        }
        console.log('🔁 Reiniciando o client em processo (tentativa automática do watchdog)...');
        try { await client.destroy(); } catch (_) { }
        removerLocksChromeStale();
        armarInitWatchdog();
        client.initialize().catch(err => console.error('Erro ao reinicializar client pelo watchdog:', err.message));
    }, INIT_WATCHDOG_MS);
}

function desarmarInitWatchdog() {
    if (initWatchdogTimer) { clearTimeout(initWatchdogTimer); initWatchdogTimer = null; }
    initWatchdogTentativas = 0;
}

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
        } catch (e) { console.error('Erro ao carregar conversas:', e.message); }
    }

    if (isConnected) socket.emit('ready');
    else if (currentQR) socket.emit('qr', currentQR);
    else socket.emit('loading', 'Iniciando o WhatsApp...');

    // Replay do estado atual de cada número do pool de Disparo, pra uma aba
    // recém-aberta já ver o status certo sem esperar o próximo evento.
    for (const entry of poolClients.values()) {
        if (entry.status === 'connected') socket.emit('pool_ready', { dbId: entry.dbId, numero: entry.numeroConectado });
        else if (entry.status === 'qr' && entry.qrDataUrl) socket.emit('pool_qr', { dbId: entry.dbId, qrDataUrl: entry.qrDataUrl });
    }
});

// =====================================
// EVENTOS DO WHATSAPP
// =====================================
client.on('qr', async (qr) => {
    console.log('📲 Novo QR Code gerado! Acesse o painel web para escanear.');
    desarmarInitWatchdog(); // chegou até aqui — Puppeteer/Chromium subiram normalmente
    sessionWasFresh = true; // a QR/pairing flow is happening — not a silent restore
    clientReadyForPairing = true;
    try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        currentQR = qrDataUrl;
        io.emit('qr', qrDataUrl);
    } catch (err) { console.error('Erro ao gerar QR:', err); }
});

// Loga eventos de conexão pro Painel de Controle (uptime/desconexões) — só
// guarda o fato, nunca deve derrubar o fluxo real de conexão do WhatsApp.
async function registrarEventoConexao(tipo, motivo = null) {
    if (!db) return;
    try {
        await db.run('INSERT INTO conexao_eventos_log (tipo, motivo) VALUES (?, ?)', [tipo, motivo]);
    } catch (e) {
        console.error('Erro ao registrar evento de conexão:', e.message);
    }
}

client.on('authenticated', () => {
    console.log('🔐 WhatsApp autenticado — sessão estabelecida.');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Falha de autenticação WhatsApp:', msg);
    registrarEventoConexao('auth_failure', String(msg));
});

client.on('ready', async () => {
    console.log('✅ Tudo certo! WhatsApp conectado.');
    desarmarInitWatchdog(); // conectou (sessão restaurada sem precisar de QR) — não estava travado
    registrarEventoConexao('conectado');
    try {
        const info = client.info;
        if (info) console.log(`📱 Número conectado: ${info.wid.user} (${info.pushname})`);
    } catch (_) { }

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
                registrarEventoConexao('crash', String(err?.message || err));
                io.emit('disconnected', 'Reconectando WhatsApp...');
                console.log('🔄 Reiniciando cliente WhatsApp (servidor HTTP permanece no ar)...');

                // Destroi o cliente atual silenciosamente
                try { await client.destroy(); } catch (_) { }

                // Aguarda 4s e reinicializa — sem matar o processo Node!
                setTimeout(async () => {
                    try {
                        removerLocksChromeStale();
                        armarInitWatchdog(); // protege esse initialize() também, não só o do boot
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
    registrarEventoConexao('desconectado', String(reason));
    io.emit('disconnected', reason);
});

// =====================================
// POOL DE NÚMEROS PARA DISPARO (só envio — nunca responde ninguém)
// =====================================
// Números extras de WhatsApp dedicados só a mandar Disparos em massa, pra
// tirar esse risco (banimento por volume) do número principal — que continua
// só atendendo/automação, nunca mandando disparo. Cada entrada aqui é uma
// sessão whatsapp-web.js própria e independente da do client principal.
const poolClients = new Map(); // client_id -> entry

function pastaSessaoPool(clientId) {
    return path.join(DATA_DIR, '.wwebjs_auth', `session-${clientId}`);
}

function wireEventosPoolClient(entry) {
    const c = entry.client;
    c.on('qr', async (qr) => {
        entry.status = 'qr';
        entry.readyForPairing = true;
        try {
            entry.qrDataUrl = await qrcode.toDataURL(qr);
            io.emit('pool_qr', { dbId: entry.dbId, qrDataUrl: entry.qrDataUrl });
        } catch (err) {
            console.error(`Erro ao gerar QR do número de disparo "${entry.nome}":`, err.message);
        }
    });
    c.on('ready', () => {
        entry.status = 'connected';
        entry.qrDataUrl = null;
        entry.readyForPairing = false;
        try { entry.numeroConectado = c.info?.wid?.user || null; } catch (_) { entry.numeroConectado = null; }
        console.log(`✅ Número de disparo "${entry.nome}" conectado${entry.numeroConectado ? ` (${entry.numeroConectado})` : ''}.`);
        io.emit('pool_ready', { dbId: entry.dbId, numero: entry.numeroConectado });
    });
    c.on('disconnected', (reason) => {
        entry.status = 'disconnected';
        entry.qrDataUrl = null;
        io.emit('pool_disconnected', { dbId: entry.dbId, reason: String(reason) });
    });
    c.on('auth_failure', (msg) => {
        entry.status = 'disconnected';
        io.emit('pool_disconnected', { dbId: entry.dbId, reason: 'auth_failure: ' + msg });
    });
}

// Cria (se ainda não existe) e inicializa o client daquele número — chamado
// só quando o admin clica "Conectar" ou, no boot, pra número que já tem
// sessão salva (ver reidratarPoolNaInicializacao). Nunca roda sozinho pra um
// número recém-cadastrado sem sessão — isso é o que mantém o custo de RAM
// zero até o admin realmente vincular aquele número.
function iniciarClientePool(row) {
    let entry = poolClients.get(row.client_id);
    if (!entry) {
        entry = { dbId: row.id, nome: row.nome, client: null, status: 'dormant', qrDataUrl: null, readyForPairing: false, numeroConectado: null };
        poolClients.set(row.client_id, entry);
    }
    if (entry.client) return entry; // já inicializado ou inicializando
    entry.client = criarClienteWhatsApp(row.client_id);
    entry.status = 'initializing';
    wireEventosPoolClient(entry);
    removerLocksChromeStale(row.client_id);
    entry.client.initialize().catch(err => {
        console.error(`Erro ao inicializar número de disparo "${row.nome}":`, err.message);
        entry.status = 'disconnected';
        io.emit('pool_disconnected', { dbId: row.id, reason: err.message });
    });
    return entry;
}

// "Pausa" em processo — nunca process.exit, nunca mexe na sessão do client
// principal nem na de outros números do pool. Mantém a sessão salva (dá pra
// reconectar sem escanear QR de novo).
async function desconectarClientePool(entry) {
    if (!entry.client) return;
    try { await entry.client.destroy(); } catch (_) { }
    entry.status = 'disconnected';
    entry.qrDataUrl = null;
}

// Remoção definitiva: logout (ou destroy se o logout travar) + apaga só a
// pasta de sessão DESSE número + tira do mapa em memória.
async function removerClientePool(row, entry) {
    if (entry?.client) {
        try {
            await Promise.race([
                entry.client.logout(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
            ]);
        } catch (_) {
            try { await entry.client.destroy(); } catch (__) { }
        }
    }
    try {
        const pasta = pastaSessaoPool(row.client_id);
        if (fs.existsSync(pasta)) fs.rmSync(pasta, { recursive: true, force: true });
    } catch (_) { }
    poolClients.delete(row.client_id);
}

// No boot: número que já tem sessão salva reconecta sozinho (igual ao
// principal); número nunca vinculado fica 'dormant' até o admin conectar.
async function reidratarPoolNaInicializacao() {
    if (!db) return;
    try {
        const linhas = await db.all('SELECT * FROM disparo_numeros WHERE ativo = 1');
        for (const row of linhas) {
            const temSessao = fs.existsSync(pastaSessaoPool(row.client_id));
            if (temSessao) {
                iniciarClientePool(row);
            } else {
                poolClients.set(row.client_id, { dbId: row.id, nome: row.nome, client: null, status: 'dormant', qrDataUrl: null, readyForPairing: false, numeroConectado: null });
            }
        }
    } catch (e) {
        console.error('Erro ao reidratar pool de números de disparo:', e.message);
    }
}

// Round-robin — só entre números CONECTADOS agora, opcionalmente restrito a
// um subconjunto (roteamento por campanha, ver /api/broadcast/start).
let poolRoundRobinIdx = 0;
function proximoClienteDoPool(idsPermitidos) {
    let candidatos = [...poolClients.values()].filter(e => e.status === 'connected');
    if (Array.isArray(idsPermitidos) && idsPermitidos.length > 0) {
        // Roteamento explícito pra essa campanha — respeita à risca, sem
        // incluir o principal mesmo na fase de transição abaixo.
        candidatos = candidatos.filter(e => idsPermitidos.includes(e.dbId));
    } else if (isConnected) {
        // TEMPORÁRIO (pedido do usuário): enquanto o pool de números de
        // envio ainda está sendo montado, o principal também entra no
        // rodízio das campanhas SEM roteamento restrito — só pra não travar
        // o Disparo nesse primeiro momento. Remover este "else if" assim
        // que o pool tiver números suficientes conectados.
        candidatos = [...candidatos, { dbId: null, nome: 'Principal', client }];
    }
    if (candidatos.length === 0) return null;
    const escolhido = candidatos[poolRoundRobinIdx % candidatos.length];
    poolRoundRobinIdx++;
    return escolhido;
}

app.get('/api/disparo-numeros', async (req, res) => {
    try {
        const linhas = await db.all('SELECT * FROM disparo_numeros ORDER BY criado_em ASC');
        res.json(linhas.map(row => {
            const entry = poolClients.get(row.client_id);
            return {
                id: row.id,
                nome: row.nome,
                ativo: !!row.ativo,
                status: entry?.status || 'dormant',
                numeroConectado: entry?.numeroConectado || null,
                qrDataUrl: entry?.qrDataUrl || null,
            };
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/disparo-numeros', async (req, res) => {
    const nome = (req.body?.nome || '').trim();
    if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
    try {
        const clientId = require('crypto').randomUUID();
        const result = await db.run('INSERT INTO disparo_numeros (nome, client_id) VALUES (?, ?)', [nome, clientId]);
        poolClients.set(clientId, { dbId: result.lastID, nome, client: null, status: 'dormant', qrDataUrl: null, readyForPairing: false, numeroConectado: null });
        io.emit('pool_list_updated');
        res.json({ success: true, id: result.lastID });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/disparo-numeros/:id/conectar', async (req, res) => {
    try {
        const row = await db.get('SELECT * FROM disparo_numeros WHERE id = ?', req.params.id);
        if (!row) return res.status(404).json({ error: 'Número não encontrado.' });
        iniciarClientePool(row);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/disparo-numeros/:id/desconectar', async (req, res) => {
    try {
        const row = await db.get('SELECT * FROM disparo_numeros WHERE id = ?', req.params.id);
        if (!row) return res.status(404).json({ error: 'Número não encontrado.' });
        const entry = poolClients.get(row.client_id);
        if (!entry) return res.status(400).json({ error: 'Esse número não está conectado.' });
        await desconectarClientePool(entry);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/disparo-numeros/:id/pairing-code', async (req, res) => {
    const { telefone } = req.body;
    if (!telefone) return res.status(400).json({ error: 'Informe o número de telefone.' });
    try {
        const row = await db.get('SELECT * FROM disparo_numeros WHERE id = ?', req.params.id);
        if (!row) return res.status(404).json({ error: 'Número não encontrado.' });
        const entry = poolClients.get(row.client_id);
        if (!entry?.readyForPairing) return res.status(400).json({ error: 'Aguarde o QR Code aparecer antes de solicitar o código.' });
        const numero = String(telefone).replace(/\D/g, '');
        const code = await entry.client.requestPairingCode(numero);
        res.json({ code });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/disparo-numeros/:id', async (req, res) => {
    try {
        const row = await db.get('SELECT * FROM disparo_numeros WHERE id = ?', req.params.id);
        if (!row) return res.status(404).json({ error: 'Número não encontrado.' });
        const entry = poolClients.get(row.client_id);
        await removerClientePool(row, entry);
        await db.run('DELETE FROM disparo_numeros WHERE id = ?', row.id);
        io.emit('pool_list_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/disparo-roteamento', async (req, res) => {
    try {
        const linhas = await db.all('SELECT * FROM disparo_roteamento');
        const mapa = {};
        linhas.forEach(l => { mapa[l.campanha_chave] = l.numeros_ids.split(',').filter(Boolean).map(Number); });
        res.json(mapa);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/disparo-roteamento/:campanha_chave', async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.numeros_ids) ? req.body.numeros_ids.filter(n => Number.isInteger(n) || /^\d+$/.test(n)) : [];
        if (ids.length === 0) {
            await db.run('DELETE FROM disparo_roteamento WHERE campanha_chave = ?', req.params.campanha_chave);
        } else {
            await db.run(
                `INSERT INTO disparo_roteamento (campanha_chave, numeros_ids) VALUES (?, ?)
                 ON CONFLICT(campanha_chave) DO UPDATE SET numeros_ids = excluded.numeros_ids`,
                [req.params.campanha_chave, ids.join(',')]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
// "telefone" é sempre o número canônico (resolvido via resolveJid/numLimpo), NUNCA
// o chat id cru do WhatsApp — passar o replyTo/chat.id._serialized aqui foi o bug
// real por trás de contatos fantasma tipo "225992639565829": pra contas migradas
// pro sistema @lid do WhatsApp, esse id é um número interno gigante sem relação
// com o telefone, e registrarMensagemEnviada só tira o sufixo @lid, sobrando o
// lid cru como se fosse o telefone — cria uma "conversa" nova e errada por
// contato. resolverChatId() (mesmo helper usado nos disparos/campanhas) resolve
// o chat id de verdade pra ENVIAR, sem contaminar o que é salvo no banco.
async function enviarEregistrar(telefone, conteudo) {
    const numLimpoCheck = telefone.replace('@c.us', '').replace('@lid', '');
    const chatId = telefone.includes('@') ? telefone : await resolverChatId(client, numLimpoCheck);
    const delayConfigurado = await obterDelayRespostaConfigurado();
    if (delayConfigurado > 0) await delay(delayConfigurado * 1000);
    if (typeof conteudo === 'string') {
        await simularDigitando(client.getChatById(chatId));
        await delay(calcularDelayDigitacao(conteudo));
    }
    // Rechecagem: entre decidir responder e chegar aqui pode ter se passado até
    // ~1min (Delay configurável + simulação de digitação) — se o operador
    // assumiu a conversa nesse meio tempo, o robô não pode mais mandar nada
    // (checar isso só no início do processamento da mensagem não é suficiente
    // com o Delay configurável habilitado).
    if (await db.get('SELECT 1 FROM conversas_humano WHERE telefone = ?', numLimpoCheck)) {
        console.log(`⏸️ Envio cancelado — conversa com ${numLimpoCheck} foi assumida por humano durante o atraso configurado.`);
        return null;
    }
    const resultado = await client.sendMessage(chatId, conteudo);
    await registrarMensagemEnviada(numLimpoCheck, typeof conteudo === 'string' ? conteudo : '[mídia]', null, resultado?.id?._serialized);
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

// Preço aproximado por 1.000 tokens (USD) — usado só pra ESTIMAR custo de IA
// no Painel de Controle, não é a fatura real (a OpenAI cobra por uso exato;
// confira em platform.openai.com/usage se precisar de exatidão). Groq nem
// entra aqui: é o tier gratuito que o próprio painel já anuncia como
// "Gratuito e Ultrarrápido", custo sempre 0. Atualize os valores abaixo se a
// OpenAI mudar a tabela de preços.
const PRECO_POR_1K_TOKENS = {
    'gpt-3.5-turbo': { prompt: 0.0005, completion: 0.0015 },
    'gpt-4o': { prompt: 0.0025, completion: 0.01 },
};
function custoEstimadoIA(provedor, modelo, promptTokens, completionTokens) {
    if (provedor === 'groq') return 0;
    const preco = PRECO_POR_1K_TOKENS[modelo];
    if (!preco) return 0;
    return (promptTokens / 1000) * preco.prompt + (completionTokens / 1000) * preco.completion;
}

// Simula o tempo de "digitando...": resposta curta pausa pouco, resposta longa
// pausa mais — enviar tudo instantâneo soa robótico demais.
const DIGITACAO_MIN_MS = 1200;
const DIGITACAO_MAX_MS = 6000;
const DIGITACAO_MS_POR_CARACTERE = 35;
function calcularDelayDigitacao(texto) {
    const estimado = (texto || '').length * DIGITACAO_MS_POR_CARACTERE;
    return Math.min(DIGITACAO_MAX_MS, Math.max(DIGITACAO_MIN_MS, estimado));
}

// "Delay" configurável em Configurações → Comportamento do Robô: espera fixa
// ANTES de sequer começar a digitar (diferente da simulação de digitação
// acima, que já depende do tamanho do texto) — deixa o robô com resposta
// menos instantânea/robótica. Sem configurar (ou 0) = sem espera extra,
// comportamento de sempre.
async function obterDelayRespostaConfigurado() {
    try {
        const row = await db.get("SELECT valor FROM configuracoes WHERE chave = 'robo_delay_resposta_segundos'");
        const segundos = parseInt(row?.valor, 10);
        return segundos > 0 ? segundos : 0;
    } catch (e) {
        return 0;
    }
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
    } catch (_) { }
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

const EXTENSAO_POR_MIME_GERAL = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
    'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'webm',
    'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'application/zip': 'zip',
    'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
};
function extensaoPorMimetype(mimetype) {
    const tipo = (mimetype || '').split(';')[0].trim();
    if (EXTENSAO_POR_MIME_GERAL[tipo]) return EXTENSAO_POR_MIME_GERAL[tipo];
    const sub = tipo.split('/')[1];
    return sub ? sub.split('+')[0] : 'bin';
}

// Baixa a mídia (imagem/documento/vídeo/figurinha) de uma mensagem recebida e
// salva em public/uploads (volume persistente) — devolve a URL pública pra
// gravar em conversas.media_path, pra dar pra abrir a mídia clicando na bolha
// do Bate Papo ao Vivo. Antes disso a mídia recebida nunca era baixada, só
// classificada por tipo. Se travar/falhar, a mensagem salva do mesmo jeito,
// só sem anexo clicável (mesmo padrão de transcreverAudio acima).
//
// 15s (valor original) era curto demais na prática: medindo os documentos e
// imagens recebidos de verdade, boa parte vinha com media_path nulo (arquivo
// nunca baixado) — documento em especial, por ser tipicamente maior que foto
// (WhatsApp comprime foto automaticamente, documento vai no tamanho original).
//
// Achado um segundo motivo de falha, mais profundo: por baixo do
// downloadMedia(), o whatsapp-web.js tenta achar a mensagem em memória
// (rápido) e só cai pra uma busca no IndexedDB do próprio WhatsApp Web
// quando não acha (comum em chats novos/pouco estabelecidos, ex: contato
// que acabou de mandar a primeira mensagem) — e essa busca no IndexedDB
// está batendo num bug de verdade do WhatsApp Web ("Failed to execute get
// on IDBObjectStore: No key or key range specified"), fora do nosso
// controle. Dar um respiro ANTES de tentar (dá tempo do Store terminar de
// indexar a mensagem em memória) aumenta a chance do caminho rápido
// funcionar e nunca cair nesse bug. Só ajuda, não resolve 100% — é um bug
// de verdade do WhatsApp Web, não vamos conseguir eliminar por completo.
async function baixarMidiaRecebida(msg) {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
        await delay(tentativa === 1 ? 1500 : 5000);
        try {
            const media = await Promise.race([
                msg.downloadMedia(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 45000))
            ]);
            if (!media || !media.data) throw new Error('downloadMedia devolveu vazio');
            const ext = extensaoPorMimetype(media.mimetype);
            const nomeArquivo = `recebido_${Date.now()}_${Math.round(Math.random() * 1e9)}.${ext}`;
            const destino = path.join(__dirname, 'public', 'uploads', nomeArquivo);
            fs.writeFileSync(destino, Buffer.from(media.data, 'base64'));
            return '/uploads/' + nomeArquivo;
        } catch (e) {
            console.error(`Erro ao baixar mídia recebida (tentativa ${tentativa}/3):`, e.message);
        }
    }
    return null;
}

// Roda baixarMidiaRecebida em background, sem segurar quem chamou — a
// mensagem já foi salva e exibida (com media_path nulo); se o download
// terminar bem, atualiza essa mesma linha em "conversas" e avisa o painel
// pra trocar o selo de tipo pelo anexo de verdade na bolha já exibida.
function baixarMidiaEAtualizarEmBackground(msg, idConversa, telefone) {
    baixarMidiaRecebida(msg).then(async (mediaPath) => {
        if (!mediaPath || !idConversa) return;
        await db.run('UPDATE conversas SET media_path = ? WHERE id = ?', [mediaPath, idConversa]);
        // Manda a linha inteira (não só media_path) — o painel monta o corpo
        // da bolha (imagem/vídeo/documento) a partir de tipo+texto+media_path
        // juntos, mesmo formato de nova_mensagem.
        const linha = await db.get('SELECT tipo, texto, direcao, manual FROM conversas WHERE id = ?', idConversa);
        io.emit('midia_atualizada', { id: idConversa, telefone, media_path: mediaPath, ...linha });
    }).catch(e => console.error('Erro ao baixar mídia em background:', e.message));
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
    } catch (_) { }
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
// Cache compartilhado entre qualquer client (principal ou do pool de
// Disparo) — o chat id resolvido é intrínseco ao número de destino, não
// depende de quem pergunta.
const chatIdCache = new Map();
async function resolverChatId(clienteWpp, numeroLimpo) {
    if (chatIdCache.has(numeroLimpo)) return chatIdCache.get(numeroLimpo);
    const contato = await clienteWpp.getNumberId(numeroLimpo);
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
        console.log(`🔍 [DEBUG] ${dir} from=${msg.from} body="${(msg.body || '[sem texto]').slice(0, 40)}"`);
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
        // NÃO apaga a marca ao bater — mensagem de mídia (imagem/documento)
        // costuma disparar message_create MAIS DE UMA VEZ pro mesmo envio
        // (ciclo de upload: "enviando" e depois "enviado"). Apagar na primeira
        // batida fazia a SEGUNDA disparada (a mesma mensagem de novo) não achar
        // mais a marca e duplicar mesmo assim — foi exatamente o caso visto
        // (uma legenda com foto duplicando: uma linha "Operador", outra sem
        // marca de manual). Deixa expirar sozinha pelo setTimeout (60s).
        if (idsMensagensDoSistema.has(msgId)) return;
    }

    try {
        const telefoneResolvido = await resolveJid(msg.to);
        const numLimpo = telefoneResolvido.replace('@c.us', '').replace('@lid', '');
        // Fallback do dedup acima: client.sendMessage() às vezes devolve
        // undefined mesmo quando a mensagem FOI entregue (bug conhecido do
        // WhatsApp Web, mesma causa já vista no download de mídia) — sem um
        // id de verdade pra marcar em idsMensagensDoSistema, a checagem por
        // id acima nunca bate, e essa mensagem (que JÁ foi salva por quem a
        // mandou) duplicava aqui, tratada como "eco do celular". telefone+texto
        // é mais grosseiro que o id, mas só entra em jogo quando o id faltou.
        // Mesmo motivo de não apagar ao bater: pode disparar mais de uma vez.
        if (msg.body) {
            const chaveConteudo = `${numLimpo}|${msg.body}`;
            if (conteudosMensagensDoSistema.has(chaveConteudo)) {
                return;
            }
        }
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
        // Mídia baixa em background (ver comentário em baixarMidiaRecebida).
        const idConversa = await salvarNaConversa(numLimpo, nome, 'out', textoExibir, tipoMsg, msg.timestamp, true, null);
        if (msg.hasMedia && ['image', 'video', 'document', 'sticker'].includes(tipoMsg)) {
            baixarMidiaEAtualizarEmBackground(msg, idConversa, numLimpo);
        }
    } catch (e) {
        console.error('Erro ao registrar mensagem enviada pelo celular:', e.message);
    }
});

// Wrapper de envio: tenta msg.reply(), se timeout reinicia o processo
async function enviarResposta(msg, conteudo, opcoes = {}) {
    try {
        const delayConfigurado = await obterDelayRespostaConfigurado();
        if (delayConfigurado > 0) await delay(delayConfigurado * 1000);
        if (typeof conteudo === 'string') {
            await simularDigitando(msg.getChat());
            await delay(calcularDelayDigitacao(conteudo));
        }
        // Rechecagem: entre decidir responder e chegar aqui pode ter se passado
        // até ~1min (Delay configurável + simulação de digitação) — se o
        // operador assumiu a conversa nesse meio tempo, o robô não pode mais
        // mandar nada (checar isso só no início do processamento da mensagem
        // não é suficiente com o Delay configurável habilitado).
        const telefoneCheck = await resolvePhone(msg);
        const numLimpoCheck = telefoneCheck.replace('@c.us', '').replace('@lid', '');
        if (await db.get('SELECT 1 FROM conversas_humano WHERE telefone = ?', numLimpoCheck)) {
            console.log(`⏸️ Envio cancelado — conversa com ${numLimpoCheck} foi assumida por humano durante o atraso configurado.`);
            return null;
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

// =====================================
// DESPACHO DE RESPOSTA POR CANAL
// =====================================
// processarComoRobo/agendarFallbackHumano só conhecem "mandar uma resposta"
// através dessa função — pro WhatsApp, chama o enviarResposta de sempre, sem
// NENHUMA mudança de comportamento (mesmo objeto msg de verdade do
// whatsapp-web.js). Pro Instagram, manda pela Graph API; mídia (regra com
// media_path) ainda não é suportada nesse canal nessa 1ª versão — só pula o
// envio da mídia (loga, não quebra o resto do fluxo).
async function enviarRespostaCanal(canal, msg, telefoneReal, conteudo, opcoes = {}) {
    if (canal !== 'instagram') return enviarResposta(msg, conteudo, opcoes);

    if (typeof conteudo !== 'string') {
        console.log(`ℹ️ Instagram (${telefoneReal}): mídia em resposta automática ainda não é suportada nesse canal — envio pulado.`);
        return null;
    }
    try {
        const { pageAccessToken } = await obterConfigInstagram();
        const resultado = await enviarMensagemInstagram(telefoneReal, conteudo, pageAccessToken);
        console.log('✅ Resposta entregue via Instagram.');
        // Formato mínimo compatível com o "sent" que os call sites esperam
        // (só leem sent.id?._serialized) — a Graph API devolve
        // { recipient_id, message_id }, sem _serialized de verdade.
        return { id: { _serialized: resultado?.message_id || null } };
    } catch (e) {
        console.error(`❌ Erro ao enviar pelo Instagram (${telefoneReal}):`, e.message);
        return null;
    }
}

// Mensagem "só emoji"/reconhecimento curto (👍, "vlw", "obrigado"...) não
// precisa de IA — modelos pequenos (ex: llama-3.1-8b-instant) às vezes
// "viajam" tentando montar uma resposta elaborada pra uma entrada tão vazia
// e acabam ecoando/alucinando meta-instruções (foi o que aconteceu: o robô
// mandou pro cliente um texto tipo "vamos criar uma conversa... mensagem do
// Fulano:" — claramente vazamento do prompt interno, não uma resposta de
// verdade). Mais seguro simplesmente não chamar a IA nesses casos.
const PALAVRAS_TRIVIAIS = ['ok', 'okay', 'blz', 'vlw', 'valeu', 'obrigado', 'obrigada', 'obg', 'flw', 'tmj', 'show', 'top', 'otimo', 'ótimo', 'beleza', 'certo', 'entendi'];
function ehMensagemTrivial(texto) {
    const semEspaco = (texto || '').trim();
    if (!semEspaco) return true;
    // Faixa À-ÿ cobre as letras acentuadas do latin-1 (á, é, ç, õ...) — não
    // precisa remover acento pra checar "tem letra", só pra comparar a palavra.
    const temLetra = /[a-zA-ZÀ-ÿ]/.test(semEspaco);
    if (!temLetra) return true; // só emoji/pontuação/figurinha
    const soLetras = semEspaco.replace(/[^a-zA-ZÀ-ÿ]/g, '');
    return soLetras.length <= 12 && PALAVRAS_TRIVIAIS.includes(soLetras.toLowerCase());
}

// Segunda linha de defesa: mesmo evitando chamar a IA pra mensagens triviais
// (acima), um modelo ainda pode ocasionalmente vazar meta-instrução em vez de
// responder de verdade pro cliente. Descarta a resposta se ela parecer isso
// — melhor não mandar nada do que mandar um texto claramente quebrado/interno.
const PADRAO_VAZAMENTO_PROMPT = /vamos criar uma conversa|responder a cada mensagem dele como|mensagem do \w+:|regras e o tom de voz estabelecidos|como a consultora maria/i;
function respostaIAParecevazamento(texto) {
    return PADRAO_VAZAMENTO_PROMPT.test(texto || '');
}

// Fecha o círculo do "Protocolo de Transferência" descrito no treinamento da
// IA: lá a Consultora Maria é instruída a encerrar o atendimento com a frase
// reservada "Tenha um ótimo dia" quando o cliente confirma que não tem mais
// dúvidas e o caso vai ser encaminhado pra equipe. Antes disso era só um
// "disse que ia encaminhar" sem nenhuma ação de verdade — agora, ao detectar
// essa frase (também funciona pra regra manual, se algum dia usar o mesmo
// fechamento), a conversa é realmente movida pra "Aguardando" no painel,
// exatamente como o botão manual "Assumir Conversa" faz.
const PADRAO_ENCERRAMENTO_ATENDIMENTO = /tenha um [oó]timo dia/i;
async function encaminharParaHumanoSeEncerrou(texto, numLimpo) {
    if (!PADRAO_ENCERRAMENTO_ATENDIMENTO.test(texto || '')) return;
    try {
        await db.run('INSERT OR IGNORE INTO conversas_humano (telefone) VALUES (?)', numLimpo);
        io.emit('conversa_assumida', { telefone: numLimpo, assumida: true });
        console.log(`🙋 Conversa com ${numLimpo} encaminhada pra "Aguardando" — robô identificou encerramento/transferência.`);
    } catch (e) {
        console.error('Erro ao encaminhar conversa pra humano após encerramento:', e.message);
    }
}

// Fluxo normal do robô: fluxo de cadastro/Pacto, regras de palavra-chave, e IA
// como fallback. Extraído do handler de 'message' pra poder ser chamado tanto
// na hora (modo robô) quanto adiado (rede de segurança de horário, ver
// agendarFallbackHumano) sem duplicar a lógica.
async function processarComoRobo(msg, numLimpo, texto, telefoneReal, nomeContato, canal = 'whatsapp') {
    // Sinaliza que o bot está processando ("digitando...")
    io.emit('bot_digitando', { telefone: numLimpo, ativo: true });

    // numLimpo (já resolvido via resolveJid), não replyTo (chat id cru do
    // WhatsApp) — ver comentário em enviarEregistrar sobre o bug de contato
    // fantasma que isso causava em contas migradas pro sistema @lid.
    if (await handleCadastroFlow(numLimpo, texto, msg.body || '')) { io.emit('bot_digitando', { telefone: numLimpo, ativo: false }); return; }

    if (await handlePactoFlow(numLimpo, texto)) { io.emit('bot_digitando', { telefone: numLimpo, ativo: false }); return; }

    const regras = await db.all('SELECT * FROM respostas WHERE ativo = 1 ORDER BY ordem ASC');
    let regraAtiva = null;
    for (const regra of regras) {
        const keywords = regra.keywords.split(',').map(k => k.trim().toLowerCase());
        // Palavra-chave puramente numérica (ex: opção "1" do menu) só ativa a regra se
        // for a mensagem inteira — senão qualquer número (horário, telefone, preço) ativaria à toa.
        const matched = keywords.some(kw => /^\d+$/.test(kw) ? texto === kw : texto.includes(kw));
        if (matched) { regraAtiva = regra; break; }
    }

    if (!regraAtiva && ehMensagemTrivial(texto)) {
        io.emit('bot_digitando', { telefone: numLimpo, ativo: false });
        return;
    }

    if (!regraAtiva) {
        const confRows = await db.all('SELECT * FROM configuracoes');
        const config = {};
        confRows.forEach(r => config[r.chave] = r.valor);

        const provider = config.ia_provider || 'openai';
        const iaAtiva = config.openai_status === 'true';
        const apiKey = provider === 'groq' ? config.groq_api_key : config.openai_api_key;
        const modelo = provider === 'groq'
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

            // Exemplos reais de consultoras parecidos com a mensagem ATUAL — busca
            // de novo a cada turno (não só na primeira mensagem), porque a pergunta
            // muda de turno a turno. Entra como mensagem de sistema à parte, não
            // misturada no systemContent fixo acima.
            const exemplosConsultoras = await buscarExemplosRelevantes(texto);
            if (exemplosConsultoras.length > 0) {
                const textoExemplos = 'Exemplos reais de como nossas consultoras já responderam perguntas parecidas com essa — use como referência de tom e estilo, sem copiar literalmente se não fizer sentido pro contexto atual:\n\n' +
                    exemplosConsultoras.map(e => `Cliente: ${e.pergunta_cliente}\nConsultora: ${e.resposta_consultora}`).join('\n\n');
                history.push({ role: 'system', content: textoExemplos });
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
                        console.log(`⏳ Rate limit (${provider}), tentativa ${tentativa}/3 — aguardando ${espera / 1000}s...`);
                        await new Promise(r => setTimeout(r, espera));
                        return chamarIA(tentativa + 1);
                    }
                    throw e;
                }
            };

            try {
                const completion = await chamarIA();

                // Loga tokens/custo da chamada — fire-and-forget, nunca pode
                // atrapalhar o envio da resposta real pro cliente (só console.error).
                try {
                    const uso = completion.usage || {};
                    await db.run(
                        'INSERT INTO ia_uso_log (telefone, provedor, modelo, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?)',
                        [numLimpo, provider, modelo, uso.prompt_tokens || 0, uso.completion_tokens || 0, uso.total_tokens || 0]
                    );
                } catch (e) {
                    console.error('Erro ao registrar uso de IA:', e.message);
                }

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

                // Sanity-check: se a resposta parecer vazamento de meta-instrução
                // (ex: "vamos criar uma conversa... mensagem do Fulano:") em vez de
                // uma resposta de verdade pro cliente, descarta — não põe no
                // histórico (senão o próximo turno herda a bagunça) nem manda.
                if (respostaIAParecevazamento(respostaIA)) {
                    console.error(`🧨 IA (${provider}/${modelo}) gerou resposta com cara de vazamento de prompt pra ${numLimpo} — descartada, nada enviado. Trecho: "${respostaIA.slice(0, 120)}..."`);
                    io.emit('bot_digitando', { telefone: numLimpo, ativo: false });
                    return;
                }

                history.push({ role: 'assistant', content: respostaIA });

                if (history.length > 7) {
                    const sys = history.shift();
                    history.shift();
                    history.shift();
                    history.unshift(sys);
                }
                global.chatHistory.set(telefoneReal, history);

                console.log(`🤖 IA respondendo para ${numLimpo}`);
                const sentIA = await enviarRespostaCanal(canal, msg, telefoneReal, respostaIA);
                io.emit('bot_digitando', { telefone: numLimpo, ativo: false });
                if (sentIA) {
                    await registrarMensagemEnviada(telefoneReal, respostaIA, nomeContato, sentIA.id?._serialized, false, 'text', null, canal);
                    await encaminharParaHumanoSeEncerrou(respostaIA, numLimpo);
                }
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
    if (hora >= 5 && hora < 12) saudacao = 'Bom dia';
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

    const sent = await enviarRespostaCanal(canal, msg, telefoneReal, textoFinal);
    io.emit('bot_digitando', { telefone: numLimpo, ativo: false });
    if (sent) {
        await registrarMensagemEnviada(telefoneReal, textoFinal, nomeContato, sent.id?._serialized, false, 'text', null, canal);
        await encaminharParaHumanoSeEncerrou(textoFinal, numLimpo);
    }

    // Áudio temporariamente desativado (causa timeout no Puppeteer)
    // if (regraAtiva.enviar_audio) { ... }

    if (regraAtiva.media_path) {
        const mediaFullPath = path.join(__dirname, 'public', regraAtiva.media_path.replace(/^\//, ''));
        if (fs.existsSync(mediaFullPath)) {
            await delay(500);
            const media = MessageMedia.fromFilePath(mediaFullPath);
            const sentMedia = await enviarRespostaCanal(canal, msg, telefoneReal, media);
            if (sentMedia) {
                const tipoMedia = regraAtiva.media_tipo === 'file' ? 'document' : (regraAtiva.media_tipo || 'document');
                await registrarMensagemEnviada(telefoneReal, '[mídia enviada]', nomeContato, sentMedia.id?._serialized, false, tipoMedia, regraAtiva.media_path, canal);
            }
        }
    }
}

// Rede de segurança do Horário de Funcionamento: se ninguém (humano) responder
// dentro do prazo configurado (padrão 180s), o robô assume mesmo fora da
// janela dele — evita cliente esperando indefinidamente se o atendente da vez
// está sobrecarregado. NÃO se aplica a conversa assumida manualmente (ver
// client.on('message')) — só à janela de horário "Humano".
// Reinicia o timer a cada nova mensagem do cliente sem resposta (debounce):
// só dispara N segundos depois da ÚLTIMA mensagem sem resposta, não da primeira.
const pendingFallbackTimers = new Map();
async function agendarFallbackHumano(msg, numLimpo, texto, telefoneReal, nomeContato, canal = 'whatsapp') {
    // Cancela o timer anterior JÁ NO INÍCIO, antes de qualquer await — se não
    // fizer isso aqui em cima, duas mensagens quase simultâneas do mesmo
    // contato (comum: cliente manda várias mensagens curtas seguidas) podiam
    // ler "nenhum timer pendente" ao mesmo tempo (nenhuma via a da outra
    // ainda) e cada uma agendar o SEU próprio timer sem cancelar o do outro —
    // o mais antigo disparava sozinho, como se a mensagem mais nova nunca
    // tivesse resetado a contagem ("robô assume cedo demais").
    const timerAnterior = pendingFallbackTimers.get(numLimpo);
    if (timerAnterior) clearTimeout(timerAnterior);
    pendingFallbackTimers.delete(numLimpo);

    const [ativoRow, segRow] = await Promise.all([
        db.get("SELECT valor FROM configuracoes WHERE chave = 'horario_fallback_ativo'"),
        db.get("SELECT valor FROM configuracoes WHERE chave = 'horario_fallback_segundos'"),
    ]);
    if (ativoRow?.valor !== 'true') return;
    const segundos = parseInt(segRow?.valor, 10) || 180;
    // Mesmo formato usado em conversas.ts (ver salvarNaConversa: sempre ISO,
    // "2026-07-14T15:30:45.123Z") — usar o formato do datetime('now') do
    // SQLite ("2026-07-14 15:30:45", com espaço) pra comparar contra isso
    // era uma comparação de texto incoerente: 'T' (0x54) sempre vence ' '
    // (0x20) no mesmo ponto da string, então QUALQUER resposta do MESMO DIA
    // contava como "já respondida" mesmo tendo sido enviada horas antes da
    // mensagem atual — o robô achava que alguém tinha acabado de responder
    // quando na verdade não tinha nada recente.
    const marcadorTs = new Date().toISOString();

    const timer = setTimeout(async () => {
        // Só prossegue se ESTE ainda for o timer mais recente desse contato —
        // se uma mensagem mais nova chegou depois e criou outro timer (ver
        // comentário acima), este aqui é stale e não deve fazer nada.
        if (pendingFallbackTimers.get(numLimpo) !== timer) return;
        pendingFallbackTimers.delete(numLimpo);
        try {
            // Recheca tudo na hora de disparar, não na hora de agendar — muita
            // coisa pode ter mudado nesses N segundos.
            const assumida = await db.get('SELECT 1 FROM conversas_humano WHERE telefone = ?', numLimpo);
            if (assumida) return; // alguém assumiu de propósito nesse meio tempo — não atravessa
            // >= (não só >): garante que uma resposta no mesmo instante do
            // marcador ainda conte como "já respondida".
            const jaRespondida = await db.get(
                `SELECT 1 FROM conversas WHERE telefone = ? AND direcao = 'out' AND ts >= ? LIMIT 1`,
                [numLimpo, marcadorTs]
            );
            if (jaRespondida) return; // atendente respondeu a tempo
            console.log(`⏱️ ${segundos}s sem resposta humana pra ${numLimpo} — robô assume como rede de segurança.`);
            await processarComoRobo(msg, numLimpo, texto, telefoneReal, nomeContato, canal);
        } catch (e) {
            console.error('Erro no fallback de robô por timeout de horário:', e.message);
        }
    }, segundos * 1000);
    pendingFallbackTimers.set(numLimpo, timer);
}

client.on('message', async (msg) => {
    try {
        if (!msg.from || msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast')) return;
        if (!TIPOS_MSG_VALIDOS.has(msg.type)) return; // ruído de protocolo — nunca vira conversa
        // "chat" com corpo vazio nunca é uma mensagem de texto real (ninguém
        // manda texto em branco pelo WhatsApp) — é ruído de sincronização
        // entre aparelhos disfarçado de mensagem de texto legítima.
        if (msg.type === 'chat' && !msg.body) return;
        // Grupo já foi descartado pelo "@g.us" da checagem lá em cima — chamar
        // msg.getChat() aqui de novo só pra reconferir isGroup era redundante,
        // e client.getChatById() (por baixo do getChat()) passou a rejeitar
        // pra TODA mensagem recebida (bug/incompatibilidade da lib com essa
        // versão do WhatsApp Web) — como esse await não tinha proteção própria,
        // a exceção estourava pro catch de fora e abortava a mensagem inteira
        // ANTES de salvarNaConversa, ou seja, a mensagem nunca aparecia no
        // Bate Papo ao Vivo (nem texto, nem mídia) mesmo chegando certinho no
        // WhatsApp de verdade.

        const telefoneReal = await resolvePhone(msg);  // número limpo para salvar no banco
        const numLimpo = telefoneReal.replace('@c.us', '').replace('@lid', '');

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
        } catch (_) { }

        // BUG DE VERDADE encontrado: usava telefoneReal (ainda com @c.us/@lid
        // grudado) em vez de numLimpo — registerLead("5542984014994@c.us") e
        // registerLead("5542984014994") são DUAS chaves diferentes pro
        // leadsSet/tabela leads, mesmo sendo o mesmo contato. Cada mensagem
        // nova recriava um lead "fantasma" (sem matrícula/nascimento) por
        // cima do cadastro certo — foi o que aconteceu com o Henrique DEPOIS
        // de já mesclado: voltou a duplicar sozinho a cada mensagem.
        await registerLead(numLimpo);
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
        // reabre a conversa automaticamente se ela tinha sido finalizada. A
        // mensagem aparece JÁ (com o texto/selo do tipo) sem esperar a mídia
        // baixar — baixarMidiaRecebida pode levar bastante tempo (retentativas
        // + timeout, ver comentário na função), e segurar a exibição da
        // mensagem inteira até isso terminar deixava a conversa "atrasada" no
        // painel. A mídia entra depois, em background, atualizando o balão já
        // exibido assim que (e se) o download terminar.
        const textoExibir = transcricaoAudio ? `🎤 ${transcricaoAudio}` : (msg.body || TIPO_LABEL_FALLBACK[tipoMsg] || '[mensagem sem texto]');
        const idConversa = await salvarNaConversa(numLimpo, nomeContato, 'in', textoExibir, tipoMsg, msg.timestamp, false, null);
        if (msg.hasMedia && ['image', 'video', 'document', 'sticker'].includes(tipoMsg)) {
            baixarMidiaEAtualizarEmBackground(msg, idConversa, numLimpo);
        }

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

        // Mensagem "atrasada" (WhatsApp Web reenvia um lote de mensagens antigas
        // ao reconectar — reconhecido pelo próprio msg.timestamp, não pela hora
        // que chegou aqui): a conversa acima de já foi salva/fica visível pro
        // operador, mas o robô NÃO responde algo que o cliente mandou há muito
        // tempo — foi exatamente o bug relatado ("quando reconecta, o robô
        // responde mensagem antiga"), o WhatsApp Web sincronizando o histórico
        // como se fossem mensagens novas de verdade.
        const IDADE_MAXIMA_MSG_MS = 5 * 60 * 1000;
        if (msg.timestamp && (Date.now() - msg.timestamp * 1000) > IDADE_MAXIMA_MSG_MS) {
            console.log(`⏳ Mensagem antiga de ${numLimpo} (reenvio do WhatsApp ao reconectar) — robô não responde, só fica registrada.`);
            return;
        }

        // Conversa assumida manualmente por um humano (botão "Assumir Conversa"
        // em Conversas): tem prioridade sobre horário e sobre o override global
        // "Ativar Robô" — enquanto assumida, o robô nunca responde esse contato.
        // NÃO entra na rede de segurança de 180s abaixo de propósito: quem clicou
        // "Assumir Conversa" fica com controle total — foi exatamente um robô
        // atravessando uma conversa assim que motivou essa distinção.
        const assumidaPorHumano = await db.get('SELECT 1 FROM conversas_humano WHERE telefone = ?', numLimpo);
        if (assumidaPorHumano) return;

        // Modo Humano (Horário de Funcionamento): a mensagem já foi salva em
        // "conversas" (o operador pode responder manualmente pelo painel), e o
        // robô não dispara regras/IA na hora — MAS agenda uma rede de segurança:
        // se ninguém responder dentro do prazo configurado, o robô assume mesmo
        // fora da janela dele (ver agendarFallbackHumano).
        const { modo, mensagemHumano, timezone } = await obterModoAtual();
        if (modo === 'humano') {
            const hoje = moment.tz(timezone || 'America/Sao_Paulo').format('YYYY-MM-DD');
            if (mensagemHumano && ultimaMsgModoHumano.get(numLimpo) !== hoje) {
                const mensagemHumanoFinal = await substituirPlaceholdersPessoais(mensagemHumano, numLimpo);
                const sentHumano = await enviarResposta(msg, mensagemHumanoFinal);
                if (sentHumano) {
                    ultimaMsgModoHumano.set(numLimpo, hoje);
                    await registrarMensagemEnviada(telefoneReal, mensagemHumanoFinal, nomeContato, sentHumano.id?._serialized);
                }
            }
            await agendarFallbackHumano(msg, numLimpo, texto, telefoneReal, nomeContato);
            return;
        }

        await processarComoRobo(msg, numLimpo, texto, telefoneReal, nomeContato);
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

        // O WhatsApp Web reenvia reações "antigas" (backlog) toda vez que a
        // sessão resincroniza — sem dedup, a MESMA reação vira uma linha nova
        // a cada reconexão/redeploy. msgId+quem reagiu+o emoji identifica a
        // reação de forma estável (o mesmo evento reenviado tem essa mesma
        // combinação sempre).
        const chaveReacao = `${reaction.msgId?._serialized || ''}|${reaction.senderId || ''}|${reaction.reaction}`;
        const jaProcessada = await db.get('SELECT 1 FROM reacoes_processadas WHERE chave = ?', chaveReacao);
        if (jaProcessada) return;
        await db.run('INSERT OR IGNORE INTO reacoes_processadas (chave) VALUES (?)', chaveReacao);

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
    removerLocksChromeStale();
    armarInitWatchdog();
    client.initialize();
    await reidratarPoolNaInicializacao();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`🌐 Painel rodando em: http://localhost:${PORT}`));
})();

const shutdown = async () => {
    console.log('⏳ Desligando robô de forma segura...');
    await client.destroy();
    for (const entry of poolClients.values()) {
        if (entry.client) { try { await entry.client.destroy(); } catch (_) { } }
    }
    if (db) await db.close();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
