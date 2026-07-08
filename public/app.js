// =====================================
// SOCKET.IO
// =====================================
const socket = io();

// =====================================
// TOAST NOTIFICATIONS
// =====================================
function showToast(title, msg, type = 'success', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const icons = { success: '🟢', error: '🔴', info: '🔵' };
    const toast = document.createElement('div');
    toast.className = `toast ${type !== 'success' ? type : ''}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || '🟢'}</span>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            ${msg ? `<div class="toast-msg">${msg}</div>` : ''}
        </div>
    `;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'none';
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(30px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// =====================================
// ACTIVITY FEED
// =====================================
const activityFeed = document.getElementById('activity-feed');

function addActivity(icon, text, subtext) {
    if (!activityFeed) return;
    // Remove "Nenhuma atividade"
    if (activityFeed.querySelector('p')) activityFeed.innerHTML = '';

    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;gap:.7rem;padding:.6rem;background:rgba(255,255,255,0.025);border-radius:8px;animation:fadeIn .3s ease';
    item.innerHTML = `
        <span style="font-size:1.1rem;flex-shrink:0">${icon}</span>
        <div style="flex:1;min-width:0">
            <div style="font-size:.83rem;font-weight:500;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${text}</div>
            <div style="font-size:.74rem;color:var(--text-3)">${subtext}</div>
        </div>
    `;
    activityFeed.insertBefore(item, activityFeed.firstChild);

    // Máximo 6 itens
    while (activityFeed.children.length > 6) {
        activityFeed.removeChild(activityFeed.lastChild);
    }
}

// =====================================
// COUNTER ANIMATION
// =====================================
function animateCounter(el, target) {
    if (!el) return;
    const current = parseInt(el.textContent) || 0;
    if (current === target) return;
    const diff = target - current;
    const steps = Math.min(Math.abs(diff), 20);
    const stepVal = diff / steps;
    let count = 0;
    const interval = setInterval(() => {
        count++;
        el.textContent = Math.round(current + stepVal * count);
        if (count >= steps) {
            el.textContent = target;
            clearInterval(interval);
        }
    }, 30);
}

// =====================================
// DOM REFS
// =====================================
const qrContainer     = document.getElementById('qr-container');
const statusText      = document.getElementById('status-text');
const statusBadge     = document.getElementById('status-badge');
const sidebarDot      = document.getElementById('sidebar-dot');
const sidebarStatus   = document.getElementById('sidebar-status');
const msgReceivedEl   = document.getElementById('msg-received');
const msgSentEl       = document.getElementById('msg-sent');
const leadsCountEl    = document.getElementById('leads-count');
const btnDisconnect   = document.getElementById('btn-disconnect');

// =====================================
// WHATSAPP SOCKET EVENTS
// =====================================
socket.on('loading', (msg) => {
    if (qrContainer) qrContainer.innerHTML = `<span style="color:#666;font-size:.85rem">⏳ ${msg}</span>`;
    if (statusText) statusText.textContent = 'Iniciando conexão...';
    setBadge('loading');
});

const pairingSection     = document.getElementById('pairing-section');
const pairingCodeDisplay = document.getElementById('pairing-code-display');
const pairingCodeValue   = document.getElementById('pairing-code-value');
const pairingPhone       = document.getElementById('pairing-phone');
const btnPairing         = document.getElementById('btn-pairing');

socket.on('qr', (qrDataUrl) => {
    if (qrContainer) qrContainer.innerHTML = `<img src="${qrDataUrl}" alt="QR Code">`;
    if (statusText) statusText.textContent = '📲 Escaneie com o WhatsApp';
    setBadge('waiting');
    if (pairingSection) pairingSection.style.display = 'block';
    showToast('QR Code Pronto', 'Escaneie ou use o código abaixo', 'info');
});

socket.on('ready', () => {
    if (qrContainer) qrContainer.innerHTML = `<div style="font-size:3.5rem;text-align:center">✅<br><span style="font-size:1rem;font-weight:600;color:#25D366">Conectado!</span></div>`;
    if (statusText) { statusText.textContent = 'WhatsApp Online'; statusText.style.color = 'var(--green)'; }
    setBadge('online');
    if (pairingSection) pairingSection.style.display = 'none';
    if (pairingCodeDisplay) pairingCodeDisplay.style.display = 'none';
    addActivity('✅', 'WhatsApp conectado', 'Robô ativo e pronto para responder');
    showToast('WhatsApp Conectado!', 'Seu robô está ativo e monitorando mensagens', 'success');
});

socket.on('disconnected', () => {
    if (qrContainer) qrContainer.innerHTML = `<span style="color:#ef4444;font-size:.85rem">❌ Desconectado</span>`;
    if (statusText) { statusText.textContent = 'WhatsApp Offline'; statusText.style.color = 'var(--red)'; }
    setBadge('offline');
    if (pairingSection) pairingSection.style.display = 'none';
    showToast('Desconectado', 'O WhatsApp foi desconectado. Reinicie o servidor.', 'error');
});

btnPairing?.addEventListener('click', async () => {
    const phone = pairingPhone?.value.trim().replace(/\D/g, '');
    if (!phone || phone.length < 10) {
        showToast('Número inválido', 'Digite o número com DDD e código do país. Ex: 5542999222857', 'error');
        return;
    }
    btnPairing.disabled = true;
    btnPairing.textContent = 'Aguarde...';
    try {
        const res = await fetch('/api/pairing-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telefone: phone })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao gerar código');
        if (pairingCodeValue) pairingCodeValue.textContent = data.code;
        if (pairingCodeDisplay) pairingCodeDisplay.style.display = 'block';
        showToast('Código gerado! ✅', `Código: ${data.code} — Digite no WhatsApp em Dispositivos vinculados`, 'success', 12000);
    } catch (err) {
        // Se o código já estava visível, mantém — não esconde em caso de erro
        const errorMsg = err.message && err.message.length > 3 ? err.message : 'Clique em Gerar código novamente quando aparecer um novo QR';
        showToast('Tente novamente', errorMsg, 'error');
    } finally {
        btnPairing.disabled = false;
        btnPairing.textContent = 'Gerar código';
    }
});

function setBadge(state) {
    if (!statusBadge) return;
    const states = {
        loading:  { text: '● Iniciando...', cls: '', dot: '', label: 'Iniciando...' },
        waiting:  { text: '● Aguardando QR', cls: '', dot: '', label: 'Aguardando QR' },
        online:   { text: '● Conectado', cls: 'connected', dot: 'online', label: 'Online' },
        offline:  { text: '● Desconectado', cls: 'disconnected', dot: 'offline', label: 'Offline' },
    };
    const s = states[state] || states.loading;
    statusBadge.textContent = s.text;
    statusBadge.className = `status-badge ${s.cls}`;
    if (sidebarDot) sidebarDot.className = `dot ${s.dot}`;
    if (sidebarStatus) sidebarStatus.textContent = s.label;

    if (btnDisconnect) {
        btnDisconnect.style.display = state === 'online' ? 'block' : 'none';
    }
}

socket.on('stats', (stats) => {
    animateCounter(msgReceivedEl, stats.received);
    animateCounter(msgSentEl, stats.sent);
    animateCounter(leadsCountEl, stats.leads);
});

// =====================================
// FEED DE CONVERSAS AO VIVO
// =====================================
const liveFeed      = document.getElementById('live-feed');
const liveFeedEmpty = document.getElementById('live-feed-empty');
const btnLimparFeed = document.getElementById('btn-limpar-feed');
let msgReceivedCount = 0;
let msgSentCount = 0;

function addFeedMessage(type, phone, text, ts) {
    if (!liveFeed) return;
    if (liveFeedEmpty) liveFeedEmpty.style.display = 'none';

    const isIn = type === 'in';
    const time = new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const shortPhone = phone.replace('@c.us','').replace('@lid','').replace(/^55/, '');
    const preview = text ? (text.length > 120 ? text.slice(0, 120) + '…' : text) : '';

    const div = document.createElement('div');
    div.style.cssText = `
        display:flex; align-items:flex-start; gap:.5rem;
        ${isIn ? 'flex-direction:row' : 'flex-direction:row-reverse'};
        animation:fadeIn .25s ease;
    `;
    div.innerHTML = `
        <span style="font-size:1.1rem;flex-shrink:0;margin-top:.1rem">${isIn ? '📲' : '🤖'}</span>
        <div style="
            max-width:75%; padding:.5rem .75rem; border-radius:10px; font-size:.8rem;
            background:${isIn ? 'rgba(255,255,255,0.06)' : 'rgba(37,211,102,0.12)'};
            border:1px solid ${isIn ? 'rgba(255,255,255,0.08)' : 'rgba(37,211,102,0.2)'};
        ">
            <div style="font-size:.7rem;color:var(--text-3);margin-bottom:.2rem">
                ${isIn ? `<strong style="color:var(--text-2)">${shortPhone}</strong>` : '<strong style="color:var(--green)">Robô</strong>'}
                <span style="margin-left:.4rem">${time}</span>
            </div>
            <div style="color:var(--text-1);word-break:break-word">${preview}</div>
        </div>
    `;
    liveFeed.appendChild(div);
    liveFeed.scrollTop = liveFeed.scrollHeight;

    // Mantém apenas as últimas 50 mensagens no feed
    while (liveFeed.children.length > 51) liveFeed.removeChild(liveFeed.children[1]);
}

socket.on('message_in', ({ from, text, ts }) => {
    addFeedMessage('in', from, text, ts);
    msgReceivedCount++;
    if (msgReceivedEl) animateCounter(msgReceivedEl, parseInt(msgReceivedEl.textContent.replace(/\D/g,'') || 0) + 1);
});

socket.on('message_out', ({ to, text, ts }) => {
    addFeedMessage('out', to, text, ts);
    msgSentCount++;
    if (msgSentEl) animateCounter(msgSentEl, parseInt(msgSentEl.textContent.replace(/\D/g,'') || 0) + 1);
    addMensagemEnviadaToTable(to, text, ts);
});

// =====================================
// HISTÓRICO DE MENSAGENS ENVIADAS
// =====================================
const mensagensEnviadasTableBody = document.getElementById('mensagens-enviadas-table-body');

function addMensagemEnviadaToTable(telefone, texto, ts) {
    if (!mensagensEnviadasTableBody) return;
    if (mensagensEnviadasTableBody.querySelector('td[colspan]')) mensagensEnviadasTableBody.innerHTML = '';
    const tr = document.createElement('tr');
    const fmt = new Date(ts).toLocaleString('pt-BR');
    const num = telefone.replace('@c.us', '').replace('@lid', '');
    const preview = texto && texto.length > 140 ? texto.slice(0, 140) + '…' : (texto || '');
    tr.innerHTML = `
        <td>${num}</td>
        <td style="color:var(--text-2);max-width:420px;white-space:pre-wrap;word-break:break-word">${preview}</td>
        <td style="text-align:right;color:var(--text-3)">${fmt}</td>
    `;
    mensagensEnviadasTableBody.insertBefore(tr, mensagensEnviadasTableBody.firstChild);
}

socket.on('all_mensagens_enviadas', (mensagens) => {
    if (!mensagensEnviadasTableBody) return;
    if (mensagens.length === 0) return;
    mensagensEnviadasTableBody.innerHTML = '';
    [...mensagens].reverse().forEach(m => addMensagemEnviadaToTable(m.telefone, m.texto, m.ts));
});

btnLimparFeed?.addEventListener('click', () => {
    if (!liveFeed) return;
    liveFeed.innerHTML = '';
    if (liveFeedEmpty) { liveFeedEmpty.style.display = 'block'; liveFeed.appendChild(liveFeedEmpty); }
});

// =====================================
// LEADS TABLE
// =====================================
const leadsTableBody = document.getElementById('leads-table-body');

function addLeadToTable(telefone, dataStr, msgs) {
    if (!leadsTableBody) return;
    if (leadsTableBody.querySelector('td[colspan]')) leadsTableBody.innerHTML = '';
    const tr = document.createElement('tr');
    const fmt = new Date(dataStr).toLocaleString('pt-BR');
    const num = telefone.replace('@c.us', '');
    tr.innerHTML = `
        <td>${num}</td>
        <td style="color:var(--text-2)">${fmt}</td>
        <td style="text-align:right;color:var(--green);font-weight:600">${msgs || 1}</td>
    `;
    leadsTableBody.insertBefore(tr, leadsTableBody.firstChild);
}

socket.on('all_leads', (leads) => {
    if (leadsTableBody && leads.length > 0) {
        leadsTableBody.innerHTML = '';
        [...leads].reverse().forEach(l => addLeadToTable(l.telefone, l.data_captura, l.mensagens_recebidas));
    }
});

socket.on('new_lead', (lead) => {
    addLeadToTable(lead.telefone, lead.data_captura, 1);
    const num = lead.telefone.replace('@c.us', '');
    addActivity('👥', `Novo lead: ${num}`, new Date(lead.data_captura).toLocaleString('pt-BR'));
    showToast('🎯 Novo Lead Capturado!', `Número: ${num}`, 'success', 5000);
});

// =====================================
// BOTÃO DESCONECTAR
// =====================================
if (btnDisconnect) {
    btnDisconnect.addEventListener('click', async () => {
        if (confirm('Tem certeza que deseja desconectar o WhatsApp? Você precisará escanear o QR Code novamente para conectar.')) {
            const originalText = btnDisconnect.textContent;
            btnDisconnect.disabled = true;
            btnDisconnect.textContent = 'Desconectando...';
            try {
                const res = await fetch('/api/disconnect', { method: 'POST' });
                if (!res.ok) throw new Error('Erro ao desconectar');
                btnDisconnect.textContent = '✅ Desconectado';
                showToast('Desconectado', 'O servidor vai reiniciar e gerar um novo QR Code. Recarregando em 6s...', 'info', 6000);
                setTimeout(() => location.reload(), 6000);
            } catch (err) {
                console.error(err);
                showToast('Erro', 'Não foi possível desconectar.', 'error');
                btnDisconnect.disabled = false;
                btnDisconnect.textContent = originalText;
            }
        }
    });
}

// =====================================
// NAVEGAÇÃO SPA
// =====================================
const navBtns      = document.querySelectorAll('.nav-btn');
const pageSections = document.querySelectorAll('.page-section');
const pageTitle    = document.getElementById('page-title');

navBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        navBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const targetId = btn.getAttribute('data-target');
        pageSections.forEach(s => s.classList.add('hidden'));
        const target = document.getElementById(targetId);
        if (target) target.classList.remove('hidden');
        // Título limpo (sem emojis de SVG)
        const text = btn.textContent.trim().split('\n')[0].trim();
        pageTitle.textContent = text;
        if (targetId === 'mensagens-section') loadRegras();
        if (targetId === 'ia-section') loadIaConfig();
        if (targetId === 'configuracoes-section') loadHorarioConfig();
        if (targetId === 'conversas-section') CM.onEnterSection();
        if (targetId === 'disparos-section') loadContatos();
        if (targetId === 'integracoes-section') loadCrmColaboradores();
    });
});

