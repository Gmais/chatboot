// =====================================
// IMPORTAÇÕES
// =====================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const qrcode = require('qrcode');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const multer = require('multer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const OpenAI = require('openai');
const { buscarAlunoPorMatricula, buscarAlunoPorCodigo, obterParcelasEmAberto, criarCliente, matricularAluno } = require('./pacto');

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
    `);

    // Adiciona colunas novas se migrando de versão anterior
    try { await db.exec(`ALTER TABLE respostas ADD COLUMN media_path TEXT DEFAULT NULL`); } catch(e) {}
    try { await db.exec(`ALTER TABLE respostas ADD COLUMN media_tipo TEXT DEFAULT NULL`); } catch(e) {}

    const statRow = await db.get('SELECT * FROM stats WHERE id = 1');
    if (!statRow) await db.run('INSERT INTO stats (id, sent) VALUES (1, 0)');
    else stats.sent = statRow.sent;

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

async function updateStats(isSent) {
    if (isSent) { stats.sent++; await db.run('UPDATE stats SET sent = ? WHERE id = 1', stats.sent); }
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
// API REST — RESPOSTAS
// =====================================
app.get('/api/respostas', async (req, res) => {
    const r = await db.all('SELECT * FROM respostas ORDER BY ordem ASC');
    res.json(r);
});

app.post('/api/respostas', async (req, res) => {
    const { keywords, resposta, ordem, enviar_audio, media_path, media_tipo } = req.body;
    if (!keywords || !resposta) return res.status(400).json({ error: 'Campos obrigatórios.' });
    const result = await db.run(
        'INSERT INTO respostas (keywords, resposta, ativo, ordem, enviar_audio, media_path, media_tipo) VALUES (?, ?, 1, ?, ?, ?, ?)',
        [keywords, resposta, ordem || 99, enviar_audio ? 1 : 0, media_path || null, media_tipo || null]
    );
    const nova = await db.get('SELECT * FROM respostas WHERE id = ?', result.lastID);
    io.emit('respostas_updated');
    res.json(nova);
});

app.put('/api/respostas/:id', async (req, res) => {
    const { id } = req.params;
    const { keywords, resposta, ativo, ordem, enviar_audio, media_path, media_tipo } = req.body;
    await db.run(
        'UPDATE respostas SET keywords=?, resposta=?, ativo=?, ordem=?, enviar_audio=?, media_path=?, media_tipo=? WHERE id=?',
        [keywords, resposta, ativo !== undefined ? ativo : 1, ordem || 99, enviar_audio ? 1 : 0, media_path || null, media_tipo || null, id]
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
    const exitClean = () => { console.log('🔄 Reiniciando para gerar novo QR Code...'); process.exit(0); };
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
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, '.wwebjs_auth') }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--disable-extensions',
            '--disable-background-networking',
        ],
    },
});

let currentQR = null;
let isConnected = false;

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
    try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        currentQR = qrDataUrl;
        io.emit('qr', qrDataUrl);
    } catch (err) { console.error('Erro ao gerar QR:', err); }
});

client.on('ready', () => {
    console.log('✅ Tudo certo! WhatsApp conectado.');
    isConnected = true;
    currentQR = null;
    io.emit('ready');
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

    await client.sendMessage(telefone, texto);
}

async function identificarERresponder(telefone, matricula) {
    try {
        const aluno = await buscarAlunoPorMatricula(matricula);
        if (!aluno) {
            await client.sendMessage(telefone, `❌ Não encontrei nenhum aluno com a matrícula ${matricula}. Confira o número e tente de novo.`);
            return;
        }
        await saveVinculo(telefone, aluno);
        await enviarRespostaPacto(telefone, aluno);
    } catch (err) {
        console.error('❌ Erro ao consultar aluno na Pacto:', err.message);
        await client.sendMessage(telefone, '⚠️ Não consegui consultar seus dados agora. Tente novamente em alguns minutos.');
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
            await client.sendMessage(telefone, '❌ Não entendi. Envie apenas o número da sua matrícula.');
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
            await client.sendMessage(telefone, '⚠️ Não consegui consultar seus dados agora. Tente novamente em alguns minutos.');
        }
        return true;
    }

    global.pactoFlow.set(telefone, true);
    await client.sendMessage(telefone, '👋 Para te ajudar, me informe o número da sua matrícula na academia:');
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
        await client.sendMessage(telefone, `✅ Matrícula realizada com sucesso! Sua matrícula é *${cliente.matricula}*. Bem-vindo(a)!`);
    } catch (err) {
        console.error('❌ Erro ao matricular novo aluno na Pacto:', err.message);
        await client.sendMessage(telefone, '⚠️ Não consegui concluir sua matrícula agora. Por favor, fale com a recepção da academia.');
    }
}

// Conduz a conversa de cadastro+matrícula passo a passo. "textoOriginal" preserva
// maiúsculas/acentos do que o aluno digitou (nome e e-mail não devem ser lowercased).
async function handleCadastroFlow(telefone, texto, textoOriginal) {
    const estado = global.pactoCadastro.get(telefone);

    if (!estado) {
        if (!ehIntencaoMatricular(texto)) return false;
        global.pactoCadastro.set(telefone, { etapa: 'nome' });
        await client.sendMessage(telefone, '🏋️ Que ótimo que você quer treinar com a gente! Pra começar, me diga seu *nome completo*:');
        return true;
    }

    if (estado.etapa === 'nome') {
        estado.nome = textoOriginal.trim();
        estado.etapa = 'cpf';
        await client.sendMessage(telefone, 'Agora me informe seu *CPF* (somente números):');
        return true;
    }

    if (estado.etapa === 'cpf') {
        const cpf = texto.replace(/\D/g, '');
        if (cpf.length !== 11) {
            await client.sendMessage(telefone, '❌ CPF inválido. Envie os 11 números do seu CPF:');
            return true;
        }
        estado.cpf = cpf;
        estado.etapa = 'email';
        await client.sendMessage(telefone, 'Qual o seu *e-mail*? (ou digite *pular* se não quiser informar)');
        return true;
    }

    if (estado.etapa === 'email') {
        estado.email = texto === 'pular' ? '' : textoOriginal.trim();
        estado.etapa = 'confirmar';
        await client.sendMessage(telefone,
            `📋 Confere os seus dados:\n\nNome: ${estado.nome}\nCPF: ${estado.cpf}\nE-mail: ${estado.email || '(não informado)'}\n\n` +
            `Plano: Mensal — R$ ${process.env.PACTO_PLANO_VALOR_CONTRATO} + R$ ${process.env.PACTO_PLANO_VALOR_MATRICULA} de matrícula\n\n` +
            `Digite *CONFIRMAR* para finalizar ou *CANCELAR* para desistir.`
        );
        return true;
    }

    if (estado.etapa === 'confirmar') {
        global.pactoCadastro.delete(telefone);
        if (texto !== 'confirmar') {
            await client.sendMessage(telefone, '❌ Cadastro cancelado. Se quiser tentar de novo, é só me chamar.');
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

// Quando o WhatsApp usa @lid (privacidade), tenta obter o número real do contato.
async function resolvePhone(msg) {
    if (!msg.from.endsWith('@lid')) return msg.from;
    try {
        const contact = await Promise.race([
            msg.getContact(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
        ]);
        if (contact.number) return `${contact.number}@c.us`;
    } catch (_) {}
    return msg.from;
}

client.on('message', async (msg) => {
    try {
        if (!msg.from || msg.from.endsWith('@g.us') || msg.from === 'status@broadcast') return;
        const chat = await msg.getChat();
        if (chat.isGroup) return;

        const telefoneReal = await resolvePhone(msg);
        await registerLead(telefoneReal);
        const texto = msg.body ? msg.body.trim().toLowerCase() : '';

        console.log(`📨 Mensagem de ${telefoneReal}: "${msg.body}"`);

        if (await handleCadastroFlow(telefoneReal, texto, msg.body || '')) {
            await updateStats(true);
            return;
        }

        if (await handlePactoFlow(telefoneReal, texto)) {
            await updateStats(true);
            return;
        }

        const regras = await db.all('SELECT * FROM respostas WHERE ativo = 1 ORDER BY ordem ASC');
        let regraAtiva = null;
        for (const regra of regras) {
            const keywords = regra.keywords.split(',').map(k => k.trim().toLowerCase());
            if (keywords.some(kw => texto.includes(kw))) { regraAtiva = regra; break; }
        }

        if (!regraAtiva) {
            // Se não encontrou regra, tenta a IA
            const confRows = await db.all('SELECT * FROM configuracoes');
            const config = {};
            confRows.forEach(r => config[r.chave] = r.valor);

            const provider  = config.ia_provider || 'openai';
            const iaAtiva   = config.openai_status === 'true';
            const apiKey    = provider === 'groq' ? config.groq_api_key : config.openai_api_key;
            const modelo    = provider === 'groq'
                ? (config.groq_modelo || 'llama-3.1-8b-instant')
                : (config.openai_modelo || 'gpt-3.5-turbo');

            if (iaAtiva && apiKey) {
                await chat.sendStateTyping();

                if (!global.chatHistory) global.chatHistory = new Map();
                const history = global.chatHistory.get(telefoneReal) || [];

                if (history.length === 0 && config.openai_treinamento) {
                    history.push({ role: 'system', content: config.openai_treinamento });
                }

                history.push({ role: 'user', content: texto });

                try {
                    const openai = new OpenAI({
                        apiKey,
                        ...(provider === 'groq' && { baseURL: 'https://api.groq.com/openai/v1' })
                    });
                    const completion = await openai.chat.completions.create({
                        messages: history,
                        model: modelo,
                        max_tokens: 300
                    });

                    const respostaIA = completion.choices[0].message.content;
                    history.push({ role: 'assistant', content: respostaIA });

                    if (history.length > 7) {
                        const sys = history.shift();
                        history.shift();
                        history.shift();
                        history.unshift(sys);
                    }
                    global.chatHistory.set(telefoneReal, history);

                    console.log(`🤖 IA respondendo para ${telefoneReal}`);
                    await client.sendMessage(telefoneReal, respostaIA);
                    await updateStats(true);
                } catch (e) {
                    console.error(`❌ Erro na API da IA (${provider}):`, e.message);
                }
            }
            return;
        }

        await delay(1500);
        await chat.sendStateTyping();
        await delay(2000);

        const hora = new Date().getHours();
        let saudacao = 'Olá';
        if (hora >= 5 && hora < 12) saudacao = 'Bom dia';
        else if (hora >= 12 && hora < 18) saudacao = 'Boa tarde';
        else saudacao = 'Boa noite';

        const textoFinal = regraAtiva.resposta.replace(/{saudacao}/g, saudacao);
        console.log(`📤 Regra #${regraAtiva.id} ativada → respondendo para ${telefoneReal}`);
        await client.sendMessage(telefoneReal, textoFinal);

        // Envia Áudio de Voz (audio_vendas.ogg)
        if (regraAtiva.enviar_audio) {
            const audioPath = path.join(__dirname, 'audio_vendas.ogg');
            if (fs.existsSync(audioPath)) {
                await chat.sendStateRecording();
                await delay(3000);
                const audioMedia = MessageMedia.fromFilePath(audioPath);
                await client.sendMessage(telefoneReal, audioMedia, { sendAudioAsVoice: true });
            }
        }

        // Envia Mídia (Imagem, Vídeo, Arquivo)
        if (regraAtiva.media_path) {
            const mediaFullPath = path.join(__dirname, 'public', regraAtiva.media_path.replace(/^\//, ''));
            if (fs.existsSync(mediaFullPath)) {
                await delay(500);
                const media = MessageMedia.fromFilePath(mediaFullPath);
                await client.sendMessage(telefoneReal, media);
            }
        }

        await updateStats(true);
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
