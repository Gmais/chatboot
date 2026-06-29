// =====================================
// IMPORTAÇÕES
// =====================================
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

const DEFAULT_RESPONSE_TEXT = `{saudacao}! 👋\n\nEssa mensagem foi enviada automaticamente pelo robô 🤖\n\nNa versão PRO você vai além: desbloqueie tudo!.\n\n✍️ Envio de textos\n🎙️ Áudios\n🖼️ Imagens\n🎥 Vídeos\n📂 Arquivos\n\n💡 Simulação de "digitando..." e "gravando áudio"\n🚀 Envio de mensagens em massa\n📇 Captura automática de contatos\n💻 Aprenda como deixar o robô funcionando 24 hrs, com o PC desligado\n✅ E 3 Bônus exclusivos\n\n🔥 Adquira a versão PRO agora: https://pay.kiwify.com.br/FkTOhRZ?src=pro`;

async function initDB() {
    db = await open({ filename: './database.sqlite', driver: sqlite3.Database });

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
        ...leads.map(l => `${l.telefone.replace('@c.us','')},${l.data_captura},${l.mensagens_recebidas}`)
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

// =====================================
// CONFIGURAÇÃO DO CLIENTE WHATSAPP
// =====================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
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
// FUNIL DE MENSAGENS — DINÂMICO
// =====================================
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

client.on('message', async (msg) => {
    try {
        if (!msg.from || msg.from.endsWith('@g.us')) return;
        const chat = await msg.getChat();
        if (chat.isGroup) return;

        await registerLead(msg.from);
        const texto = msg.body ? msg.body.trim().toLowerCase() : '';

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

            if (config.openai_status === 'true' && config.openai_api_key) {
                await chat.sendStateTyping();
                
                if (!global.chatHistory) global.chatHistory = new Map();
                const history = global.chatHistory.get(msg.from) || [];
                
                if (history.length === 0 && config.openai_treinamento) {
                    history.push({ role: 'system', content: config.openai_treinamento });
                }
                
                history.push({ role: 'user', content: texto });
                
                try {
                    const openai = new OpenAI({ apiKey: config.openai_api_key });
                    const completion = await openai.chat.completions.create({
                        messages: history,
                        model: config.openai_modelo || 'gpt-3.5-turbo',
                        max_tokens: 300
                    });
                    
                    const respostaIA = completion.choices[0].message.content;
                    history.push({ role: 'assistant', content: respostaIA });
                    
                    if (history.length > 7) {
                        const sys = history.shift(); // remove system
                        history.shift(); // remove older
                        history.shift();
                        history.unshift(sys); // put system back
                    }
                    global.chatHistory.set(msg.from, history);
                    
                    await client.sendMessage(msg.from, respostaIA);
                    await updateStats(true);
                } catch (e) {
                    console.error('❌ Erro na API da OpenAI:', e.message);
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
        await client.sendMessage(msg.from, textoFinal);

        // Envia Áudio de Voz (audio_vendas.ogg)
        if (regraAtiva.enviar_audio) {
            const audioPath = path.join(__dirname, 'audio_vendas.ogg');
            if (fs.existsSync(audioPath)) {
                await chat.sendStateRecording();
                await delay(3000);
                const audioMedia = MessageMedia.fromFilePath(audioPath);
                await client.sendMessage(msg.from, audioMedia, { sendAudioAsVoice: true });
            }
        }

        // Envia Mídia (Imagem, Vídeo, Arquivo)
        if (regraAtiva.media_path) {
            const mediaFullPath = path.join(__dirname, 'public', regraAtiva.media_path.replace(/^\//, ''));
            if (fs.existsSync(mediaFullPath)) {
                await delay(500);
                const media = MessageMedia.fromFilePath(mediaFullPath);
                await client.sendMessage(msg.from, media);
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