// =====================================
// INTELIGÊNCIA ARTIFICIAL
// =====================================
const iaStatus     = document.getElementById('ia-status');
const iaProvider   = document.getElementById('ia-provider');
const iaApikey     = document.getElementById('ia-apikey');
const iaModelo     = document.getElementById('ia-modelo');
const iaTreinamento = document.getElementById('ia-treinamento');
const btnSalvarIa  = document.getElementById('btn-salvar-ia');

const GROQ_MODELS = [
    { value: 'llama-3.1-8b-instant',       label: 'Llama 3.1 8B Instant (Mais Rápido, Gratuito)' },
    { value: 'llama-3.3-70b-versatile',     label: 'Llama 3.3 70B Versatile (Melhor Qualidade)' },
    { value: 'mixtral-8x7b-32768',          label: 'Mixtral 8x7B (Bom em Português)' },
    { value: 'gemma2-9b-it',               label: 'Gemma 2 9B (Google, Gratuito)' },
];
const OPENAI_MODELS = [
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (Mais Rápido e Barato)' },
    { value: 'gpt-4o',        label: 'GPT-4o (Mais Inteligente, Maior Custo)' },
];

function updateIaProviderUI(provider) {
    if (!iaModelo) return;
    const models = provider === 'groq' ? GROQ_MODELS : OPENAI_MODELS;
    const currentVal = iaModelo.value;
    iaModelo.innerHTML = models.map(m => `<option value="${m.value}">${m.label}</option>`).join('');
    if (models.find(m => m.value === currentVal)) iaModelo.value = currentVal;

    const label = document.getElementById('ia-apikey-label');
    const hint  = document.getElementById('ia-apikey-hint');
    if (provider === 'groq') {
        if (label) label.innerHTML = 'Groq API Key <a href="https://console.groq.com/keys" target="_blank" style="color:var(--green);font-size:.75rem;margin-left:.5rem">⚡ Pegar chave grátis</a>';
        if (hint)  hint.textContent = 'Gratuito. Crie uma conta em console.groq.com e gere sua chave.';
        if (iaApikey) iaApikey.placeholder = 'gsk_xxxxxxxxxxxxxxxxxxxxxxxx';
    } else {
        if (label) label.innerHTML = 'OpenAI API Key <a href="https://platform.openai.com/api-keys" target="_blank" style="color:var(--green);font-size:.75rem;margin-left:.5rem">Pegar minha chave</a>';
        if (hint)  hint.textContent = 'Sua chave é armazenada com segurança no banco local.';
        if (iaApikey) iaApikey.placeholder = 'sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxx';
    }
}

