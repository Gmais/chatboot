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

// =====================================
// BANCO DE DADOS (SQLite)
// =====================================
let db;
let stats = { received: 0, sent: 0, leads: 0 };
const leadsSet = new Set();

// Em produção (Railway), aponta para o volume persistente; localmente, usa a pasta do projeto.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = path.join(DATA_DIR, 'database.sqlite');

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
    `);

    // Adiciona colunas novas se migrando de versão anterior
    try { await db.exec(`ALTER TABLE respostas ADD COLUMN media_path TEXT DEFAULT NULL`); } catch(e) {}
    try { await db.exec(`ALTER TABLE respostas ADD COLUMN media_tipo TEXT DEFAULT NULL`); } catch(e) {}
    try { await db.exec(`ALTER TABLE respostas ADD COLUMN etiqueta_id INTEGER DEFAULT NULL`); } catch(e) {}
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
    return num;
}

// Salva mensagem na tabela de conversas (in ou out) e emite evento Socket.IO
async function salvarNaConversa(telefone, nome, direcao, texto, tipo = 'text') {
    const num = telefone.replace('@c.us','').replace('@lid','');
    const ts = new Date().toISOString();
    const lida = direcao === 'out' ? 1 : 0;
    await db.run(
        'INSERT INTO conversas (telefone, nome, direcao, texto, tipo, ts, lida) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [num, nome || num, direcao, texto, tipo, ts, lida]
    );
    // Conta não lidas deste telefone
    const naoLidas = await db.get('SELECT COUNT(*) as c FROM conversas WHERE telefone=? AND lida=0 AND direcao="in"', num);
    io.emit('nova_mensagem', { telefone: num, nome: nome || num, texto, direcao, tipo, ts, nao_lidas: naoLidas.c });
}

// Registra no histórico permanente cada mensagem realmente enviada pelo robô.
// É a única fonte da contagem "Mensagens Enviadas" — se está no contador, está nesta tabela.
async function registrarMensagemEnviada(telefone, texto, nome) {
    const numeroLimpo = telefone.replace('@c.us', '').replace('@lid', '');
    await db.run('INSERT INTO mensagens_enviadas (telefone, texto) VALUES (?, ?)', [numeroLimpo, texto]);
    stats.sent++;
    await salvarNaConversa(numeroLimpo, nome, 'out', texto, 'text');
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
    res.json(leads);
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
        const leads = await db.all('SELECT telefone, data_captura, mensagens_recebidas FROM leads ORDER BY data_captura DESC');
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

        const contatos = leads.map(l => {
            const telefone = l.telefone.replace('@c.us', '').replace('@lid', '');
            return {
                telefone,
                nome: nomePorTelefone.get(telefone) || telefone,
                data_captura: l.data_captura,
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
    const { nome, cor } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome da etiqueta é obrigatório.' });
    try {
        const result = await db.run('INSERT INTO etiquetas (nome, cor) VALUES (?, ?)', [nome.trim(), cor || '#25D366']);
        const nova = await db.get('SELECT *, 0 AS total_contatos FROM etiquetas WHERE id = ?', result.lastID);
        io.emit('etiquetas_atualizadas');
        res.json(nova);
    } catch (err) {
        res.status(400).json({ error: err.message.includes('UNIQUE') ? 'Já existe uma etiqueta com esse nome.' : err.message });
    }
});

app.put('/api/etiquetas/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, cor } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome da etiqueta é obrigatório.' });
    try {
        await db.run('UPDATE etiquetas SET nome = ?, cor = ? WHERE id = ?', [nome.trim(), cor || '#25D366', id]);
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
    await db.run('DELETE FROM etiquetas WHERE id = ?', id);
    io.emit('etiquetas_atualizadas');
    res.json({ success: true });
});

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
    await db.run('INSERT OR IGNORE INTO contato_etiquetas (telefone, etiqueta_id) VALUES (?, ?)', [telefone, etiqueta_id]);
    io.emit('etiqueta_atualizada', { telefone });
    res.json({ success: true });
});

app.delete('/api/contatos/:telefone/etiquetas/:etiquetaId', async (req, res) => {
    const { telefone, etiquetaId } = req.params;
    await db.run('DELETE FROM contato_etiquetas WHERE telefone = ? AND etiqueta_id = ?', [telefone, etiquetaId]);
    io.emit('etiqueta_atualizada', { telefone });
    res.json({ success: true });
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
// API REST — CONVERSAS (GERENCIADOR)
// =====================================

// Lista todas as conversas (uma por contato, com o último texto e count de não lidas)
app.get('/api/conversas', async (req, res) => {
    try {
        const conversas = await db.all(`
            SELECT
                c.telefone,
                c.nome,
                c.texto AS ultimo_texto,
                c.direcao AS ultima_direcao,
                c.tipo AS ultimo_tipo,
                c.ts AS ultimo_ts,
                (SELECT COUNT(*) FROM conversas WHERE telefone = c.telefone AND lida = 0 AND direcao = 'in') AS nao_lidas,
                (CASE WHEN ch.telefone IS NULL THEN 0 ELSE 1 END) AS assumida_humano
            FROM conversas c
            INNER JOIN (
                SELECT telefone, MAX(ts) AS max_ts
                FROM conversas
                GROUP BY telefone
            ) latest ON c.telefone = latest.telefone AND c.ts = latest.max_ts
            LEFT JOIN conversas_humano ch ON ch.telefone = c.telefone
            GROUP BY c.telefone
            ORDER BY c.ts DESC
            LIMIT 200
        `);
        res.json(conversas);
    } catch(err) {
        console.error('Erro /api/conversas:', err.message);
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
        res.json(msgs);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Envia mensagem manual pelo dashboard para um contato
app.post('/api/conversas/:telefone/enviar', async (req, res) => {
    const { telefone } = req.params;
    const { texto } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ error: 'Texto obrigatório.' });
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp não está conectado.' });
    try {
        const chatId = telefone.includes('@') ? telefone : `${telefone}@c.us`;
        await client.sendMessage(chatId, texto.trim());
        const nome = await resolverNomeContato(telefone);
        await registrarMensagemEnviada(telefone, texto.trim(), nome);
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

// =====================================
// API REST — BROADCAST (DISPAROS EM MASSA)
// =====================================
let broadcastRunning = false;
let broadcastProgress = { total: 0, sent: 0, failed: 0, running: false };

app.get('/api/broadcast/status', (req, res) => res.json(broadcastProgress));

app.post('/api/broadcast/start', upload.single('media'), async (req, res) => {
    if (broadcastRunning) return res.status(400).json({ error: 'Um disparo já está em andamento.' });
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp não está conectado.' });

    const { numeros, mensagem, delay_ms } = req.body;
    const listaNumeros = numeros.split('\n').map(n => n.trim().replace(/\D/g, '')).filter(n => n.length >= 10);

    if (listaNumeros.length === 0) return res.status(400).json({ error: 'Nenhum número válido encontrado.' });
    if (!mensagem) return res.status(400).json({ error: 'Mensagem obrigatória.' });

    const mediaFile = req.file ? { path: req.file.path, mimetype: req.file.mimetype, filename: req.file.originalname } : null;
    const delayMs = parseInt(delay_ms) || 5000;

    broadcastRunning = true;
    broadcastProgress = { total: listaNumeros.length, sent: 0, failed: 0, running: true };
    io.emit('broadcast_progress', broadcastProgress);

    res.json({ success: true, total: listaNumeros.length });

    // Executa o broadcast de forma assíncrona
    (async () => {
        for (const numero of listaNumeros) {
            if (!broadcastRunning) break;
            try {
                const chatId = numero.startsWith('55') ? `${numero}@c.us` : `55${numero}@c.us`;
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
            await delay(delayMs);
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
            '--single-process',                          // Evita processos filho — economiza ~150MB no Railway
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
            '--disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process',
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
            '--disable-web-security',
            '--memory-pressure-off',
            '--disable-low-res-tiling',
            '--disable-smooth-scrolling',
            '--process-per-site',
            '--js-flags=--max-old-space-size=256 --optimize-for-size --gc-interval=100',
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
        socket.emit('all_leads', allLeads);

        const allMensagensEnviadas = await db.all('SELECT * FROM mensagens_enviadas ORDER BY id DESC LIMIT 200');
        socket.emit('all_mensagens_enviadas', allMensagensEnviadas);

        // Envia lista de conversas para popular o gerenciador
        try {
            const conversas = await db.all(`
                SELECT c.telefone, c.nome, c.texto AS ultimo_texto, c.direcao AS ultima_direcao,
                       c.tipo AS ultimo_tipo, c.ts AS ultimo_ts,
                       (SELECT COUNT(*) FROM conversas WHERE telefone = c.telefone AND lida = 0 AND direcao = 'in') AS nao_lidas,
                       (CASE WHEN ch.telefone IS NULL THEN 0 ELSE 1 END) AS assumida_humano
                FROM conversas c
                INNER JOIN (SELECT telefone, MAX(ts) AS max_ts FROM conversas GROUP BY telefone) latest
                    ON c.telefone = latest.telefone AND c.ts = latest.max_ts
                LEFT JOIN conversas_humano ch ON ch.telefone = c.telefone
                GROUP BY c.telefone
                ORDER BY c.ts DESC LIMIT 200
            `);
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
    await registrarMensagemEnviada(telefone, typeof conteudo === 'string' ? conteudo : '[mídia]');
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
async function resolvePhone(msg) {
    if (!msg.from.endsWith('@lid')) return msg.from;
    if (lidParaTelefone.has(msg.from)) return lidParaTelefone.get(msg.from);
    try {
        const [{ pn } = {}] = await Promise.race([
            client.getContactLidAndPhone([msg.from]),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
        ]);
        if (pn) {
            lidParaTelefone.set(msg.from, pn);
            return pn;
        }
    } catch (_) {}
    return msg.from;
}

// Debug: loga todos os eventos de mensagem (fromMe e recebidas)
client.on('message_create', (msg) => {
    const dir = msg.fromMe ? '→ ENVIADA' : '← RECEBIDA';
    if (msg.from !== 'status@broadcast') {
        console.log(`🔍 [DEBUG] ${dir} from=${msg.from} body="${(msg.body||'[sem texto]').slice(0,40)}"`);
    }
});// =====================================
// ENGINE DE FLUXOS (Flow Builder)
// =====================================

async function engineExecutarFluxo(telefoneReal, numLimpo, nomeContato, fluxoId, startNodeId) {
    const fluxo = await db.get('SELECT * FROM fluxos WHERE id = ?', fluxoId);
    if (!fluxo) return;
    
    let nodes = [];
    try { nodes = JSON.parse(fluxo.flow_data); } catch(e) { return; }
    
    let currentNodeId = startNodeId;
    
    while (currentNodeId) {
        const node = nodes.find(n => n.id === currentNodeId);
        if (!node) {
            await db.run('DELETE FROM contato_estado_fluxo WHERE telefone = ?', telefoneReal);
            break;
        }
        
        await db.run(
            'INSERT OR REPLACE INTO contato_estado_fluxo (telefone, fluxo_id, current_node_id) VALUES (?, ?, ?)', 
            [telefoneReal, fluxoId, currentNodeId]
        );

        if (node.type === 'message') {
            if (node.data.text) {
                const txt = node.data.text.replace(/\{nome\}|\[nome\]/gi, nomeContato);
                await simularDigitando(client.getChatById(telefoneReal));
                await delay(calcularDelayDigitacao(txt));
                await client.sendMessage(telefoneReal, txt);
                await registrarMensagemEnviada(telefoneReal, txt, nomeContato);
            }
            currentNodeId = node.data.next || null;
        } 
        else if (node.type === 'delay') {
            const segs = parseInt(node.data.delaySeconds) || 1;
            await delay(segs * 1000);
            currentNodeId = node.data.next || null;
        }
        else if (node.type === 'media') {
            if (node.data.mediaUrl) {
                const mediaPath = path.join(__dirname, 'public', node.data.mediaUrl);
                if (fs.existsSync(mediaPath)) {
                    const MessageMedia = require('whatsapp-web.js').MessageMedia;
                    const media = MessageMedia.fromFilePath(mediaPath);
                    const cap = node.data.text ? node.data.text.replace(/\{nome\}|\[nome\]/gi, nomeContato) : '';
                    await client.sendMessage(telefoneReal, media, { caption: cap });
                    await registrarMensagemEnviada(telefoneReal, cap || '[Mídia]', nomeContato);
                }
            }
            currentNodeId = node.data.next || null;
        }
        else if (node.type === 'question') {
            let txt = (node.data.text || '').replace(/\{nome\}|\[nome\]/gi, nomeContato) + '\n';
            if (node.data.options && node.data.options.length > 0) {
                txt += '\n' + node.data.options.map((opt, i) => `${i+1} - ${opt.label}`).join('\n');
            }
            await simularDigitando(client.getChatById(telefoneReal));
            await delay(calcularDelayDigitacao(txt));
            await client.sendMessage(telefoneReal, txt);
            await registrarMensagemEnviada(telefoneReal, txt, nomeContato);
            break; // PARA E ESPERA O USUÁRIO RESPONDER
        }
        else if (node.type === 'action') {
            if (node.data.actionType === 'add_tag') {
                await aplicarEtiquetaContato(numLimpo, node.data.tagId);
            } else if (node.data.actionType === 'remove_tag') {
                await removerEtiquetaContato(numLimpo, node.data.tagId);
            }
            currentNodeId = node.data.next || null;
        }
        else {
            currentNodeId = node.data.next || null;
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
    
    let nodes = [];
    try { nodes = JSON.parse(fluxo.flow_data); } catch(e) { return false; }
    
    const node = nodes.find(n => n.id === estado.current_node_id);
    if (!node || node.type !== 'question') {
        await engineExecutarFluxo(telefoneReal, numLimpo, nomeContato, estado.fluxo_id, node ? node.data.next : null);
        return true; 
    }
    
    let optionMatch = null;
    const msg = textoMensagem.trim().toLowerCase();
    const opts = node.data.options || [];
    
    for (let i = 0; i < opts.length; i++) {
        if (msg === (i+1).toString() || msg === opts[i].label.toLowerCase()) {
            optionMatch = opts[i];
            break;
        }
    }
    
    if (optionMatch) {
        await engineExecutarFluxo(telefoneReal, numLimpo, nomeContato, estado.fluxo_id, optionMatch.target);
    } else {
        await client.sendMessage(telefoneReal, 'Opção inválida, por favor digite o número correto da opção.');
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
        const chat = await msg.getChat();
        if (chat.isGroup) return;

        // Usa o ID interno do chat para envio — funciona com @lid e @c.us
        const replyTo    = chat.id._serialized;
        const telefoneReal = await resolvePhone(msg);  // número limpo para salvar no banco
        const numLimpo = telefoneReal.replace('@c.us','').replace('@lid','');

        // Tenta obter o nome do contato (pushname ou nome da agenda)
        let nomeContato = numLimpo;
        try {
            const contact = await Promise.race([
                msg.getContact(),
                new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2500))
            ]);
            nomeContato = contact.pushname || contact.name || contact.number || numLimpo;
            nomeContatos.set(numLimpo, nomeContato);
        } catch(_) {}

        await registerLead(telefoneReal);
        let texto = msg.body ? msg.body.trim().toLowerCase() : '';

        // Determina tipo da mensagem
        let tipoMsg = 'text';
        if (msg.type === 'image') tipoMsg = 'image';
        else if (msg.type === 'audio' || msg.type === 'ptt') tipoMsg = 'audio';
        else if (msg.type === 'video') tipoMsg = 'video';
        else if (msg.type === 'document') tipoMsg = 'document';
        else if (msg.type === 'sticker') tipoMsg = 'sticker';

        // Áudio/nota de voz: transcreve via Whisper para o robô conseguir entender
        // e responder normalmente (regras exatas e IA). Sem API key configurada,
        // transcreverAudio() retorna null e a mensagem segue como antes (sem texto).
        let transcricaoAudio = null;
        if (tipoMsg === 'audio' && !texto) {
            transcricaoAudio = await transcreverAudio(msg);
            if (transcricaoAudio) texto = transcricaoAudio.trim().toLowerCase();
        }

        // Salva na tabela de conversas (mensagens recebidas)
        const textoExibir = transcricaoAudio ? `🎤 ${transcricaoAudio}` : (msg.body || `[${tipoMsg}]`);
        await salvarNaConversa(numLimpo, nomeContato, 'in', textoExibir, tipoMsg);

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
                    await registrarMensagemEnviada(telefoneReal, mensagemHumano, nomeContato);
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
                    let nodes = [];
                    try { nodes = JSON.parse(fluxo.flow_data); } catch(e) {}
                    const initialNode = nodes.length > 0 ? nodes[0].id : null;
                    if (initialNode) {
                        await engineExecutarFluxo(telefoneReal, numLimpo, nomeContato, fluxo.id, initialNode);
                        fluxoIniciado = true;
                        break;
                    }
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
                    if (sentIA) await registrarMensagemEnviada(telefoneReal, respostaIA, nomeContato);
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
        const textoFinal = regraAtiva.resposta
            .replace(/{saudacao}/g, saudacao)
            .replace(/\[nome\]/gi, nomeExibir || '')
            .replace(/{nome}/gi, nomeExibir || '');
        console.log(`📤 Regra #${regraAtiva.id} ativada → respondendo para ${numLimpo}`);

        // Aplica automaticamente a etiqueta configurada nesta regra (se houver)
        if (regraAtiva.etiqueta_id) {
            await db.run('INSERT OR IGNORE INTO contato_etiquetas (telefone, etiqueta_id) VALUES (?, ?)', [numLimpo, regraAtiva.etiqueta_id]);
            io.emit('etiqueta_atualizada', { telefone: numLimpo });
        }

        const sent = await enviarResposta(msg, textoFinal);
        io.emit('bot_digitando', { telefone: numLimpo, ativo: false });
        if (sent) await registrarMensagemEnviada(telefoneReal, textoFinal, nomeContato);

        // Áudio temporariamente desativado (causa timeout no Puppeteer)
        // if (regraAtiva.enviar_audio) { ... }

        if (regraAtiva.media_path) {
            const mediaFullPath = path.join(__dirname, 'public', regraAtiva.media_path.replace(/^\//, ''));
            if (fs.existsSync(mediaFullPath)) {
                await delay(500);
                const media = MessageMedia.fromFilePath(mediaFullPath);
                const sentMedia = await enviarResposta(msg, media);
                if (sentMedia) await registrarMensagemEnviada(telefoneReal, '[mídia enviada]', nomeContato);
            }
        }
    } catch (error) {
        console.error('❌ Erro no processamento da mensagem:', error);
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