iaProvider?.addEventListener('change', () => updateIaProviderUI(iaProvider.value));

async function loadIaConfig() {
    try {
        const res = await fetch('/api/configuracoes');
        const config = await res.json();
        const provider = config.ia_provider || 'openai';
        if (iaProvider)    iaProvider.value  = provider;
        updateIaProviderUI(provider);
        if (iaStatus)      iaStatus.checked  = config.openai_status === 'true';
        if (iaTreinamento) iaTreinamento.value = config.openai_treinamento || '';
        if (provider === 'groq') {
            if (iaApikey) iaApikey.value = config.groq_api_key || '';
            if (iaModelo) iaModelo.value = config.groq_modelo || 'llama-3.1-8b-instant';
        } else {
            if (iaApikey) iaApikey.value = config.openai_api_key || '';
            if (iaModelo) iaModelo.value = config.openai_modelo || 'gpt-3.5-turbo';
        }
    } catch (e) {
        console.error('Erro ao carregar configs de IA', e);
    }
}

btnSalvarIa?.addEventListener('click', async () => {
    const provider = iaProvider?.value || 'openai';
    const payload = {
        ia_provider: provider,
        openai_status: iaStatus.checked ? 'true' : 'false',
        openai_treinamento: iaTreinamento.value.trim(),
        ...(provider === 'groq'
            ? { groq_api_key: iaApikey.value.trim(), groq_modelo: iaModelo.value }
            : { openai_api_key: iaApikey.value.trim(), openai_modelo: iaModelo.value }
        )
    };
    try {
        await fetch('/api/configuracoes', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        showToast('IA Configurad!', 'As configurações da inteligência artificial foram salvas.', 'success');
        addActivity('🧠', 'Configurações de IA salvas', new Date().toLocaleString('pt-BR'));
    } catch (e) {
        showToast('Erro', 'Não foi possível salvar as configurações da IA', 'error');
    }
});

// =====================================
// OVERRIDE MANUAL — BOTÃO "ATIVAR ROBÔ"
// =====================================
const btnRoboToggle  = document.getElementById('btn-robo-toggle');
const roboToggleMenu = document.getElementById('robo-toggle-menu');
let roboOverrideState = { ativo: false, indeterminado: false, ate: null };
let roboCountdownInterval = null;

function renderRoboToggle() {
    if (!btnRoboToggle) return;
    clearInterval(roboCountdownInterval);

    if (!roboOverrideState.ativo) {
        btnRoboToggle.textContent = '🤖 Ativar Robô';
        btnRoboToggle.className = 'btn-primary';
        return;
    }

    btnRoboToggle.className = 'btn-danger';
    if (roboOverrideState.indeterminado) {
        btnRoboToggle.textContent = '🟢 Robô Ativo — Desligar';
        return;
    }

    const atualizarLabel = () => {
        const restanteMs = roboOverrideState.ate - Date.now();
        if (restanteMs <= 0) {
            roboOverrideState = { ativo: false, indeterminado: false, ate: null };
            renderRoboToggle();
            return;
        }
        const min = Math.ceil(restanteMs / 60000);
        btnRoboToggle.textContent = `🟢 Robô Ativo (${min}min) — Desligar`;
    };
    atualizarLabel();
    roboCountdownInterval = setInterval(atualizarLabel, 1000);
}

async function loadRoboOverride() {
    try {
        const res = await fetch('/api/robo-override');
        roboOverrideState = await res.json();
        renderRoboToggle();
    } catch (e) {
        console.error('Erro ao carregar estado do robô', e);
    }
}

btnRoboToggle?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (roboOverrideState.ativo) {
        try {
            const res = await fetch('/api/robo-override', { method: 'DELETE' });
            roboOverrideState = await res.json();
            renderRoboToggle();
            showToast('Robô desligado', 'Atendimento humano assumiu as respostas.', 'info');
            addActivity('🧑', 'Robô desligado manualmente', new Date().toLocaleString('pt-BR'));
        } catch (err) {
            showToast('Erro', 'Não foi possível desligar o robô', 'error');
        }
        return;
    }
    roboToggleMenu?.classList.toggle('open');
});

document.addEventListener('click', (e) => {
    if (roboToggleMenu?.classList.contains('open') && !roboToggleMenu.contains(e.target) && e.target !== btnRoboToggle) {
        roboToggleMenu.classList.remove('open');
    }
});

roboToggleMenu?.querySelectorAll('.robo-tempo-opcao').forEach(btn => {
    btn.addEventListener('click', async () => {
        const minutosAttr = btn.dataset.minutos;
        const minutos = minutosAttr ? Number(minutosAttr) : null;
        roboToggleMenu.classList.remove('open');
        try {
            const res = await fetch('/api/robo-override', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ minutos })
            });
            roboOverrideState = await res.json();
            renderRoboToggle();
            const desc = minutos ? `pelos próximos ${minutos} minutos` : 'por tempo indeterminado';
            showToast('Robô ativado!', `O robô vai responder ${desc}.`, 'success');
            addActivity('🤖', `Robô ativado manualmente (${minutos ? minutos + 'min' : 'indeterminado'})`, new Date().toLocaleString('pt-BR'));
        } catch (err) {
            showToast('Erro', 'Não foi possível ativar o robô', 'error');
        }
    });
});

socket.on('robo_override', (state) => {
    roboOverrideState = state;
    renderRoboToggle();
});

loadRoboOverride();

// =====================================
// HORÁRIO DE FUNCIONAMENTO
// =====================================
const horarioAtivo          = document.getElementById('horario-ativo');
const horarioModoPadrao     = document.getElementById('horario-modo-padrao');
const horarioMensagemHumano = document.getElementById('horario-mensagem-humano');
const btnSalvarHorario      = document.getElementById('btn-salvar-horario');
const horarioFaixasList     = document.getElementById('horario-faixas-list');
const btnAddFaixa           = document.getElementById('btn-add-faixa');

const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
let horarioFaixas = []; // [{ dias: [1,2,3,4,5], inicio: '07:00', fim: '11:00', modo: 'humano' }, ...]

// Lê o estado atual dos inputs de volta para horarioFaixas, para não perder
// edições em andamento ao adicionar/remover uma faixa ou salvar.
function sincronizarFaixasDoDOM() {
    if (!horarioFaixasList) return;
    horarioFaixasList.querySelectorAll('.faixa-row').forEach(row => {
        const idx = Number(row.dataset.idx);
        const dias = Array.from(row.querySelectorAll('.faixa-dia')).filter(cb => cb.checked).map(cb => Number(cb.dataset.dia));
        const inicio = row.querySelector('.faixa-inicio').value || '00:00';
        const fim = row.querySelector('.faixa-fim').value || '00:00';
        const modo = row.querySelector('.faixa-modo').value;
        horarioFaixas[idx] = { dias, inicio, fim, modo };
    });
}

function renderFaixas() {
    if (!horarioFaixasList) return;
    if (horarioFaixas.length === 0) {
        horarioFaixasList.innerHTML = '<p style="color:var(--text-3);font-size:.85rem">Nenhuma faixa cadastrada — clique em "+ Adicionar faixa".</p>';
        return;
    }
    horarioFaixasList.innerHTML = horarioFaixas.map((f, idx) => `
        <div class="faixa-row" data-idx="${idx}" style="display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;padding:.7rem;background:rgba(255,255,255,0.03);border-radius:8px;margin-bottom:.6rem">
            <div style="display:flex;flex-wrap:wrap;gap:.4rem;flex:1;min-width:210px">
                ${DIAS_SEMANA.map((label, d) => `
                    <label style="display:flex;align-items:center;gap:.25rem;cursor:pointer;font-size:.78rem">
                        <input type="checkbox" class="faixa-dia" data-dia="${d}" ${f.dias.includes(d) ? 'checked' : ''} style="accent-color:var(--green)"> ${label}
                    </label>
                `).join('')}
            </div>
            <input type="time" class="faixa-inicio" value="${f.inicio}" style="width:110px">
            <span style="color:var(--text-3)">até</span>
            <input type="time" class="faixa-fim" value="${f.fim}" style="width:110px">
            <select class="faixa-modo" style="background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:var(--radius-sm);padding:.5rem .7rem;color:var(--text-1)">
                <option value="robo" ${f.modo === 'robo' ? 'selected' : ''}>🤖 Robô</option>
                <option value="humano" ${f.modo === 'humano' ? 'selected' : ''}>🧑 Humano</option>
            </select>
            <button type="button" class="btn-remove-faixa" data-idx="${idx}" style="background:none;border:none;color:var(--red);font-size:1.1rem;cursor:pointer;padding:.2rem .5rem">✕</button>
        </div>
    `).join('');
}

btnAddFaixa?.addEventListener('click', () => {
    sincronizarFaixasDoDOM();
    horarioFaixas.push({ dias: [1, 2, 3, 4, 5], inicio: '08:00', fim: '18:00', modo: 'robo' });
    renderFaixas();
});

horarioFaixasList?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-remove-faixa');
    if (!btn) return;
    sincronizarFaixasDoDOM();
    horarioFaixas.splice(Number(btn.dataset.idx), 1);
    renderFaixas();
});

async function loadHorarioConfig() {
    try {
        const res = await fetch('/api/horarios');
        const data = await res.json();
        if (horarioAtivo) horarioAtivo.checked = !!data.ativo;
        if (horarioModoPadrao) horarioModoPadrao.value = data.modo_padrao || 'robo';
        if (horarioMensagemHumano) horarioMensagemHumano.value = data.mensagem_humano || '';
        horarioFaixas = (data.faixas || []).map(f => ({ dias: f.dias, inicio: f.inicio, fim: f.fim, modo: f.modo }));
        renderFaixas();
    } catch (e) {
        console.error('Erro ao carregar horário de funcionamento', e);
    }
}

btnSalvarHorario?.addEventListener('click', async () => {
    sincronizarFaixasDoDOM();
    const payload = {
        ativo: !!horarioAtivo?.checked,
        modo_padrao: horarioModoPadrao?.value || 'robo',
        mensagem_humano: (horarioMensagemHumano?.value || '').trim(),
        faixas: horarioFaixas.filter(f => f.dias.length > 0)
    };
    try {
        await fetch('/api/horarios', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        showToast('Horário salvo!', 'As faixas de horário de funcionamento foram atualizadas.', 'success');
        addActivity('⏰', 'Horário de funcionamento atualizado', new Date().toLocaleString('pt-BR'));
    } catch (e) {
        showToast('Erro', 'Não foi possível salvar o horário de funcionamento', 'error');
    }
});

// =====================================
// ETIQUETAS (compartilhado entre Regras, Conversas e Lista de Contatos)
// =====================================
const ETIQUETA_PALETA = ['#25D366', '#3b7de8', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#ec4899', '#84cc16'];
let todasEtiquetas = [];

async function loadEtiquetas() {
    try {
        const res = await fetch('/api/etiquetas');
        todasEtiquetas = await res.json();
    } catch (e) {
        console.error('Erro ao carregar etiquetas', e);
    }
    return todasEtiquetas;
}

async function criarEtiquetaRapida() {
    const nome = prompt('Nome da nova etiqueta:');
    if (!nome || !nome.trim()) return null;
    const cor = ETIQUETA_PALETA[todasEtiquetas.length % ETIQUETA_PALETA.length];
    try {
        const res = await fetch('/api/etiquetas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome.trim(), cor })
        });
        const nova = await res.json();
        if (!res.ok) { showToast('Erro', nova.error || 'Não foi possível criar a etiqueta', 'error'); return null; }
        todasEtiquetas.push(nova);
        return nova;
    } catch (e) {
        showToast('Erro', 'Não foi possível criar a etiqueta', 'error');
        return null;
    }
}

function etiquetaChipHtml(etiqueta, removivel) {
    return `<span class="etiqueta-chip" style="background:${etiqueta.cor}22;color:${etiqueta.cor};border:1px solid ${etiqueta.cor}55">
        ${etiqueta.nome}${removivel ? `<button type="button" class="etiqueta-chip-remove" data-etiqueta-id="${etiqueta.id}">×</button>` : ''}
    </span>`;
}

async function aplicarEtiquetaContato(telefone, etiquetaId) {
    await fetch(`/api/contatos/${telefone}/etiquetas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ etiqueta_id: etiquetaId })
    });
}

async function removerEtiquetaContato(telefone, etiquetaId) {
    await fetch(`/api/contatos/${telefone}/etiquetas/${etiquetaId}`, { method: 'DELETE' });
}

loadEtiquetas();

// =====================================
// GERENCIADOR DE REGRAS
// =====================================
const modalOverlay    = document.getElementById('modal-overlay');
const modalTitle      = document.getElementById('modal-title');
const modalEditId     = document.getElementById('modal-edit-id');
const modalKeywords   = document.getElementById('modal-keywords');
const modalResposta   = document.getElementById('modal-resposta');
const modalOrdem      = document.getElementById('modal-ordem');
const modalAudio      = document.getElementById('modal-audio');
const modalEtiqueta   = document.getElementById('modal-etiqueta');
const modalMediaPath  = document.getElementById('modal-media-path');
const modalMediaTipo  = document.getElementById('modal-media-tipo');
const uploadArea      = document.getElementById('upload-area');
const uploadAreaText  = document.getElementById('upload-area-text');
const modalFile       = document.getElementById('modal-file');
const uploadPreview   = document.getElementById('upload-preview');
const regrasLista     = document.getElementById('regras-lista');

uploadArea?.addEventListener('click', () => modalFile?.click());
uploadArea?.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = 'var(--green)'; });
uploadArea?.addEventListener('dragleave', () => { uploadArea.style.borderColor = ''; });
uploadArea?.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]); });
modalFile?.addEventListener('change', () => { if (modalFile.files[0]) handleFileUpload(modalFile.files[0]); });

async function handleFileUpload(file) {
    uploadAreaText.textContent = `⏳ Enviando ${file.name}...`;
    uploadArea.classList.add('has-file');
    const formData = new FormData();
    formData.append('media', file);
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        modalMediaPath.value = data.path;
        modalMediaTipo.value = data.tipo;
        uploadAreaText.textContent = `✅ ${data.originalName}`;
        uploadPreview.style.display = 'block';
        uploadPreview.innerHTML = data.tipo === 'image'
            ? `<img src="${data.path}" class="upload-preview-img">`
            : `<span style="color:var(--text-2);font-size:.82rem">📄 ${data.originalName}</span>`;
        showToast('Upload concluído', data.originalName, 'success', 3000);
    } catch {
        uploadAreaText.textContent = '❌ Erro no upload. Tente novamente.';
        uploadArea.classList.remove('has-file');
    }
}

function renderModalEtiquetaOptions(selecionadaId) {
    if (!modalEtiqueta) return;
    modalEtiqueta.innerHTML = '<option value="">Nenhuma</option>' +
        todasEtiquetas.map(e => `<option value="${e.id}">${e.nome}</option>`).join('');
    modalEtiqueta.value = selecionadaId || '';
}

async function openModal(regra = null) {
    modalEditId.value   = regra ? regra.id : '';
    modalTitle.textContent = regra ? '✏️ Editar Regra' : '✨ Nova Regra de Resposta';
    modalKeywords.value = regra ? regra.keywords : '';
    modalResposta.value = regra ? regra.resposta : '';
    modalOrdem.value    = regra ? regra.ordem : 99;
    modalAudio.checked  = regra ? (regra.enviar_audio === 1) : false;
    modalMediaPath.value = regra?.media_path || '';
    modalMediaTipo.value = regra?.media_tipo || '';
    uploadArea.classList.remove('has-file');
    uploadAreaText.textContent = regra?.media_path ? '✅ Mídia já configurada' : '📎 Clique ou arraste um arquivo aqui';
    if (regra?.media_path) uploadArea.classList.add('has-file');
    uploadPreview.style.display = 'none';
    uploadPreview.innerHTML = '';
    await loadEtiquetas();
    renderModalEtiquetaOptions(regra?.etiqueta_id);
    modalOverlay.classList.add('open');
}

function closeModal() { modalOverlay.classList.remove('open'); }

document.getElementById('btn-modal-nova-etiqueta')?.addEventListener('click', async () => {
    const nova = await criarEtiquetaRapida();
    if (!nova) return;
    renderModalEtiquetaOptions(nova.id);
});

document.getElementById('btn-nova-regra')?.addEventListener('click', () => openModal());
document.getElementById('modal-cancelar')?.addEventListener('click', closeModal);
modalOverlay?.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

document.getElementById('modal-salvar')?.addEventListener('click', async () => {
    const id = modalEditId.value;
    const payload = {
        keywords:   modalKeywords.value.trim(),
        resposta:   modalResposta.value.trim(),
        ordem:      parseInt(modalOrdem.value) || 99,
        enviar_audio: modalAudio.checked,
        media_path: modalMediaPath.value || null,
        media_tipo: modalMediaTipo.value || null,
        etiqueta_id: modalEtiqueta.value ? Number(modalEtiqueta.value) : null,
        ativo: 1
    };
    if (!payload.keywords || !payload.resposta) { alert('Preencha as palavras-chave e a resposta!'); return; }
    const url    = id ? `/api/respostas/${id}` : '/api/respostas';
    const method = id ? 'PUT' : 'POST';
    await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    closeModal();
    loadRegras();
    showToast(id ? 'Regra atualizada' : 'Regra criada', payload.keywords, 'success', 3000);
});

async function toggleRegra(regra) {
    await fetch(`/api/respostas/${regra.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...regra, ativo: regra.ativo === 1 ? 0 : 1 })
    });
    loadRegras();
}

async function deleteRegra(id) {
    if (!confirm('Apagar esta regra?')) return;
    await fetch(`/api/respostas/${id}`, { method: 'DELETE' });
    loadRegras();
    showToast('Regra removida', '', 'info', 2500);
}

function editRegra(regra) { openModal(regra); }

async function loadRegras() {
    if (!regrasLista) return;
    regrasLista.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:2rem">Carregando...</p>';
    try {
        const [res] = await Promise.all([fetch('/api/respostas'), loadEtiquetas()]);
        const regras = await res.json();
        if (regras.length === 0) {
            regrasLista.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:2rem">Nenhuma regra ainda. Clique em "Nova Regra"!</p>';
            return;
        }
        regrasLista.innerHTML = '';
        regras.forEach(regra => {
            const kws = regra.keywords.split(',').map(k => k.trim());
            const div = document.createElement('div');
            div.className = `regra-card ${regra.ativo === 0 ? 'desativada' : ''}`;
            const mediaBadge = regra.media_path
                ? `<span class="regra-audio-badge">${regra.media_tipo==='image'?'🖼️':regra.media_tipo==='video'?'🎥':'📂'} Mídia</span>`
                : '';
            const audioBadge = regra.enviar_audio ? `<span class="regra-audio-badge">🎙️ Áudio</span>` : '';
            const etiquetaAplicada = regra.etiqueta_id ? todasEtiquetas.find(e => e.id === regra.etiqueta_id) : null;
            const etiquetaBadge = etiquetaAplicada ? etiquetaChipHtml(etiquetaAplicada, false) : '';
            div.innerHTML = `
                <div class="regra-header">
                    <div class="regra-keywords">${kws.map(kw=>`<span class="keyword-tag">${kw}</span>`).join('')}</div>
                    <div class="regra-actions">
                        <button class="btn-secondary" onclick='editRegra(${JSON.stringify(regra)})'>✏️</button>
                        <button class="btn-danger" onclick="deleteRegra(${regra.id})">🗑️</button>
                        <button class="toggle-btn ${regra.ativo===1?'on':'off'}" onclick='toggleRegra(${JSON.stringify(regra)})'></button>
                    </div>
                </div>
                <div class="regra-resposta">${regra.resposta}</div>
                <div style="margin-top:.4rem;display:flex;gap:.3rem;align-items:center">${audioBadge}${mediaBadge}${etiquetaBadge}</div>
            `;
            regrasLista.appendChild(div);
        });
    } catch {
        regrasLista.innerHTML = '<p style="color:var(--red);text-align:center;padding:2rem">Erro ao carregar regras.</p>';
    }
}

socket.on('respostas_updated', () => {
    const s = document.getElementById('mensagens-section');
    if (s && !s.classList.contains('hidden')) loadRegras();
});

// =====================================
// LISTA DE CONTATOS (SELEÇÃO PARA DISPAROS)
// =====================================
const contatosLista       = document.getElementById('contatos-lista');
const contatosBusca       = document.getElementById('contatos-busca');
const contatosSelectAll   = document.getElementById('contatos-select-all');
const contatosContador    = document.getElementById('contatos-contador');
const btnUsarSelecionados = document.getElementById('btn-usar-selecionados');
const contatosFiltroEtiquetas = document.getElementById('contatos-filtro-etiquetas');

let todosContatos = [];
const contatosSelecionados = new Set();
const etiquetasFiltroAtivas = new Set();

function contatosFiltrados() {
    const termo = (contatosBusca?.value || '').trim().toLowerCase();
    return todosContatos.filter(c => {
        const bateBusca = !termo || c.nome.toLowerCase().includes(termo) || c.telefone.includes(termo);
        const bateEtiqueta = etiquetasFiltroAtivas.size === 0 || c.etiquetas.some(e => etiquetasFiltroAtivas.has(e.id));
        return bateBusca && bateEtiqueta;
    });
}

function atualizarContadorContatos() {
    const n = contatosSelecionados.size;
    if (contatosContador) contatosContador.textContent = `${n} contato${n !== 1 ? 's' : ''} selecionado${n !== 1 ? 's' : ''}`;
}

function renderFiltroEtiquetas() {
    if (!contatosFiltroEtiquetas) return;
    if (todasEtiquetas.length === 0) { contatosFiltroEtiquetas.innerHTML = ''; return; }
    contatosFiltroEtiquetas.innerHTML = todasEtiquetas.map(e => `
        <button type="button" class="etiqueta-filtro-chip${etiquetasFiltroAtivas.has(e.id) ? ' active' : ''}"
            data-etiqueta-id="${e.id}"
            style="${etiquetasFiltroAtivas.has(e.id) ? `background:${e.cor};border-color:${e.cor}` : `border-color:${e.cor}55;color:${e.cor}`}">
            ${e.nome}
        </button>
    `).join('');
}

contatosFiltroEtiquetas?.addEventListener('click', (e) => {
    const chip = e.target.closest('.etiqueta-filtro-chip');
    if (!chip) return;
    const id = Number(chip.dataset.etiquetaId);
    if (etiquetasFiltroAtivas.has(id)) etiquetasFiltroAtivas.delete(id);
    else etiquetasFiltroAtivas.add(id);
    renderFiltroEtiquetas();
    renderContatos();
});

function renderContatos() {
    if (!contatosLista) return;
    const filtrados = contatosFiltrados();
    if (filtrados.length === 0) {
        contatosLista.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:2rem">Nenhum contato encontrado.</p>';
        atualizarContadorContatos();
        return;
    }
    contatosLista.innerHTML = filtrados.map(c => `
        <label class="contato-row" style="display:flex;align-items:center;gap:.7rem;padding:.6rem .7rem;border-radius:8px;cursor:pointer">
            <input type="checkbox" class="contato-check" data-telefone="${c.telefone}" ${contatosSelecionados.has(c.telefone) ? 'checked' : ''} style="accent-color:var(--green);width:16px;height:16px;flex-shrink:0">
            <div style="flex:1;min-width:0">
                <div style="font-size:.88rem;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.nome} ${c.etiquetas.map(e => etiquetaChipHtml(e, false)).join(' ')}</div>
                <div style="font-size:.75rem;color:var(--text-3)">${c.telefone}</div>
            </div>
            <span style="font-size:.72rem;color:var(--text-3);flex-shrink:0">${c.mensagens_recebidas} msg${c.mensagens_recebidas !== 1 ? 's' : ''}</span>
        </label>
    `).join('');
    atualizarContadorContatos();
}

async function loadContatos() {
    if (!contatosLista) return;
    try {
        const [res] = await Promise.all([fetch('/api/contatos'), loadEtiquetas()]);
        todosContatos = await res.json();
        renderFiltroEtiquetas();
        renderContatos();
    } catch (e) {
        console.error('Erro ao carregar contatos', e);
        contatosLista.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:2rem">Erro ao carregar contatos.</p>';
    }
}

contatosLista?.addEventListener('change', (e) => {
    const check = e.target.closest('.contato-check');
    if (!check) return;
    if (check.checked) contatosSelecionados.add(check.dataset.telefone);
    else contatosSelecionados.delete(check.dataset.telefone);
    atualizarContadorContatos();
});

contatosBusca?.addEventListener('input', renderContatos);

contatosSelectAll?.addEventListener('change', () => {
    const visiveis = contatosFiltrados();
    if (contatosSelectAll.checked) visiveis.forEach(c => contatosSelecionados.add(c.telefone));
    else visiveis.forEach(c => contatosSelecionados.delete(c.telefone));
    renderContatos();
});

btnUsarSelecionados?.addEventListener('click', () => {
    if (contatosSelecionados.size === 0) {
        showToast('Nenhum contato selecionado', 'Marque ao menos um contato na lista.', 'error');
        return;
    }
    const broadcastNumeros = document.getElementById('broadcast-numeros');
    if (broadcastNumeros) broadcastNumeros.value = Array.from(contatosSelecionados).join('\n');
    showToast('Contatos aplicados!', `${contatosSelecionados.size} número(s) inserido(s) no campo de disparo.`, 'success');
});

// =====================================
// BROADCAST
// =====================================
const btnDisparar       = document.getElementById('btn-disparar');
const btnParar          = document.getElementById('btn-parar');
const progTotal         = document.getElementById('prog-total');
const progSent          = document.getElementById('prog-sent');
const progFailed        = document.getElementById('prog-failed');
const progPercent       = document.getElementById('prog-percent');
const progBar           = document.getElementById('prog-bar');
const broadcastStatusMsg= document.getElementById('broadcast-status-msg');
const broadcastUpload   = document.getElementById('broadcast-upload-area');
const broadcastFile     = document.getElementById('broadcast-file');
const broadcastFileName = document.getElementById('broadcast-file-name');

broadcastUpload?.addEventListener('click', () => broadcastFile?.click());
broadcastFile?.addEventListener('change', () => {
    if (broadcastFile.files[0]) {
        broadcastFileName.textContent = `✅ ${broadcastFile.files[0].name}`;
        broadcastUpload.classList.add('has-file');
    }
});

function updateProgressUI(p) {
    if (!progTotal) return;
    progTotal.textContent = p.total;
    progSent.textContent  = p.sent;
    progFailed.textContent = p.failed;
    const pct = p.total > 0 ? Math.round(((p.sent + p.failed) / p.total) * 100) : 0;
    progPercent.textContent = `${pct}%`;
    progBar.style.width = `${pct}%`;
    if (p.running) {
        broadcastStatusMsg.textContent = `🚀 Disparando... ${p.sent + p.failed}/${p.total}`;
        broadcastStatusMsg.style.color = 'var(--green)';
        if (btnDisparar) btnDisparar.style.display = 'none';
        if (btnParar)    btnParar.style.display = 'inline-flex';
    }
}

socket.on('broadcast_progress', updateProgressUI);

socket.on('broadcast_done', (p) => {
    broadcastStatusMsg.textContent = `✅ Concluído! ${p.sent} enviados, ${p.failed} falhas.`;
    broadcastStatusMsg.style.color = 'var(--green)';
    if (btnDisparar) btnDisparar.style.display = 'inline-flex';
    if (btnParar)    btnParar.style.display = 'none';
    showToast('Disparo Finalizado!', `${p.sent} enviados com sucesso.`, 'success', 6000);
    addActivity('🚀', `Disparo concluído: ${p.sent} msgs`, new Date().toLocaleString('pt-BR'));
});

btnDisparar?.addEventListener('click', async () => {
    const numeros  = document.getElementById('broadcast-numeros')?.value;
    const mensagem = document.getElementById('broadcast-mensagem')?.value;
    const delay_ms = (parseInt(document.getElementById('broadcast-delay')?.value) || 6) * 1000;
    if (!numeros?.trim())  { alert('Cole os números!'); return; }
    if (!mensagem?.trim()) { alert('Digite a mensagem!'); return; }
    const formData = new FormData();
    formData.append('numeros', numeros);
    formData.append('mensagem', mensagem);
    formData.append('delay_ms', delay_ms);
    if (broadcastFile?.files[0]) formData.append('media', broadcastFile.files[0]);
    const res = await fetch('/api/broadcast/start', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Erro ao iniciar disparo.'); return; }
    broadcastStatusMsg.textContent = `🚀 Iniciando disparo para ${data.total} números...`;
    broadcastStatusMsg.style.color = 'var(--green)';
    showToast('Disparo Iniciado!', `${data.total} números na fila`, 'success');
});

btnParar?.addEventListener('click', async () => {
    await fetch('/api/broadcast/stop', { method: 'POST' });
    broadcastStatusMsg.textContent = '⏹ Disparo interrompido.';
    broadcastStatusMsg.style.color = 'var(--amber)';
    if (btnDisparar) btnDisparar.style.display = 'inline-flex';
    if (btnParar)    btnParar.style.display = 'none';
});

// =====================================
// CONVERSATION MANAGER
// =====================================
const CM = (() => {
    // ---- Estado interno ----
    let contacts    = new Map(); // telefone -> { nome, ultimo_texto, ultima_direcao, ultimo_ts, nao_lidas }
    let activePhone = null;
    let totalNaoLidas = 0;
    let searchQuery = '';

    // ---- Referências DOM ----
    const contactList    = document.getElementById('chat-contact-list');
    const chatEmpty      = document.getElementById('chat-list-empty');
    const chatPlaceholder = document.getElementById('chat-placeholder');
    const chatHeader     = document.getElementById('chat-header');
    const chatHeaderAvatar = document.getElementById('chat-header-avatar');
    const chatHeaderName = document.getElementById('chat-header-name');
    const chatHeaderStatus = document.getElementById('chat-header-status');
    const chatHeaderTags = document.getElementById('chat-header-tags');
    const chatHeaderAddTag = document.getElementById('chat-header-add-tag');
    const btnChatAssumir = document.getElementById('btn-chat-assumir');
    const chatMessages   = document.getElementById('chat-messages');
    const chatInputBar   = document.getElementById('chat-input-bar');
    const chatTypingBar  = document.getElementById('chat-typing-bar');
    const chatInput      = document.getElementById('chat-input-text');
    const btnSend        = document.getElementById('btn-chat-send');
    const btnReload      = document.getElementById('btn-chat-reload');
    const searchInput    = document.getElementById('chat-search');
    const badgeNaoLidas  = document.getElementById('badge-nao-lidas');

    // ---- Utilitários ----
    function avatarLetter(nome) {
        if (!nome) return '?';
        const parts = nome.trim().split(' ');
        return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
    }

    function formatHora(tsStr) {
        const d = new Date(tsStr);
        if (isNaN(d)) return '';
        const now = new Date();
        const diffMs = now - d;
        const diffMin = Math.round(diffMs / 60000);
        if (diffMin < 1)   return 'agora';
        if (diffMin < 60)  return `${diffMin}min`;
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24)    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        if (diffH < 168)   return d.toLocaleDateString('pt-BR', { weekday: 'short' });
        return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    }

    function formatHoraCompleta(tsStr) {
        const d = new Date(tsStr);
        if (isNaN(d)) return '';
        return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    function formatDataSep(tsStr) {
        const d = new Date(tsStr);
        if (isNaN(d)) return '';
        const today = new Date();
        const yest  = new Date(today); yest.setDate(yest.getDate() - 1);
        if (d.toDateString() === today.toDateString()) return 'Hoje';
        if (d.toDateString() === yest.toDateString())  return 'Ontem';
        return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    }

    function tipoIcon(tipo) {
        const icons = { image: '🖼️ Imagem', audio: '🎤 Áudio', video: '🎥 Vídeo', document: '📄 Documento', sticker: '🎭 Sticker', ptt: '🎤 Áudio' };
        return icons[tipo] || null;
    }

    // ---- Atualiza badge global de não lidas ----
    function updateGlobalBadge() {
        totalNaoLidas = 0;
        contacts.forEach(c => { totalNaoLidas += (c.nao_lidas || 0); });
        if (badgeNaoLidas) {
            if (totalNaoLidas > 0) {
                badgeNaoLidas.textContent = totalNaoLidas > 99 ? '99+' : totalNaoLidas;
                badgeNaoLidas.style.display = 'inline';
            } else {
                badgeNaoLidas.style.display = 'none';
            }
        }
    }

    // ---- Renderiza a lista de contatos ----
    function renderContactList() {
        if (!contactList) return;
        // Remove todos os itens de contato (não o empty placeholder)
        const existing = contactList.querySelectorAll('.chat-contact-item');
        existing.forEach(el => el.remove());

        // Filtra e ordena: por data decrescente
        const filtered = [...contacts.values()].filter(c => {
            if (!searchQuery) return true;
            const q = searchQuery.toLowerCase();
            return c.nome.toLowerCase().includes(q) || c.telefone.includes(q);
        }).sort((a, b) => new Date(b.ultimo_ts) - new Date(a.ultimo_ts));

        if (filtered.length === 0) {
            if (chatEmpty) chatEmpty.style.display = 'block';
            return;
        }
        if (chatEmpty) chatEmpty.style.display = 'none';

        filtered.forEach(c => {
            const item = document.createElement('div');
            item.className = `chat-contact-item${activePhone === c.telefone ? ' active' : ''}`;
            item.dataset.phone = c.telefone;

            const icon = tipoIcon(c.ultimo_tipo);
            const previewText = icon || (c.ultimo_texto ? (c.ultimo_texto.length > 42 ? c.ultimo_texto.slice(0, 42) + '…' : c.ultimo_texto) : '');
            const previewClass = c.ultima_direcao === 'out' ? 'chat-contact-preview preview-out' : 'chat-contact-preview';
            const previewPrefix = c.ultima_direcao === 'out' ? '↪ ' : '';

            item.innerHTML = `
                <div class="chat-contact-avatar">${avatarLetter(c.nome)}</div>
                <div class="chat-contact-body">
                    <div class="chat-contact-name">${c.nome}${c.assumida_humano ? ' 🙋' : ''}</div>
                    <div class="${previewClass}">${previewPrefix}${previewText}</div>
                </div>
                <div class="chat-contact-meta">
                    <span class="chat-contact-time">${formatHora(c.ultimo_ts)}</span>
                    ${c.nao_lidas > 0 ? `<span class="chat-unread-badge">${c.nao_lidas}</span>` : ''}
                </div>
            `;
            item.addEventListener('click', () => openChat(c.telefone));
            contactList.appendChild(item);
        });
    }

    // ---- Atualiza ou insere um contato no mapa ----
    function upsertContact(data) {
        const existing = contacts.get(data.telefone) || {};
        contacts.set(data.telefone, { ...existing, ...data });
    }

    // ---- Abre o chat de um contato ----
    async function openChat(telefone) {
        activePhone = telefone;
        const c = contacts.get(telefone);
        const nome = c ? c.nome : telefone;

        // Atualiza header
        if (chatHeader)         chatHeader.style.display = 'flex';
        if (chatPlaceholder)    chatPlaceholder.style.display = 'none';
        if (chatHeaderAvatar)   chatHeaderAvatar.textContent = avatarLetter(nome);
        if (chatHeaderName)     chatHeaderName.textContent = nome;
        if (chatHeaderStatus)   chatHeaderStatus.textContent = telefone;
        renderChatHeaderTags(telefone);
        renderChatAssumirButton();
        if (chatMessages)       { chatMessages.style.display = 'flex'; chatMessages.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:2rem;font-size:.82rem">Carregando...</div>'; }
        if (chatInputBar)       chatInputBar.style.display = 'flex';
        if (chatTypingBar)      chatTypingBar.style.display = 'none';
        if (chatInput)          chatInput.value = '';

        // Atualiza item ativo na lista
        renderContactList();

        // Marca como lida
        if (c && c.nao_lidas > 0) {
            upsertContact({ ...c, nao_lidas: 0 });
            updateGlobalBadge();
            try { await fetch(`/api/conversas/${telefone}/lida`, { method: 'POST' }); } catch(_) {}
        }

        // Carrega histórico
        await loadHistory(telefone);
    }

    // ---- Assumir/liberar a conversa ativa ----
    function renderChatAssumirButton() {
        if (!btnChatAssumir || !activePhone) return;
        const c = contacts.get(activePhone);
        const assumida = !!c?.assumida_humano;
        btnChatAssumir.textContent = assumida ? '🤖 Devolver ao Robô' : '🙋 Assumir Conversa';
        btnChatAssumir.className = assumida ? 'btn-danger' : 'btn-secondary';
    }

    btnChatAssumir?.addEventListener('click', async () => {
        if (!activePhone) return;
        const c = contacts.get(activePhone);
        const assumida = !!c?.assumida_humano;
        const acao = assumida ? 'liberar' : 'assumir';
        try {
            await fetch(`/api/conversas/${encodeURIComponent(activePhone)}/${acao}`, { method: 'POST' });
            upsertContact({ telefone: activePhone, assumida_humano: assumida ? 0 : 1 });
            renderChatAssumirButton();
            renderContactList();
            showToast(assumida ? 'Conversa devolvida ao robô' : 'Conversa assumida', assumida ? '' : 'O robô não vai responder esse contato até você devolver.', 'success', 3000);
        } catch (e) {
            showToast('Erro', 'Não foi possível atualizar a conversa', 'error');
        }
    });

    // ---- Etiquetas do contato ativo ----
    async function renderChatHeaderTags(telefone) {
        if (!chatHeaderTags || !chatHeaderAddTag) return;
        chatHeaderTags.innerHTML = '';
        chatHeaderAddTag.innerHTML = '<option value="">🏷️ Etiqueta...</option>';
        try {
            const [res] = await Promise.all([fetch(`/api/contatos/${encodeURIComponent(telefone)}/etiquetas`), loadEtiquetas()]);
            const aplicadas = await res.json();
            if (activePhone !== telefone) return; // usuário já trocou de contato

            chatHeaderTags.innerHTML = aplicadas.map(e => etiquetaChipHtml(e, true)).join('');
            const aplicadasIds = new Set(aplicadas.map(e => e.id));
            todasEtiquetas.filter(e => !aplicadasIds.has(e.id)).forEach(e => {
                const opt = document.createElement('option');
                opt.value = e.id;
                opt.textContent = e.nome;
                chatHeaderAddTag.appendChild(opt);
            });
            const optNova = document.createElement('option');
            optNova.value = '__nova__';
            optNova.textContent = '➕ Criar nova etiqueta...';
            chatHeaderAddTag.appendChild(optNova);
        } catch (e) {
            console.error('Erro ao carregar etiquetas do contato', e);
        }
    }

    chatHeaderTags?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.etiqueta-chip-remove');
        if (!btn || !activePhone) return;
        await removerEtiquetaContato(activePhone, btn.dataset.etiquetaId);
        renderChatHeaderTags(activePhone);
    });

    chatHeaderAddTag?.addEventListener('change', async () => {
        const val = chatHeaderAddTag.value;
        if (!val || !activePhone) return;
        const telefone = activePhone;
        if (val === '__nova__') {
            const nova = await criarEtiquetaRapida();
            if (nova) await aplicarEtiquetaContato(telefone, nova.id);
        } else {
            await aplicarEtiquetaContato(telefone, Number(val));
        }
        renderChatHeaderTags(telefone);
    });

    // ---- Carrega e exibe histórico de mensagens ----
    async function loadHistory(telefone) {
        if (!chatMessages) return;
        try {
            const res  = await fetch(`/api/conversas/${encodeURIComponent(telefone)}?limit=150`);
            const msgs = await res.json();

            chatMessages.innerHTML = '';
            if (!msgs || msgs.length === 0) {
                chatMessages.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:3rem;font-size:.82rem">Nenhuma mensagem ainda.</div>';
                return;
            }

            let lastDate = null;
            msgs.forEach(m => {
                // Separador de data
                const dateSep = formatDataSep(m.ts);
                if (dateSep !== lastDate) {
                    const sep = document.createElement('div');
                    sep.className = 'chat-date-sep';
                    sep.textContent = dateSep;
                    chatMessages.appendChild(sep);
                    lastDate = dateSep;
                }
                appendBubble(m);
            });

            // Scrolla para o fundo
            chatMessages.scrollTop = chatMessages.scrollHeight;
        } catch(err) {
            chatMessages.innerHTML = '<div style="text-align:center;color:var(--red);padding:2rem;font-size:.82rem">Erro ao carregar histórico.</div>';
        }
    }

    // ---- Cria e adiciona uma bolha de mensagem ----
    function appendBubble(m, scroll = false) {
        if (!chatMessages) return;
        const wrap = document.createElement('div');
        wrap.className = `chat-bubble-wrap ${m.direcao}`;

        const isManual = m.manual === true;
        const bubbleClass = `chat-bubble ${m.direcao}${isManual ? ' manual' : ''}`;
        const icon = tipoIcon(m.tipo);

        let senderLabel = '';
        if (m.direcao === 'out') {
            senderLabel = isManual
                ? `<div class="bubble-sender manual">👤 Operador</div>`
                : `<div class="bubble-sender">🤖 Bot</div>`;
        }

        const bodyHtml = icon
            ? `<span class="bubble-type-badge">${icon}</span>`
            : `<div class="bubble-text">${escapeHtml(m.texto || '')}</div>`;

        wrap.innerHTML = `
            <div class="${bubbleClass}">
                ${senderLabel}
                ${bodyHtml}
                <div class="bubble-time">${formatHoraCompleta(m.ts)}</div>
            </div>
        `;

        chatMessages.appendChild(wrap);
        if (scroll) chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function escapeHtml(str) {
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    // ---- Envia mensagem manual ----
    async function sendManual() {
        if (!activePhone || !chatInput) return;
        const texto = chatInput.value.trim();
        if (!texto) return;

        chatInput.value = '';
        chatInput.style.height = 'auto';
        btnSend.disabled = true;

        try {
            const res = await fetch(`/api/conversas/${encodeURIComponent(activePhone)}/enviar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ texto })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Erro ao enviar');
            // A bolha já vai aparecer via evento socket nova_mensagem
        } catch(err) {
            showToast('Erro ao enviar', err.message, 'error');
            chatInput.value = texto; // Restaura o texto
        } finally {
            btnSend.disabled = false;
            chatInput.focus();
        }
    }

    // ---- API pública ----
    function init() {
        // Busca de contato
        searchInput?.addEventListener('input', () => {
            searchQuery = searchInput.value.trim();
            renderContactList();
        });

        // Envio por botão
        btnSend?.addEventListener('click', sendManual);

        // Envio por Enter (Shift+Enter = nova linha)
        chatInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendManual();
            }
        });

        // Auto-resize do textarea
        chatInput?.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        });

        // Recarregar histórico
        btnReload?.addEventListener('click', () => {
            if (activePhone) loadHistory(activePhone);
        });

        // Eventos Socket.IO
        socket.on('all_conversas', (lista) => {
            contacts.clear();
            lista.forEach(c => contacts.set(c.telefone, c));
            updateGlobalBadge();
            renderContactList();
        });

        socket.on('nova_mensagem', (data) => {
            // Atualiza o mapa de contatos
            const existing = contacts.get(data.telefone) || {};
            const naoLidas = data.direcao === 'in' && activePhone !== data.telefone
                ? (existing.nao_lidas || 0) + 1
                : (data.direcao === 'in' && activePhone === data.telefone ? 0 : existing.nao_lidas || 0);

            upsertContact({
                telefone: data.telefone,
                nome: data.nome || existing.nome || data.telefone,
                ultimo_texto: data.texto,
                ultima_direcao: data.direcao,
                ultimo_tipo: data.tipo,
                ultimo_ts: data.ts,
                nao_lidas: naoLidas
            });

            updateGlobalBadge();
            renderContactList();

            // Se é a conversa ativa, adiciona a bolha
            if (activePhone === data.telefone && chatMessages && chatMessages.style.display !== 'none') {
                // Adiciona separador de data se necessário
                const items = chatMessages.querySelectorAll('.chat-date-sep');
                const lastSep = items[items.length - 1];
                const dateSep = formatDataSep(data.ts);
                if (!lastSep || lastSep.textContent !== dateSep) {
                    const sep = document.createElement('div');
                    sep.className = 'chat-date-sep';
                    sep.textContent = dateSep;
                    chatMessages.appendChild(sep);
                }
                appendBubble(data, true);

                // Marca como lida automaticamente (chat aberto)
                if (data.direcao === 'in') {
                    const c = contacts.get(data.telefone);
                    if (c) { upsertContact({ ...c, nao_lidas: 0 }); updateGlobalBadge(); }
                    fetch(`/api/conversas/${data.telefone}/lida`, { method: 'POST' }).catch(() => {});
                }
            }
        });

        socket.on('bot_digitando', ({ telefone, ativo }) => {
            if (activePhone === telefone && chatTypingBar) {
                chatTypingBar.style.display = ativo ? 'block' : 'none';
            }
        });

        socket.on('etiqueta_atualizada', ({ telefone }) => {
            if (activePhone === telefone) renderChatHeaderTags(telefone);
        });

        socket.on('conversa_assumida', ({ telefone, assumida }) => {
            upsertContact({ telefone, assumida_humano: assumida ? 1 : 0 });
            renderContactList();
            if (activePhone === telefone) renderChatAssumirButton();
        });

        socket.on('conversa_lida', ({ telefone }) => {
            const c = contacts.get(telefone);
            if (c) { upsertContact({ ...c, nao_lidas: 0 }); updateGlobalBadge(); renderContactList(); }
        });
    }

    function onEnterSection() {
        // Recarrega a lista ao entrar na seção
        fetch('/api/conversas').then(r => r.json()).then(lista => {
            contacts.clear();
            lista.forEach(c => contacts.set(c.telefone, c));
            updateGlobalBadge();
            renderContactList();
        }).catch(() => {});
    }

    return { init, onEnterSection };
})();

// Inicializa o ConversationManager
CM.init();

// =====================================
// INTEGRAÇÃO — CRM PACTO (CARTEIRA DO DIA)
// =====================================
const crmConsultorSelect = document.getElementById('crm-consultor');
const btnCrmAbrirCarteira = document.getElementById('btn-crm-abrir-carteira');
const crmCarteiraResultado = document.getElementById('crm-carteira-resultado');

async function loadCrmColaboradores() {
    if (!crmConsultorSelect) return;
    try {
        const res = await fetch('/api/crm/colaboradores');
        const colaboradores = await res.json();
        if (!res.ok) throw new Error(colaboradores.error || 'Erro ao carregar consultores');
        crmConsultorSelect.innerHTML = colaboradores
            .map(c => `<option value="${c.codigoColaborador}">${c.nomeColaborador}</option>`)
            .join('');
    } catch (e) {
        crmConsultorSelect.innerHTML = '<option value="">Erro ao carregar consultores</option>';
        console.error('Erro ao carregar colaboradores do CRM', e);
    }
}

function renderCrmCategoria(titulo, itens) {
    const linhas = itens.map(m => `
        <div style="display:flex;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid rgba(255,255,255,0.05)">
            <span>${m.identificadorMetaApresentar}</span>
            <span style="color:var(--text-1);font-weight:600">${m.metaAtingida}</span>
        </div>
    `).join('');
    return `<div style="margin-top:.8rem"><strong style="color:var(--text-1);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em">${titulo}</strong>${linhas}</div>`;
}

btnCrmAbrirCarteira?.addEventListener('click', async () => {
    const codigoColaboradorResponsavel = crmConsultorSelect?.value;
    if (!codigoColaboradorResponsavel) {
        showToast('Selecione um consultor', '', 'error');
        return;
    }
    crmCarteiraResultado.innerHTML = '⏳ Abrindo carteira do dia...';
    try {
        const res = await fetch('/api/crm/carteira/abrir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codigoColaboradorResponsavel: Number(codigoColaboradorResponsavel) })
        });
        const carteira = await res.json();
        if (!res.ok) throw new Error(carteira.error || 'Erro ao abrir carteira');

        crmCarteiraResultado.innerHTML = `
            <div style="color:var(--text-1)"><strong>${carteira.nomeColaboradorResponsavel}</strong> — ${carteira.diaApresentar}</div>
            ${renderCrmCategoria('Retenção', carteira.metasRetencao)}
            ${renderCrmCategoria('Leads', carteira.metasLead)}
            ${renderCrmCategoria('Vendas', carteira.metasVenda)}
        `;
    } catch (e) {
        crmCarteiraResultado.innerHTML = `<span style="color:var(--red)">❌ ${e.message}</span>`;
    }
});
