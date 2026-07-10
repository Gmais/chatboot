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
    loadNovosContatosChart();
});

// =====================================
// GRÁFICO: NOVOS CONTATOS POR DIA
// =====================================
function mostrarChartTooltip(el, valor, rotulo) {
    let tip = document.getElementById('chart-tooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'chart-tooltip';
        tip.style.cssText = 'position:fixed;z-index:2000;background:var(--card-bg);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:.4rem .6rem;font-size:.75rem;pointer-events:none;box-shadow:var(--shadow);white-space:nowrap;text-align:center';
        const strong = document.createElement('strong');
        strong.id = 'chart-tooltip-valor';
        strong.style.cssText = 'color:var(--text-1);display:block';
        const span = document.createElement('span');
        span.id = 'chart-tooltip-rotulo';
        span.style.color = 'var(--text-3)';
        tip.append(strong, span);
        document.body.appendChild(tip);
    }
    tip.querySelector('#chart-tooltip-valor').textContent = valor;
    tip.querySelector('#chart-tooltip-rotulo').textContent = rotulo;
    const rect = el.getBoundingClientRect();
    tip.style.left = (rect.left + rect.width / 2) + 'px';
    tip.style.top = (rect.top - 8) + 'px';
    tip.style.transform = 'translate(-50%, -100%)';
    tip.style.display = 'block';
    el.style.filter = 'brightness(1.25)';
}
function esconderChartTooltip(e) {
    const tip = document.getElementById('chart-tooltip');
    if (tip) tip.style.display = 'none';
    if (e?.currentTarget) e.currentTarget.style.filter = '';
}

async function loadNovosContatosChart() {
    const container = document.getElementById('novos-contatos-chart');
    const eixo = document.getElementById('novos-contatos-eixo');
    const totalEl = document.getElementById('novos-contatos-total');
    if (!container) return;
    try {
        const res = await fetch('/api/leads/por-dia?dias=14');
        const dias = await res.json();
        const max = Math.max(1, ...dias.map(d => d.total));
        const total = dias.reduce((soma, d) => soma + d.total, 0);
        if (totalEl) totalEl.textContent = `${total} no período`;

        container.innerHTML = '';
        dias.forEach(d => {
            const alturaPerc = Math.max(4, Math.round((d.total / max) * 100));
            const bar = document.createElement('div');
            bar.className = 'novos-contatos-bar';
            bar.tabIndex = 0;
            bar.style.cssText = `flex:1;height:${alturaPerc}%;background:var(--green);border-radius:4px 4px 0 0;min-width:4px;cursor:pointer;transition:filter .15s`;
            const dataFmt = new Date(d.data + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
            const rotularEValor = d.total === 1 ? '1 contato' : `${d.total} contatos`;
            const mostrar = () => mostrarChartTooltip(bar, rotularEValor, dataFmt);
            bar.addEventListener('mouseenter', mostrar);
            bar.addEventListener('focus', mostrar);
            bar.addEventListener('mouseleave', esconderChartTooltip);
            bar.addEventListener('blur', esconderChartTooltip);
            container.appendChild(bar);
        });

        if (eixo) {
            eixo.innerHTML = '';
            dias.forEach(d => {
                const lbl = document.createElement('span');
                lbl.style.cssText = 'flex:1;text-align:center;font-size:.65rem;color:var(--text-3);min-width:4px';
                lbl.textContent = d.diaMes;
                eixo.appendChild(lbl);
            });
        }
    } catch (e) {
        console.error('Erro ao carregar gráfico de novos contatos', e);
        container.innerHTML = '<p style="color:var(--text-3);text-align:center;width:100%;font-size:.85rem">Erro ao carregar.</p>';
    }
}

loadNovosContatosChart();

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
        if (targetId === 'fluxos-section') { loadEtiquetas().then(() => loadFluxos()); }
        if (targetId === 'contatos-section' || targetId === 'disparos-section') loadContatos();
        if (targetId === 'integracoes-section') { loadCrmColaboradores(); loadPactoInadimplentes(); }
        if (targetId === 'automacoes-section') { loadEtiquetas().then(() => loadAutomacoes()); }
        if (targetId === 'mensagens-personalizadas-section') loadMensagensPersonalizadas();
        if (targetId === 'disparos-section') { loadAcompanhamentoAutomacoes(); loadAutomacaoDelayConfig(); }
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
const iaCampanhaMes = document.getElementById('ia-campanha-mes');
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
        if (iaCampanhaMes) iaCampanhaMes.value = config.ia_campanha_mes || '';
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
        ia_campanha_mes: iaCampanhaMes.value.trim(),
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

// =====================================
// MODAL: GERENCIAR ETIQUETAS (editar/excluir)
// =====================================
const modalEtiquetasOverlay = document.getElementById('modal-etiquetas-overlay');
const etiquetasGerenciarLista = document.getElementById('etiquetas-gerenciar-lista');

function renderGerenciarEtiquetasLista() {
    if (!etiquetasGerenciarLista) return;
    if (todasEtiquetas.length === 0) {
        etiquetasGerenciarLista.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:1rem">Nenhuma etiqueta ainda.</p>';
        return;
    }
    etiquetasGerenciarLista.innerHTML = todasEtiquetas.map(e => `
        <div class="etiqueta-gerenciar-row" data-id="${e.id}" style="display:flex;align-items:center;gap:.6rem;padding:.6rem;background:rgba(255,255,255,0.03);border-radius:8px">
            <input type="color" class="etiqueta-cor-input" value="${e.cor}" style="width:34px;height:34px;border:none;border-radius:6px;cursor:pointer;background:none;flex-shrink:0">
            <input type="text" class="etiqueta-nome-input" value="${e.nome}" style="flex:1;min-width:0;background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:.4rem .6rem;color:var(--text-1);font-family:'Inter',sans-serif">
            <span style="color:var(--text-3);font-size:.72rem;white-space:nowrap">${e.total_contatos} contato${e.total_contatos !== 1 ? 's' : ''}</span>
            <button type="button" class="btn-secondary etiqueta-salvar-btn" style="padding:.4rem .6rem;font-size:.75rem" title="Salvar">💾</button>
            <button type="button" class="btn-danger etiqueta-excluir-btn" style="padding:.4rem .6rem;font-size:.75rem" title="Excluir">🗑️</button>
        </div>
    `).join('');
}

async function abrirGerenciarEtiquetas() {
    await loadEtiquetas();
    renderGerenciarEtiquetasLista();
    modalEtiquetasOverlay?.classList.add('open');
}

function fecharGerenciarEtiquetas() { modalEtiquetasOverlay?.classList.remove('open'); }

document.getElementById('modal-etiquetas-fechar')?.addEventListener('click', fecharGerenciarEtiquetas);
modalEtiquetasOverlay?.addEventListener('click', (e) => { if (e.target === modalEtiquetasOverlay) fecharGerenciarEtiquetas(); });

document.getElementById('btn-etiquetas-nova')?.addEventListener('click', async () => {
    const nova = await criarEtiquetaRapida();
    if (nova) renderGerenciarEtiquetasLista();
});

etiquetasGerenciarLista?.addEventListener('click', async (e) => {
    const row = e.target.closest('.etiqueta-gerenciar-row');
    if (!row) return;
    const id = row.dataset.id;

    if (e.target.closest('.etiqueta-salvar-btn')) {
        const nome = row.querySelector('.etiqueta-nome-input').value.trim();
        const cor = row.querySelector('.etiqueta-cor-input').value;
        if (!nome) { showToast('Erro', 'Nome não pode ficar em branco', 'error'); return; }
        try {
            const res = await fetch(`/api/etiquetas/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome, cor })
            });
            const atualizada = await res.json();
            if (!res.ok) throw new Error(atualizada.error || 'Erro ao salvar');
            showToast('Etiqueta atualizada', nome, 'success', 2500);
        } catch (err) {
            showToast('Erro', err.message, 'error');
        }
    }

    if (e.target.closest('.etiqueta-excluir-btn')) {
        const nome = row.querySelector('.etiqueta-nome-input').value.trim();
        if (!confirm(`Excluir a etiqueta "${nome}"? Ela será removida de todos os contatos e regras.`)) return;
        await fetch(`/api/etiquetas/${id}`, { method: 'DELETE' });
        showToast('Etiqueta excluída', nome, 'info', 2500);
    }
});

// Reflete mudanças de etiquetas (criadas/editadas/excluídas de qualquer lugar,
// inclusive por outro operador) em todas as telas que usam etiquetas.
socket.on('etiquetas_atualizadas', async () => {
    await loadEtiquetas();
    if (modalEtiquetasOverlay?.classList.contains('open')) renderGerenciarEtiquetasLista();
    renderFiltroEtiquetas();
    renderContatos();
    renderFiltroEtiquetasPage();
    renderContatosPage();
    // O select de etiqueta da modal de Regras e os chips do cabeçalho de
    // Conversas não são atualizados aqui de propósito: mexer neles enquanto o
    // operador pode estar no meio de uma edição atrapalharia mais do que ajudaria.
});

document.getElementById('btn-gerenciar-etiquetas-disparos')?.addEventListener('click', abrirGerenciarEtiquetas);
document.getElementById('btn-modal-gerenciar-etiqueta')?.addEventListener('click', abrirGerenciarEtiquetas);
document.getElementById('btn-gerenciar-etiquetas-page')?.addEventListener('click', abrirGerenciarEtiquetas);

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

// Elementos da nova página "Contatos"
const contatosPageBusca       = document.getElementById('contatos-page-busca');
const contatosPageFiltroEtiquetas = document.getElementById('contatos-page-filtro-etiquetas');
const contatosPageTableBody   = document.getElementById('contatos-page-table-body');
const btnGerenciarEtiquetasPage = document.getElementById('btn-gerenciar-etiquetas-page');

let todosContatos = [];
const contatosSelecionados = new Set();
const etiquetasFiltroAtivas = new Set();
const etiquetasFiltroAtivasPage = new Set();

function contatosFiltrados() {
    const termo = (contatosBusca?.value || '').trim().toLowerCase();
    return todosContatos.filter(c => {
        const bateBusca = !termo || c.nome.toLowerCase().includes(termo) || c.telefone.includes(termo) || (c.matricula || '').toLowerCase().includes(termo);
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

function renderFiltroEtiquetasPage() {
    if (!contatosPageFiltroEtiquetas) return;
    if (todasEtiquetas.length === 0) { contatosPageFiltroEtiquetas.innerHTML = ''; return; }
    contatosPageFiltroEtiquetas.innerHTML = todasEtiquetas.map(e => `
        <button type="button" class="etiqueta-filtro-chip${etiquetasFiltroAtivasPage.has(e.id) ? ' active' : ''}"
            data-etiqueta-id="${e.id}"
            style="${etiquetasFiltroAtivasPage.has(e.id) ? `background:${e.cor};border-color:${e.cor}` : `border-color:${e.cor}55;color:${e.cor}`}">
            ${e.nome}
        </button>
    `).join('');
}

contatosPageFiltroEtiquetas?.addEventListener('click', (e) => {
    const chip = e.target.closest('.etiqueta-filtro-chip');
    if (!chip) return;
    const id = Number(chip.dataset.etiquetaId);
    if (etiquetasFiltroAtivasPage.has(id)) etiquetasFiltroAtivasPage.delete(id);
    else etiquetasFiltroAtivasPage.add(id);
    renderFiltroEtiquetasPage();
    renderContatosPage();
});

function atualizarContadorContatos() {
    const n = contatosSelecionados.size;
    if (!contatosContador) return;
    contatosContador.textContent = `${n} contato${n !== 1 ? 's' : ''} selecionado${n !== 1 ? 's' : ''}`;
    if (contatosSelectAll) {
        const visiveis = contatosFiltrados();
        contatosSelectAll.checked = visiveis.length > 0 && visiveis.every(c => contatosSelecionados.has(c.telefone));
    }
}

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

function contatosPageFiltrados() {
    const termo = (contatosPageBusca?.value || '').trim().toLowerCase();
    return todosContatos.filter(c => {
        const bateBusca = !termo || c.nome.toLowerCase().includes(termo) || c.telefone.includes(termo) || (c.matricula || '').toLowerCase().includes(termo);
        const bateEtiqueta = etiquetasFiltroAtivasPage.size === 0 || c.etiquetas.some(e => etiquetasFiltroAtivasPage.has(e.id));
        return bateBusca && bateEtiqueta;
    });
}

function renderContatosPage() {
    if (!contatosPageTableBody) return;
    const filtrados = contatosPageFiltrados();
    if (filtrados.length === 0) {
        contatosPageTableBody.innerHTML = '<tr><td colspan="6" style="padding:2rem;text-align:center;color:var(--text-3)">Nenhum contato encontrado.</td></tr>';
        return;
    }
    contatosPageTableBody.innerHTML = filtrados.map(c => {
        const dataStr = c.data_captura ? new Date(c.data_captura).toLocaleString('pt-BR') : '-';
        return `
            <tr class="contatos-page-row" data-telefone="${c.telefone}" style="cursor:pointer">
                <td>
                    <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
                        <span style="font-weight:500;color:var(--text-1)">${c.nome}</span>
                        ${c.etiquetas.map(e => etiquetaChipHtml(e, false)).join('')}
                    </div>
                    <div style="font-size:.75rem;color:var(--text-3)">${c.telefone}</div>
                </td>
                <td style="color:var(--text-2);font-size:.85rem">${c.matricula || '-'}</td>
                <td style="color:var(--text-2);font-size:.85rem">${formatarDataNascimento(c.data_nascimento)}</td>
                <td style="color:var(--text-2);font-size:.85rem">${dataStr}</td>
                <td style="text-align:right;color:var(--text-2)">
                    <span style="background:rgba(255,255,255,0.05);padding:.2rem .5rem;border-radius:4px">${c.mensagens_recebidas} msg${c.mensagens_recebidas !== 1 ? 's' : ''}</span>
                </td>
                <td style="text-align:right">
                    <button type="button" class="btn-danger btn-excluir-contato" data-telefone="${c.telefone}" data-nome="${c.nome}" style="padding:.35rem .6rem;font-size:.75rem" title="Excluir contato">🗑️</button>
                </td>
            </tr>
        `;
    }).join('');
}

async function loadContatos() {
    try {
        const [res] = await Promise.all([fetch('/api/contatos'), loadEtiquetas()]);
        todosContatos = await res.json();
        renderFiltroEtiquetas();
        renderFiltroEtiquetasPage();
        renderContatos();
        renderContatosPage();
    } catch (e) {
        console.error('Erro ao carregar contatos', e);
        if (contatosLista) contatosLista.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:2rem">Erro ao carregar contatos.</p>';
        if (contatosPageTableBody) contatosPageTableBody.innerHTML = '<tr><td colspan="6" style="padding:2rem;text-align:center;color:var(--text-3)">Erro ao carregar contatos.</td></tr>';
    }
}

// =====================================
// MODAL: EDITAR CONTATO (Audiência)
// =====================================
const modalEditarContatoOverlay = document.getElementById('modal-editar-contato-overlay');
const editarContatoNome = document.getElementById('editar-contato-nome');
const editarContatoMatricula = document.getElementById('editar-contato-matricula');
const editarContatoNascimento = document.getElementById('editar-contato-nascimento');
const editarContatoTelefone = document.getElementById('editar-contato-telefone');

// leads.data_nascimento pode vir como "YYYY-MM-DD" (digitado manualmente) ou
// como timestamp ISO completo (importado do Pacto) — <input type="date"> só
// aceita "YYYY-MM-DD", daí o corte dos 10 primeiros caracteres cobre os dois casos.
function paraInputDate(valor) {
    return valor ? String(valor).slice(0, 10) : '';
}
const editarContatoEtiquetas = document.getElementById('editar-contato-etiquetas');
const editarContatoAddEtiqueta = document.getElementById('editar-contato-add-etiqueta');
const btnEditarContatoSalvar = document.getElementById('btn-editar-contato-salvar');
let contatoEditandoTelefone = null;

async function renderEditarContatoEtiquetas() {
    if (!editarContatoEtiquetas || !editarContatoAddEtiqueta || !contatoEditandoTelefone) return;
    editarContatoEtiquetas.innerHTML = '';
    editarContatoAddEtiqueta.innerHTML = '<option value="">🏷️ Adicionar etiqueta...</option>';
    try {
        const [res] = await Promise.all([fetch(`/api/contatos/${encodeURIComponent(contatoEditandoTelefone)}/etiquetas`), loadEtiquetas()]);
        const aplicadas = await res.json();
        if (contatoEditandoTelefone === null) return;

        editarContatoEtiquetas.innerHTML = aplicadas.length > 0
            ? aplicadas.map(e => etiquetaChipHtml(e, true)).join('')
            : '<span style="color:var(--text-3);font-size:.8rem">Nenhuma etiqueta ainda.</span>';

        const aplicadasIds = new Set(aplicadas.map(e => e.id));
        todasEtiquetas.filter(e => !aplicadasIds.has(e.id)).forEach(e => {
            const opt = document.createElement('option');
            opt.value = e.id;
            opt.textContent = e.nome;
            editarContatoAddEtiqueta.appendChild(opt);
        });
    } catch (e) {
        editarContatoEtiquetas.innerHTML = '<span style="color:var(--text-3);font-size:.8rem">Erro ao carregar etiquetas.</span>';
    }
}

function abrirEditarContato(telefone) {
    const c = todosContatos.find(x => x.telefone === telefone);
    if (!c) return;
    contatoEditandoTelefone = telefone;
    if (editarContatoNome) editarContatoNome.value = c.nome === telefone ? '' : c.nome;
    if (editarContatoMatricula) editarContatoMatricula.value = c.matricula || '';
    if (editarContatoNascimento) editarContatoNascimento.value = paraInputDate(c.data_nascimento);
    if (editarContatoTelefone) editarContatoTelefone.textContent = telefone;
    modalEditarContatoOverlay?.classList.add('open');
    renderEditarContatoEtiquetas();
}

function fecharEditarContato() {
    contatoEditandoTelefone = null;
    modalEditarContatoOverlay?.classList.remove('open');
}

contatosPageTableBody?.addEventListener('click', async (e) => {
    const btnExcluir = e.target.closest('.btn-excluir-contato');
    if (btnExcluir) {
        if (!confirm(`Excluir o contato "${btnExcluir.dataset.nome}"? Ele some da lista de Contatos, etiquetas e automações em andamento (o histórico de conversa no Bate Papo ao Vivo continua).`)) return;
        try {
            const res = await fetch(`/api/contatos/${encodeURIComponent(btnExcluir.dataset.telefone)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Falha ao excluir');
            showToast('Contato excluído', '', 'success', 2500);
            loadContatos();
        } catch (err) {
            showToast('Erro', 'Não foi possível excluir o contato', 'error');
        }
        return;
    }

    const row = e.target.closest('.contatos-page-row');
    if (!row) return;
    abrirEditarContato(row.dataset.telefone);
});

document.getElementById('modal-editar-contato-fechar')?.addEventListener('click', fecharEditarContato);

editarContatoEtiquetas?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.etiqueta-chip-remove');
    if (!btn || !contatoEditandoTelefone) return;
    await removerEtiquetaContato(contatoEditandoTelefone, btn.dataset.etiquetaId);
    renderEditarContatoEtiquetas();
});

editarContatoAddEtiqueta?.addEventListener('change', async () => {
    const val = editarContatoAddEtiqueta.value;
    if (!val || !contatoEditandoTelefone) return;
    await aplicarEtiquetaContato(contatoEditandoTelefone, Number(val));
    renderEditarContatoEtiquetas();
});

btnEditarContatoSalvar?.addEventListener('click', async () => {
    if (!contatoEditandoTelefone) return;
    const nome = (editarContatoNome?.value || '').trim();
    const matricula = (editarContatoMatricula?.value || '').trim();
    const data_nascimento = (editarContatoNascimento?.value || '').trim() || null;
    if (!nome) { showToast('Nome obrigatório', 'Digite um nome para o contato.', 'error'); return; }
    try {
        const res = await fetch(`/api/contatos/${encodeURIComponent(contatoEditandoTelefone)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, matricula, data_nascimento })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao salvar');
        showToast('Contato atualizado!', '', 'success', 2500);
        fecharEditarContato();
        loadContatos();
    } catch (e) {
        showToast('Erro ao salvar', e.message, 'error');
    }
});

contatosLista?.addEventListener('change', (e) => {
    const check = e.target.closest('.contato-check');
    if (!check) return;
    if (check.checked) contatosSelecionados.add(check.dataset.telefone);
    else contatosSelecionados.delete(check.dataset.telefone);
    atualizarContadorContatos();
});

contatosBusca?.addEventListener('input', renderContatos);
contatosPageBusca?.addEventListener('input', renderContatosPage);

// =====================================
// IMPORTAR CONTATOS (planilha CSV)
// =====================================
const modalImportarOverlay   = document.getElementById('modal-importar-contatos-overlay');
const importarContatosArquivo = document.getElementById('importar-contatos-arquivo');
const importarContatosResultado = document.getElementById('importar-contatos-resultado');
const btnImportarContatosEnviar = document.getElementById('btn-importar-contatos-enviar');

function abrirModalImportarContatos() {
    if (importarContatosArquivo) importarContatosArquivo.value = '';
    if (importarContatosResultado) importarContatosResultado.innerHTML = '';
    modalImportarOverlay?.classList.add('open');
}
function fecharModalImportarContatos() {
    modalImportarOverlay?.classList.remove('open');
}

document.getElementById('btn-importar-contatos')?.addEventListener('click', abrirModalImportarContatos);
document.getElementById('modal-importar-contatos-fechar')?.addEventListener('click', fecharModalImportarContatos);

btnImportarContatosEnviar?.addEventListener('click', async () => {
    const arquivo = importarContatosArquivo?.files?.[0];
    if (!arquivo) {
        showToast('Selecione um arquivo', 'Escolha um arquivo .csv para importar.', 'error');
        return;
    }
    btnImportarContatosEnviar.disabled = true;
    btnImportarContatosEnviar.textContent = 'Importando...';
    try {
        const formData = new FormData();
        formData.append('planilha', arquivo);
        const res = await fetch('/api/contatos/importar', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Falha ao importar.');
        if (importarContatosResultado) {
            importarContatosResultado.innerHTML = `
                <div style="background:rgba(37,211,102,0.1);border:1px solid rgba(37,211,102,0.3);border-radius:8px;padding:.8rem">
                    ✅ ${data.importados} novo(s) contato(s) importado(s)<br>
                    🔄 ${data.atualizados} contato(s) já existente(s) atualizado(s)<br>
                    ${data.ignorados > 0 ? `⚠️ ${data.ignorados} linha(s) ignorada(s) (telefone inválido)` : ''}
                </div>`;
        }
        showToast('Importação concluída!', `${data.importados + data.atualizados} contato(s) processado(s).`, 'success');
        loadContatos();
    } catch (e) {
        showToast('Erro ao importar', e.message, 'error');
    } finally {
        btnImportarContatosEnviar.disabled = false;
        btnImportarContatosEnviar.textContent = 'Importar';
    }
});

// =====================================
// NOVO CONTATO (criação manual)
// =====================================
const modalNovoContato = document.getElementById('modal-novo-contato-overlay');
const novoContatoNome = document.getElementById('novo-contato-nome');
const novoContatoTelefone = document.getElementById('novo-contato-telefone');
const novoContatoNascimento = document.getElementById('novo-contato-nascimento');
const novoContatoEtiqueta = document.getElementById('novo-contato-etiqueta');
const btnNovoContatoSalvar = document.getElementById('btn-novo-contato-salvar');

async function abrirModalNovoContato() {
    if (novoContatoNome) novoContatoNome.value = '';
    if (novoContatoTelefone) novoContatoTelefone.value = '';
    if (novoContatoNascimento) novoContatoNascimento.value = '';
    if (novoContatoEtiqueta) {
        await loadEtiquetas();
        novoContatoEtiqueta.innerHTML = '<option value="">Nenhuma</option>' +
            todasEtiquetas.map(e => `<option value="${e.id}">${e.nome}</option>`).join('');
    }
    modalNovoContato?.classList.add('open');
}
function fecharModalNovoContato() {
    modalNovoContato?.classList.remove('open');
}

document.getElementById('btn-novo-contato')?.addEventListener('click', abrirModalNovoContato);
document.getElementById('modal-novo-contato-fechar')?.addEventListener('click', fecharModalNovoContato);

btnNovoContatoSalvar?.addEventListener('click', async () => {
    const nome = (novoContatoNome?.value || '').trim();
    const telefone = (novoContatoTelefone?.value || '').trim();
    const data_nascimento = (novoContatoNascimento?.value || '').trim() || null;
    const etiqueta_id = novoContatoEtiqueta?.value;
    if (!nome) { showToast('Nome obrigatório', 'Digite o nome do contato.', 'error'); return; }
    if (!telefone) { showToast('Telefone obrigatório', 'Digite o telefone com DDD.', 'error'); return; }
    btnNovoContatoSalvar.disabled = true;
    try {
        const res = await fetch('/api/contatos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, telefone, data_nascimento, etiqueta_id: etiqueta_id ? Number(etiqueta_id) : null })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao criar contato');
        showToast('Contato criado!', '', 'success', 2500);
        fecharModalNovoContato();
        loadContatos();
    } catch (e) {
        showToast('Erro ao criar contato', e.message, 'error');
    } finally {
        btnNovoContatoSalvar.disabled = false;
    }
});

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

const broadcastDelayModo   = document.getElementById('broadcast-delay-modo');
const broadcastDelayFixoGroup = document.getElementById('broadcast-delay-fixo-group');
const broadcastDelayAleatorioGroup = document.getElementById('broadcast-delay-aleatorio-group');

broadcastDelayModo?.addEventListener('change', () => {
    const aleatorio = broadcastDelayModo.value === 'aleatorio';
    if (broadcastDelayFixoGroup) broadcastDelayFixoGroup.style.display = aleatorio ? 'none' : 'block';
    if (broadcastDelayAleatorioGroup) broadcastDelayAleatorioGroup.style.display = aleatorio ? 'block' : 'none';
});

btnDisparar?.addEventListener('click', async () => {
    const numeros  = document.getElementById('broadcast-numeros')?.value;
    const mensagem = document.getElementById('broadcast-mensagem')?.value;
    if (!numeros?.trim())  { alert('Cole os números!'); return; }
    if (!mensagem?.trim()) { alert('Digite a mensagem!'); return; }
    const formData = new FormData();
    formData.append('numeros', numeros);
    formData.append('mensagem', mensagem);
    if (broadcastDelayModo?.value === 'aleatorio') {
        formData.append('delay_modo', 'aleatorio');
        formData.append('delay_velocidade', document.getElementById('broadcast-delay-velocidade')?.value || 'medio');
    } else {
        const delay_ms = (parseInt(document.getElementById('broadcast-delay')?.value) || 6) * 1000;
        formData.append('delay_modo', 'fixo');
        formData.append('delay_ms', delay_ms);
    }
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
    let contacts    = new Map(); // telefone -> { nome, ultimo_texto, ultima_direcao, ultimo_ts, nao_lidas, status, etiquetas }
    let activePhone = null;
    let totalNaoLidas = 0;
    let searchQuery = '';
    let activeTab = 'aberta'; // 'aberta' | 'fechada' | 'aguardando'
    let notifMuted = localStorage.getItem('chatNotifMuted') === '1';

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
    const btnChatResolver = document.getElementById('btn-chat-resolver');
    const btnChatExcluir = document.getElementById('btn-chat-excluir');
    const chatMessages   = document.getElementById('chat-messages');
    const chatInputBar   = document.getElementById('chat-input-bar');
    const chatTypingBar  = document.getElementById('chat-typing-bar');
    const chatInput      = document.getElementById('chat-input-text');
    const btnSend        = document.getElementById('btn-chat-send');
    const btnReload      = document.getElementById('btn-chat-reload');
    const searchInput    = document.getElementById('chat-search');
    const badgeNaoLidas  = document.getElementById('badge-nao-lidas');
    const tabAbertas     = document.getElementById('tab-chat-abertas');
    const tabFechadas    = document.getElementById('tab-chat-fechadas');
    const tabAguardando  = document.getElementById('tab-chat-aguardando');
    const btnVolume      = document.getElementById('btn-chat-volume');
    const btnNovaConversa = document.getElementById('btn-chat-nova-conversa');
    const btnEmoji        = document.getElementById('btn-chat-emoji');
    const emojiPicker     = document.getElementById('chat-emoji-picker');
    const btnAnexo         = document.getElementById('btn-chat-anexo');
    const anexoInput       = document.getElementById('chat-anexo-input');
    const modalNovaConversa = document.getElementById('modal-nova-conversa-overlay');
    const novaConversaBusca = document.getElementById('nova-conversa-busca');
    const novaConversaLista = document.getElementById('nova-conversa-lista');

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

    // ---- Som de notificação (sintetizado, sem depender de arquivo de áudio) ----
    function tocarNotificacao() {
        if (notifMuted) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.value = 880;
            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
            osc.start();
            osc.stop(ctx.currentTime + 0.35);
        } catch (_) {}
    }

    function atualizarIconeVolume() {
        if (btnVolume) btnVolume.textContent = notifMuted ? '🔕' : '🔔';
    }

    function tipoIcon(tipo) {
        const icons = { image: '🖼️ Imagem', audio: '🎤 Áudio', video: '🎥 Vídeo', document: '📄 Documento', sticker: '🎭 Sticker', ptt: '🎤 Áudio', location: '📍 Localização', contact: '👤 Contato' };
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

        // Filtra e ordena: por data decrescente. Abertas/Fechadas/Aguardando são
        // mutuamente exclusivas: Fechadas = status finalizada; dentro das não
        // finalizadas, Aguardando = assumida por humano (bot esperando ação
        // humana pra finalizar), Abertas = o resto.
        const filtered = [...contacts.values()].filter(c => {
            const status = c.status || 'aberta';
            const aba = status === 'fechada' ? 'fechada' : (c.assumida_humano ? 'aguardando' : 'aberta');
            if (aba !== activeTab) return false;
            if (!searchQuery) return true;
            const q = searchQuery.toLowerCase();
            const bateEtiqueta = (c.etiquetas || []).some(e => e.nome.toLowerCase().includes(q));
            return c.nome.toLowerCase().includes(q) || c.telefone.includes(q) || bateEtiqueta;
        }).sort((a, b) => new Date(b.ultimo_ts) - new Date(a.ultimo_ts));

        if (filtered.length === 0) {
            if (chatEmpty) {
                chatEmpty.style.display = 'block';
                chatEmpty.textContent = activeTab === 'fechada'
                    ? 'Nenhuma conversa finalizada ainda.'
                    : activeTab === 'aguardando'
                        ? 'Nenhuma conversa aguardando interação humana.'
                        : 'Nenhuma conversa encontrada.';
            }
            return;
        }
        if (chatEmpty) chatEmpty.style.display = 'none';

        filtered.forEach(c => {
            const item = document.createElement('div');
            item.className = `chat-contact-item${activePhone === c.telefone ? ' active' : ''}`;
            item.dataset.phone = c.telefone;

            const icon = tipoIcon(c.ultimo_tipo);
            const temTextoRealPreview = c.ultimo_texto && !/^\[.*\]$/.test(c.ultimo_texto.trim());
            const previewText = (icon && !temTextoRealPreview)
                ? icon
                : (c.ultimo_texto ? (c.ultimo_texto.length > 42 ? c.ultimo_texto.slice(0, 42) + '…' : c.ultimo_texto) : (icon || ''));
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

    // ---- Resolver (fechar) a conversa ativa ----
    btnChatResolver?.addEventListener('click', async () => {
        if (!activePhone) return;
        try {
            await fetch(`/api/conversas/${encodeURIComponent(activePhone)}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'fechada' })
            });
            upsertContact({ telefone: activePhone, status: 'fechada' });
            renderContactList();
            showToast('Conversa finalizada', 'Ela volta pra aba Abertas automaticamente se o cliente escrever de novo.', 'success', 3000);
        } catch (e) {
            showToast('Erro', 'Não foi possível finalizar a conversa', 'error');
        }
    });

    // ---- Excluir a conversa ativa (irreversível) ----
    btnChatExcluir?.addEventListener('click', async () => {
        if (!activePhone) return;
        const nome = contacts.get(activePhone)?.nome || activePhone;
        if (!confirm(`Excluir todo o histórico da conversa com ${nome}?\n\nEssa ação é IRREVERSÍVEL.`)) return;
        try {
            const res = await fetch(`/api/conversas/${encodeURIComponent(activePhone)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Falha ao excluir');
            contacts.delete(activePhone);
            activePhone = null;
            if (chatHeader) chatHeader.style.display = 'none';
            if (chatMessages) chatMessages.style.display = 'none';
            if (chatInputBar) chatInputBar.style.display = 'none';
            if (chatPlaceholder) chatPlaceholder.style.display = 'flex';
            renderContactList();
            updateGlobalBadge();
            showToast('Conversa excluída', '', 'success', 3000);
        } catch (e) {
            showToast('Erro', 'Não foi possível excluir a conversa', 'error');
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

        // Áudio transcrito e outras mídias com legenda têm texto real além do
        // tipo — mostra o selo do tipo E o texto, não só o selo (senão a
        // transcrição do áudio nunca aparece na bolha).
        const temTextoReal = m.texto && !/^\[.*\]$/.test(m.texto.trim());
        let bodyHtml;
        if (icon && temTextoReal) {
            const textoLimpo = m.texto.replace(/^🎤\s*/, '');
            bodyHtml = `<span class="bubble-type-badge">${icon}</span><div class="bubble-text">${escapeHtml(textoLimpo)}</div>`;
        } else if (icon) {
            bodyHtml = `<span class="bubble-type-badge">${icon}</span>`;
        } else {
            bodyHtml = `<div class="bubble-text">${escapeHtml(m.texto || '')}</div>`;
        }

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

    // ---- Emojis (grade fixa, sem depender de biblioteca externa) ----
    const EMOJI_LISTA = ['😀','😁','😂','🤣','😊','😍','😘','😉','😎','🤔','😅','😢','😭','😡','👍','👎','🙏','👏','💪','🙌','❤️','💚','💙','💛','🔥','✅','❌','⚠️','🎉','🎁','📅','⏰','📎','📸','💬','👋','🙋','🤝','💰','🏋️'];

    function montarEmojiPicker() {
        if (!emojiPicker || emojiPicker.childElementCount > 0) return;
        EMOJI_LISTA.forEach(emoji => {
            const span = document.createElement('span');
            span.textContent = emoji;
            span.addEventListener('click', () => {
                if (!chatInput) return;
                const start = chatInput.selectionStart || chatInput.value.length;
                const end = chatInput.selectionEnd || chatInput.value.length;
                chatInput.value = chatInput.value.slice(0, start) + emoji + chatInput.value.slice(end);
                chatInput.focus();
                chatInput.selectionStart = chatInput.selectionEnd = start + emoji.length;
            });
            emojiPicker.appendChild(span);
        });
    }

    // ---- Anexa e envia um arquivo na conversa ativa ----
    async function enviarArquivo(file) {
        if (!activePhone || !file) return;
        try {
            const formData = new FormData();
            formData.append('arquivo', file);
            const res = await fetch(`/api/conversas/${encodeURIComponent(activePhone)}/enviar-arquivo`, { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Erro ao enviar arquivo');
            // A bolha aparece via evento socket nova_mensagem
        } catch (err) {
            showToast('Erro ao enviar arquivo', err.message, 'error');
        }
    }

    // ---- Modal "Nova Conversa" ----
    async function renderNovaConversaLista() {
        if (!novaConversaLista) return;
        const termo = (novaConversaBusca?.value || '').trim().toLowerCase();
        let soDigitos = termo.replace(/\D/g, '');
        if (soDigitos.length === 10 || soDigitos.length === 11) soDigitos = '55' + soDigitos;
        novaConversaLista.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:.8rem;font-size:.82rem">Carregando contatos...</p>';
        try {
            const res = await fetch('/api/contatos');
            const todos = await res.json();
            const filtrados = todos.filter(c => !termo || c.nome.toLowerCase().includes(termo) || c.telefone.includes(termo.replace(/\D/g, '') || termo)).slice(0, 50);

            let html = filtrados.map(c => `
                <div class="chat-contact-item nova-conversa-item" data-telefone="${c.telefone}" style="border-radius:8px;cursor:pointer">
                    <div class="chat-contact-avatar">${avatarLetter(c.nome)}</div>
                    <div class="chat-contact-body">
                        <div class="chat-contact-name">${c.nome}</div>
                        <div class="chat-contact-preview">${c.telefone}</div>
                    </div>
                </div>
            `).join('');

            if (soDigitos.length >= 12 && soDigitos.length <= 13 && !todos.some(c => c.telefone === soDigitos)) {
                html += `
                    <div class="chat-contact-item nova-conversa-item" data-telefone="${soDigitos}" style="border-radius:8px;cursor:pointer">
                        <div class="chat-contact-avatar">#</div>
                        <div class="chat-contact-body">
                            <div class="chat-contact-name">Usar número ${soDigitos}</div>
                            <div class="chat-contact-preview">Contato ainda não cadastrado</div>
                        </div>
                    </div>
                `;
            }

            novaConversaLista.innerHTML = html || '<p style="color:var(--text-3);text-align:center;padding:.8rem;font-size:.82rem">Nenhum contato encontrado. Digite um número completo com DDD.</p>';
        } catch (e) {
            novaConversaLista.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:.8rem;font-size:.82rem">Erro ao carregar contatos.</p>';
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

        // Abas Abertas / Fechadas / Aguardando
        function selecionarAba(aba) {
            activeTab = aba;
            [tabAbertas, tabFechadas, tabAguardando].forEach(btn => btn?.classList.remove('active'));
            ({ aberta: tabAbertas, fechada: tabFechadas, aguardando: tabAguardando }[aba])?.classList.add('active');
            renderContactList();
        }
        tabAbertas?.addEventListener('click', () => selecionarAba('aberta'));
        tabFechadas?.addEventListener('click', () => selecionarAba('fechada'));
        tabAguardando?.addEventListener('click', () => selecionarAba('aguardando'));

        // Volume das notificações (liga/desliga)
        atualizarIconeVolume();
        btnVolume?.addEventListener('click', () => {
            notifMuted = !notifMuted;
            localStorage.setItem('chatNotifMuted', notifMuted ? '1' : '0');
            atualizarIconeVolume();
            if (!notifMuted) tocarNotificacao();
        });

        // Emoji picker
        montarEmojiPicker();
        btnEmoji?.addEventListener('click', (e) => {
            e.stopPropagation();
            emojiPicker?.classList.toggle('open');
        });
        document.addEventListener('click', (e) => {
            if (emojiPicker?.classList.contains('open') && !emojiPicker.contains(e.target) && e.target !== btnEmoji) {
                emojiPicker.classList.remove('open');
            }
        });

        // Anexar arquivo
        btnAnexo?.addEventListener('click', () => anexoInput?.click());
        anexoInput?.addEventListener('change', () => {
            const file = anexoInput.files?.[0];
            if (file) enviarArquivo(file);
            anexoInput.value = '';
        });

        // Nova conversa
        btnNovaConversa?.addEventListener('click', () => {
            modalNovaConversa?.classList.add('open');
            if (novaConversaBusca) novaConversaBusca.value = '';
            renderNovaConversaLista();
        });
        document.getElementById('modal-nova-conversa-fechar')?.addEventListener('click', () => {
            modalNovaConversa?.classList.remove('open');
        });
        novaConversaBusca?.addEventListener('input', () => renderNovaConversaLista());
        novaConversaLista?.addEventListener('click', (e) => {
            const item = e.target.closest('.nova-conversa-item');
            if (!item) return;
            modalNovaConversa?.classList.remove('open');
            openChat(item.dataset.telefone);
        });

        // Eventos Socket.IO
        socket.on('all_conversas', (lista) => {
            contacts.clear();
            lista.forEach(c => contacts.set(c.telefone, c));
            updateGlobalBadge();
            renderContactList();
        });

        socket.on('conversa_status_atualizada', ({ telefone, status }) => {
            const c = contacts.get(telefone);
            if (c) upsertContact({ ...c, status });
            renderContactList();
        });

        socket.on('conversa_excluida', ({ telefone }) => {
            contacts.delete(telefone);
            if (activePhone === telefone) {
                activePhone = null;
                if (chatHeader) chatHeader.style.display = 'none';
                if (chatMessages) chatMessages.style.display = 'none';
                if (chatInputBar) chatInputBar.style.display = 'none';
                if (chatPlaceholder) chatPlaceholder.style.display = 'flex';
            }
            renderContactList();
            updateGlobalBadge();
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

            if (data.direcao === 'in' && activePhone !== data.telefone) tocarNotificacao();

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

// =====================================
// FLUXOS (FLOW BUILDER)
// =====================================
const fluxosLista = document.getElementById('fluxos-lista');
const modalFluxo = document.getElementById('modal-fluxo');
const btnNovoFluxo = document.getElementById('btn-novo-fluxo');
const btnSalvarFluxo = document.getElementById('btn-salvar-fluxo');
const fluxoNodesContainer = document.getElementById('fluxo-nodes-container');
const fluxoNome = document.getElementById('fluxo-nome');
const fluxoGatilho = document.getElementById('fluxo-gatilho');
const modalFluxoTitle = document.getElementById('modal-fluxo-title');

let fluxosGlobais = [];
let fluxoEditandoId = null;
let editor = null; // Drawflow instance

function abrirModalFluxo() { modalFluxo?.classList.add('open'); }
window.fecharModalFluxo = function() { modalFluxo?.classList.remove('open'); };

async function loadFluxos() {
    if (!fluxosLista) return;
    try {
        const res = await fetch('/api/fluxos');
        fluxosGlobais = await res.json();
        renderFluxos();
    } catch(e) {}
}

function renderFluxos() {
    if (!fluxosLista) return;
    if (fluxosGlobais.length === 0) {
        fluxosLista.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-3)">Nenhum fluxo criado. Crie seu primeiro fluxo!</div>';
        return;
    }
    fluxosLista.innerHTML = fluxosGlobais.map(f => `
        <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);padding:1.2rem;border-radius:12px;display:flex;justify-content:space-between;align-items:center">
            <div>
                <div style="font-weight:600;font-size:1.1rem;color:var(--text-1);margin-bottom:.4rem">🌊 ${f.nome}</div>
                <div style="font-size:.85rem;color:var(--text-3)">
                    <strong>Gatilhos:</strong> ${f.gatilho || '<em style="opacity:.5">Nenhum</em>'}
                </div>
            </div>
            <div style="display:flex;gap:.6rem;align-items:center">
                <button class="toggle-btn ${f.ativo ? 'on' : 'off'}" onclick="toggleFluxo(${f.id})"></button>
                <button class="btn-secondary" onclick="editarFluxo(${f.id})">✏️ Editar (Visual)</button>
                <button class="btn-danger" onclick="excluirFluxo(${f.id})">🗑️</button>
            </div>
        </div>
    `).join('');
}

window.toggleFluxo = async (id) => {
    try {
        await fetch(`/api/fluxos/${id}/toggle`, { method: 'POST' });
        loadFluxos();
    } catch(e) {}
};

window.excluirFluxo = async (id) => {
    if (!confirm('Tem certeza que deseja excluir este fluxo?')) return;
    try {
        await fetch(`/api/fluxos/${id}`, { method: 'DELETE' });
        loadFluxos();
    } catch(e) {}
};

// ==========================================
// STATUS DO FLUXO (salvo / não salvo / erro)
// ==========================================
const fluxoStatusEl = document.getElementById('fluxo-status');
const FLUXO_STATUS_MAP = {
    novo:        { texto: '●&nbsp;Novo fluxo',              cor: 'var(--text-3)' },
    salvo:       { texto: '✅&nbsp;Salvo',                   cor: 'var(--green)' },
    'nao-salvo': { texto: '⚠️&nbsp;Alterações não salvas',   cor: 'var(--amber)' },
    salvando:    { texto: '⏳&nbsp;Salvando...',              cor: 'var(--text-3)' },
    erro:        { texto: '❌&nbsp;Erro ao salvar',           cor: 'var(--red)' }
};
function marcarFluxoStatus(estado) {
    if (!fluxoStatusEl) return;
    const s = FLUXO_STATUS_MAP[estado] || FLUXO_STATUS_MAP.novo;
    fluxoStatusEl.innerHTML = s.texto;
    fluxoStatusEl.style.color = s.cor;
}
function marcarFluxoSujo() { marcarFluxoStatus('nao-salvo'); }

// Pinta de verde o ponto de entrada de todo nó que tem uma conexão chegando —
// o Drawflow não faz essa confirmação visual sozinho, então fazemos na mão.
function atualizarIndicadoresConexao() {
    if (!editor) return;
    const nodes = editor.drawflow.drawflow.Home.data;
    Object.values(nodes).forEach(node => {
        const conectado = !!(node.inputs?.input_1?.connections?.length);
        const el = document.querySelector(`#node-${node.id} .input`);
        if (el) el.classList.toggle('input-conectado', conectado);
    });
}

// ==========================================
// INICIALIZAÇÃO DO DRAWFLOW
// ==========================================
function initDrawflow() {
    if (editor) return; // já inicializado
    const id = document.getElementById("drawflow");
    if (!id) return;

    editor = new Drawflow(id);
    editor.reroute = true;
    editor.start();

    // Rastreia qualquer alteração no canvas pra avisar que há mudanças não salvas
    editor.on('nodeCreated', marcarFluxoSujo);
    editor.on('nodeRemoved', marcarFluxoSujo);
    editor.on('nodeMoved', marcarFluxoSujo);
    editor.on('nodeDataChanged', marcarFluxoSujo);
    editor.on('connectionCreated', marcarFluxoSujo);
    editor.on('connectionRemoved', marcarFluxoSujo);

    // Atualiza o indicador visual de conexão (ponto verde na entrada) sempre
    // que uma conexão ou nó muda. setTimeout(0) garante que o DOM do Drawflow
    // já terminou de atualizar antes da gente ler/pintar os elementos.
    ['nodeCreated', 'nodeRemoved', 'connectionCreated', 'connectionRemoved'].forEach(evento => {
        editor.on(evento, () => setTimeout(atualizarIndicadoresConexao, 0));
    });
}

// Garante que o fluxo sempre tenha o bloco Inicial — obrigatório em fluxos
// novos e retrocompatível com fluxos antigos que não tinham esse bloco.
function garantirBlocoInicial() {
    const jaTem = Object.values(editor.drawflow.drawflow.Home.data).some(n => n.name === 'start');
    if (!jaTem) addNodeToDrawflow('start', 80, 80, true);
}

btnNovoFluxo?.addEventListener('click', () => {
    fluxoEditandoId = null;
    fluxoNome.value = '';
    fluxoGatilho.value = '';
    modalFluxoTitle.textContent = 'Criar Fluxo';
    abrirModalFluxo();

    initDrawflow();
    editor.clear(); // Começa com canvas limpo
    garantirBlocoInicial();
    marcarFluxoStatus('novo');
});

window.editarFluxo = (id) => {
    const f = fluxosGlobais.find(x => x.id === id);
    if (!f) return;
    fluxoEditandoId = f.id;
    fluxoNome.value = f.nome;
    fluxoGatilho.value = f.gatilho || '';
    modalFluxoTitle.textContent = 'Editar Fluxo';
    abrirModalFluxo();

    initDrawflow();
    editor.clear();

    try {
        if (f.flow_data && Object.keys(f.flow_data).length > 0) {
            editor.import(f.flow_data);
        }
    } catch (e) {
        console.error("Erro ao importar drawflow", e);
    }
    garantirBlocoInicial(); // fluxos criados antes dessa versão não tinham o bloco Inicial
    marcarFluxoStatus('salvo'); // acabou de carregar do banco, não é "alteração não salva"
    setTimeout(atualizarIndicadoresConexao, 0);
};

// ==========================================
// DRAG & DROP DO DRAWFLOW
// ==========================================
let dragType = null;
window.drag = function(ev) {
    if (ev.type === "touchstart") { dragType = ev.target.closest(".drag-drawflow").getAttribute('data-node'); }
    else {
        ev.dataTransfer.setData("node", ev.target.getAttribute('data-node'));
    }
}
window.drop = function(ev) {
    ev.preventDefault();
    const nodeType = ev.dataTransfer.getData("node") || dragType;
    addNodeToDrawflow(nodeType, ev.clientX, ev.clientY);
}
window.allowDrop = function(ev) {
    ev.preventDefault();
}

function addNodeToDrawflow(name, pos_x, pos_y, posicaoJaEmCoordenadasDoCanvas) {
    if (!editor) return;
    // Corrige posição X,Y baseada no canvas (pula esse cálculo quando o
    // node é criado programaticamente, ex: bloco Inicial automático, que já
    // recebe a posição final em vez de coordenadas de clique do mouse).
    if (!posicaoJaEmCoordenadasDoCanvas) {
        pos_x = pos_x * (editor.precanvas.clientWidth / (editor.precanvas.clientWidth * editor.zoom)) - (editor.precanvas.getBoundingClientRect().x * (editor.precanvas.clientWidth / (editor.precanvas.clientWidth * editor.zoom)));
        pos_y = pos_y * (editor.precanvas.clientHeight / (editor.precanvas.clientHeight * editor.zoom)) - (editor.precanvas.getBoundingClientRect().y * (editor.precanvas.clientHeight / (editor.precanvas.clientHeight * editor.zoom)));
    }

    let html = '';
    let inputs = 1;
    let outputs = 1;
    let data = {};
    const tagOptionsHtml = todasEtiquetas.map(e => `<option value="${e.id}">${e.nome}</option>`).join('');

    if (name === 'start') {
        inputs = 0;
        outputs = 1;
        html = `
            <div class="title-box">🏁 Início do Fluxo</div>
            <div class="box" style="color:var(--text-3);font-size:.75rem">Todo fluxo começa por aqui. Conecte a saída ao primeiro bloco da conversa.</div>
        `;
    } else if (name === 'condition') {
        inputs = 1;
        outputs = 2;
        html = `
            <div class="title-box">🔀 Condição</div>
            <div class="box">
                <div style="font-size:.72rem;color:var(--text-3);margin-bottom:4px">O contato possui esta etiqueta?</div>
                <select df-etiquetaId class="df-input">
                    <option value="">Selecione uma etiqueta...</option>
                    ${tagOptionsHtml}
                </select>
                <div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--text-3);margin-top:8px">
                    <span>✅ Saída de cima = Sim</span>
                    <span>❌ Saída de baixo = Não</span>
                </div>
            </div>
        `;
    } else if (name === 'message') {
        html = `
            <div class="title-box">📝 Enviar Texto</div>
            <div class="box">
                <textarea df-text class="df-input" placeholder="Digite a mensagem..." rows="3"></textarea>
            </div>
        `;
    } else if (name === 'media') {
        html = `
            <div class="title-box">🖼️ Enviar Mídia</div>
            <div class="box">
                <input type="text" df-mediaUrl class="df-input" placeholder="Link direto da imagem/arquivo">
                <input type="text" df-text class="df-input" placeholder="Legenda (Opcional)">
            </div>
        `;
    } else if (name === 'delay') {
        html = `
            <div class="title-box">⏳ Atraso (Delay)</div>
            <div class="box">
                Segundos: <input type="number" df-delaySeconds class="df-input" value="2" min="1" max="60">
            </div>
        `;
    } else if (name === 'action') {
        html = `
            <div class="title-box">⚙️ Ação (Etiqueta)</div>
            <div class="box">
                <select df-actionType class="df-input">
                    <option value="add_tag">Adicionar Etiqueta</option>
                    <option value="remove_tag">Remover Etiqueta</option>
                </select>
                <select df-tagId class="df-input">
                    <option value="">Selecione uma etiqueta...</option>
                    ${tagOptionsHtml}
                </select>
            </div>
        `;
    } else if (name === 'question') {
        inputs = 1;
        outputs = 3; // 3 saídas para 3 botões/opções
        html = `
            <div class="title-box">❓ Fazer Pergunta</div>
            <div class="box">
                <textarea df-text class="df-input" placeholder="Digite a pergunta..." rows="2"></textarea>
                <div style="font-size:0.7rem;color:var(--text-3);margin-top:5px">Opção 1 (Linha superior):</div>
                <input type="text" df-opt1 class="df-input" placeholder="Ex: Sim">
                <div style="font-size:0.7rem;color:var(--text-3)">Opção 2 (Linha do meio):</div>
                <input type="text" df-opt2 class="df-input" placeholder="Ex: Não">
                <div style="font-size:0.7rem;color:var(--text-3)">Opção 3 (Linha inferior):</div>
                <input type="text" df-opt3 class="df-input" placeholder="Ex: Falar com Humano">
            </div>
        `;
    }
    
    // Registra e adiciona o nó no canvas
    editor.addNode(name, inputs, outputs, pos_x, pos_y, name, data, html);
}

btnSalvarFluxo?.addEventListener('click', async () => {
    const nome = fluxoNome.value.trim();
    if (!nome) { showToast('Nome obrigatório', 'Digite o nome do fluxo.', 'error'); return; }
    
    if (!editor) return;
    
    const payload = {
        nome,
        gatilho: fluxoGatilho.value.trim(),
        flow_data: editor.export(), // Extrai a árvore mágica do Drawflow!
        ativo: 1
    };

    marcarFluxoStatus('salvando');
    try {
        if (fluxoEditandoId) {
            await fetch(`/api/fluxos/${fluxoEditandoId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            showToast('Sucesso', 'Fluxo atualizado!', 'success');
        } else {
            await fetch('/api/fluxos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            showToast('Sucesso', 'Fluxo criado!', 'success');
        }
        marcarFluxoStatus('salvo');
        fecharModalFluxo();
        loadFluxos();
    } catch(e) {
        marcarFluxoStatus('erro');
        showToast('Erro', 'Não foi possível salvar o fluxo.', 'error');
    }
});

socket.on('fluxos_updated', () => {
    const s = document.getElementById('fluxos-section');
    if (s && !s.classList.contains('hidden')) loadFluxos();
});

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

// =====================================
// INTEGRAÇÃO — CRM PACTO (CONSULTA ALUNO)
// =====================================
const consultaAlunoTermo = document.getElementById('consulta-aluno-termo');
const btnConsultaAluno = document.getElementById('btn-consulta-aluno');
const consultaAlunoResultado = document.getElementById('consulta-aluno-resultado');

function formatarDataNascimento(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

async function buscarConsultaAluno() {
    const termo = (consultaAlunoTermo?.value || '').trim();
    if (!termo) { showToast('Digite uma matrícula', '', 'error'); return; }
    consultaAlunoResultado.innerHTML = '⏳ Buscando...';
    try {
        const res = await fetch(`/api/pacto/consulta-aluno?matricula=${encodeURIComponent(termo)}`);
        const aluno = await res.json();
        if (!res.ok) throw new Error(aluno.error || 'Erro ao buscar aluno');

        const linha = (label, valor) => `
            <div style="display:flex;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                <span>${label}</span>
                <span style="color:var(--text-1);font-weight:600">${valor || '-'}</span>
            </div>`;

        consultaAlunoResultado.innerHTML = `
            ${linha('Nome Completo', aluno.nome)}
            ${linha('Data de Nascimento', formatarDataNascimento(aluno.dataNascimento))}
            ${linha('Telefone', aluno.telefone)}
            ${linha('Matrícula', aluno.matricula)}
            ${linha('Tipo de Plano', aluno.tipoPlano || 'Não disponível na integração ainda')}
            ${linha('Duração', aluno.duracao || 'Não disponível na integração ainda')}
        `;
    } catch (e) {
        consultaAlunoResultado.innerHTML = `<span style="color:var(--red)">❌ ${e.message}</span>`;
    }
}

btnConsultaAluno?.addEventListener('click', buscarConsultaAluno);
consultaAlunoTermo?.addEventListener('keydown', (e) => { if (e.key === 'Enter') buscarConsultaAluno(); });

// =====================================
// INTEGRAÇÃO — CRM PACTO (IMPORTAR CONTATOS EM MASSA)
// =====================================
const btnPactoImportar = document.getElementById('btn-pacto-importar');
const pactoImportarResultado = document.getElementById('pacto-importar-resultado');

function renderPactoImportProgress(p) {
    if (!pactoImportarResultado) return;
    const pct = p.total ? Math.round((p.verificadas / p.total) * 100) : 0;
    pactoImportarResultado.innerHTML = `
        <div style="margin-bottom:.5rem">⏳ Verificando matrículas... ${p.verificadas}/${p.total} (${pct}%)</div>
        <div style="background:rgba(255,255,255,0.08);border-radius:50px;height:8px;overflow:hidden;margin-bottom:.8rem">
            <div style="background:var(--green);height:100%;width:${pct}%;transition:width .3s"></div>
        </div>
        <div>✅ Importados: <strong style="color:var(--text-1)">${p.importados}</strong></div>
        <div>👥 Já existiam: <strong style="color:var(--text-1)">${p.ja_existiam}</strong></div>
        <div>📵 Sem telefone: <strong style="color:var(--text-1)">${p.sem_telefone}</strong></div>
    `;
}

btnPactoImportar?.addEventListener('click', async () => {
    btnPactoImportar.disabled = true;
    btnPactoImportar.textContent = '⏳ Importando...';
    try {
        const res = await fetch('/api/pacto/importar-contatos', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao iniciar importação');
        renderPactoImportProgress({ total: data.total, verificadas: 0, importados: 0, ja_existiam: 0, sem_telefone: 0 });
    } catch (e) {
        showToast('Erro', e.message, 'error');
        btnPactoImportar.disabled = false;
        btnPactoImportar.textContent = '📥 Importar Contatos do Pacto';
    }
});

socket.on('pacto_import_progress', renderPactoImportProgress);

socket.on('pacto_import_done', (p) => {
    if (btnPactoImportar) {
        btnPactoImportar.disabled = false;
        btnPactoImportar.textContent = '📥 Importar Contatos do Pacto';
    }
    showToast('Importação concluída!', `${p.importados} novos contatos importados do Pacto.`, 'success', 6000);
    loadContatos();
});

// =====================================
// INTEGRAÇÃO — CRM PACTO (ATIVOS COM PARCELAS ATRASADAS)
// =====================================
const btnPactoInadimplentes = document.getElementById('btn-pacto-inadimplentes');
const pactoInadimplentesResultado = document.getElementById('pacto-inadimplentes-resultado');
const pactoInadimplentesListaBody = document.getElementById('pacto-inadimplentes-lista');

function renderPactoInadimplentesProgress(p) {
    if (!pactoInadimplentesResultado) return;
    const pct = p.total ? Math.round((p.verificados / p.total) * 100) : 0;
    pactoInadimplentesResultado.innerHTML = `
        <div style="margin-bottom:.5rem">⏳ Verificando contatos... ${p.verificados}/${p.total} (${pct}%)</div>
        <div style="background:rgba(255,255,255,0.08);border-radius:50px;height:8px;overflow:hidden;margin-bottom:.8rem">
            <div style="background:var(--red);height:100%;width:${pct}%;transition:width .3s"></div>
        </div>
        <div>🔴 Inadimplentes encontrados até agora: <strong style="color:var(--text-1)">${p.inadimplentes}</strong></div>
    `;
}

function formatarMoeda(valor) {
    return (valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function loadPactoInadimplentes() {
    if (!pactoInadimplentesListaBody) return;
    try {
        const res = await fetch('/api/pacto/inadimplentes');
        const lista = await res.json();
        if (lista.length === 0) {
            pactoInadimplentesListaBody.innerHTML = '<tr><td colspan="6" style="padding:1.5rem;text-align:center;color:var(--text-3)">Nenhum inadimplente encontrado.</td></tr>';
            return;
        }
        pactoInadimplentesListaBody.innerHTML = lista.map(i => `
            <tr>
                <td>
                    <div style="font-weight:500;color:var(--text-1)">${i.nome || '-'}</div>
                    <div style="font-size:.75rem;color:var(--text-3)">${i.telefone}</div>
                </td>
                <td style="color:var(--text-2);font-size:.85rem">${i.matricula || '-'}</td>
                <td style="text-align:right;color:var(--text-2)">${i.qtd_parcelas_atrasadas}</td>
                <td style="text-align:right;color:var(--red);font-weight:600">${formatarMoeda(i.valor_total_atrasado)}</td>
                <td style="text-align:right;color:var(--text-2)">${i.dias_atraso_mais_antiga}d</td>
                <td style="text-align:right">
                    <button type="button" class="btn-danger btn-excluir-inadimplente" data-telefone="${i.telefone}" data-nome="${i.nome || i.telefone}" style="padding:.35rem .6rem;font-size:.75rem" title="Excluir da lista e remover a etiqueta Inadimplente">🗑️</button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        pactoInadimplentesListaBody.innerHTML = '<tr><td colspan="6" style="padding:1.5rem;text-align:center;color:var(--text-3)">Erro ao carregar.</td></tr>';
    }
}

pactoInadimplentesListaBody?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-excluir-inadimplente');
    if (!btn) return;
    if (!confirm(`Excluir "${btn.dataset.nome}" da lista de inadimplentes e remover a etiqueta "Inadimplente"?`)) return;
    try {
        const res = await fetch(`/api/pacto/inadimplentes/${encodeURIComponent(btn.dataset.telefone)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Falha ao excluir');
        showToast('Removido', '', 'success', 2000);
        loadPactoInadimplentes();
    } catch (err) {
        showToast('Erro', 'Não foi possível remover', 'error');
    }
});

btnPactoInadimplentes?.addEventListener('click', async () => {
    btnPactoInadimplentes.disabled = true;
    btnPactoInadimplentes.textContent = '⏳ Atualizando...';
    try {
        const res = await fetch('/api/pacto/inadimplentes/atualizar', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao iniciar');
        renderPactoInadimplentesProgress({ total: 0, verificados: 0, inadimplentes: 0 });
    } catch (e) {
        showToast('Erro', e.message, 'error');
        btnPactoInadimplentes.disabled = false;
        btnPactoInadimplentes.textContent = '🔄 Atualizar Lista';
    }
});

socket.on('pacto_inadimplentes_progress', renderPactoInadimplentesProgress);

socket.on('pacto_inadimplentes_done', (p) => {
    if (btnPactoInadimplentes) {
        btnPactoInadimplentes.disabled = false;
        btnPactoInadimplentes.textContent = '🔄 Atualizar Lista';
    }
    showToast('Atualização concluída!', `${p.inadimplentes} alunos ativos com parcela atrasada.`, 'success', 6000);
    loadPactoInadimplentes();
});

// =====================================
// AUTOMAÇÃO (sequência disparada por etiqueta)
// =====================================
const automacoesLista = document.getElementById('automacoes-lista');
const btnNovaAutomacao = document.getElementById('btn-nova-automacao');
const modalNovaAutomacao = document.getElementById('modal-nova-automacao-overlay');
const novaAutomacaoNome = document.getElementById('nova-automacao-nome');
const novaAutomacaoEtiqueta = document.getElementById('nova-automacao-etiqueta');
const novaAutomacaoHorarioInicio = document.getElementById('nova-automacao-horario-inicio');
const novaAutomacaoHorarioFim = document.getElementById('nova-automacao-horario-fim');
const modalEtapasAutomacao = document.getElementById('modal-etapas-automacao');
const modalEtapasTitulo = document.getElementById('modal-etapas-titulo');
const etapasHorarioInicio = document.getElementById('etapas-horario-inicio');
const etapasHorarioFim = document.getElementById('etapas-horario-fim');
const etapasAutomacaoLista = document.getElementById('etapas-automacao-lista');
const btnAddEtapa = document.getElementById('btn-add-etapa');
const btnSalvarEtapas = document.getElementById('btn-salvar-etapas');

let automacoesGlobais = [];
let automacaoEditandoId = null;
let etapasEditando = [];
let removerEtiquetaAoConcluir = true;

async function loadAutomacoes() {
    if (!automacoesLista) return;
    try {
        const res = await fetch('/api/automacoes');
        automacoesGlobais = await res.json();
        renderAutomacoesLista();
    } catch (e) {
        automacoesLista.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-3)">Erro ao carregar automações.</div>';
    }
}

function renderAutomacoesLista() {
    if (!automacoesLista) return;
    if (automacoesGlobais.length === 0) {
        automacoesLista.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-3)">Nenhuma automação criada ainda. Crie a primeira!</div>';
        return;
    }
    automacoesLista.innerHTML = automacoesGlobais.map(a => {
        const etiquetaChip = a.etiqueta_nome
            ? etiquetaChipHtml({ id: a.etiqueta_id, nome: a.etiqueta_nome, cor: a.etiqueta_cor || '#25D366' }, false)
            : '<span style="color:var(--text-3);font-size:.75rem">Etiqueta removida</span>';
        return `
            <div class="card glass" style="padding:1.1rem 1.3rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap" data-automacao-id="${a.id}">
                <div style="flex:1;min-width:200px">
                    <div style="font-weight:600;color:var(--text-1);font-size:.95rem;margin-bottom:.3rem">${a.nome}</div>
                    <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
                        ${etiquetaChip}
                        <span style="font-size:.75rem;color:var(--text-3)">${a.total_etapas} etapa${a.total_etapas !== 1 ? 's' : ''}</span>
                        <span style="font-size:.75rem;color:var(--text-3)">•</span>
                        <span style="font-size:.75rem;color:var(--text-3)">${a.total_ativos} contato${a.total_ativos !== 1 ? 's' : ''} em andamento</span>
                        ${a.horario_inicio && a.horario_fim ? `<span style="font-size:.75rem;color:var(--text-3)">• 🕐 ${a.horario_inicio}–${a.horario_fim}</span>` : ''}
                    </div>
                </div>
                <label style="display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--text-3);cursor:pointer">
                    <input type="checkbox" class="automacao-toggle-ativo" data-id="${a.id}" ${a.ativo ? 'checked' : ''} style="accent-color:var(--green);width:16px;height:16px">
                    Ativa
                </label>
                <button type="button" class="btn-secondary btn-config-etapas" data-id="${a.id}" data-nome="${a.nome}" style="padding:.5rem .8rem;font-size:.82rem">⚙️ Configurar Etapas</button>
                <button type="button" class="btn-secondary btn-ver-contatos-etiqueta" data-id="${a.id}" data-nome="${a.nome}" style="padding:.5rem .7rem;font-size:.82rem">👥 Contatos com a Etiqueta</button>
                <button type="button" class="btn-danger btn-excluir-automacao" data-id="${a.id}" style="padding:.5rem .7rem;font-size:.82rem">🗑️</button>
            </div>
        `;
    }).join('');
}

automacoesLista?.addEventListener('change', async (e) => {
    const toggle = e.target.closest('.automacao-toggle-ativo');
    if (!toggle) return;
    try {
        await fetch(`/api/automacoes/${toggle.dataset.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ativo: toggle.checked })
        });
        showToast(toggle.checked ? 'Automação ativada' : 'Automação pausada', '', 'success', 2000);
    } catch (e) {
        showToast('Erro', 'Não foi possível atualizar a automação', 'error');
    }
});

automacoesLista?.addEventListener('click', async (e) => {
    const btnConfig = e.target.closest('.btn-config-etapas');
    if (btnConfig) { abrirConfigurarEtapas(btnConfig.dataset.id, btnConfig.dataset.nome); return; }

    const btnVerContatos = e.target.closest('.btn-ver-contatos-etiqueta');
    if (btnVerContatos) { abrirContatosComEtiqueta(btnVerContatos.dataset.id, btnVerContatos.dataset.nome); return; }

    const btnExcluir = e.target.closest('.btn-excluir-automacao');
    if (btnExcluir) {
        if (!confirm('Excluir esta automação? Contatos em andamento nela vão parar de receber as próximas etapas.')) return;
        try {
            await fetch(`/api/automacoes/${btnExcluir.dataset.id}`, { method: 'DELETE' });
            showToast('Automação excluída', '', 'success', 2000);
            loadAutomacoes();
        } catch (e) {
            showToast('Erro', 'Não foi possível excluir a automação', 'error');
        }
    }
});

// ---- Modal: Criar Automação ----
function abrirNovaAutomacao() {
    if (novaAutomacaoNome) novaAutomacaoNome.value = '';
    if (novaAutomacaoHorarioInicio) novaAutomacaoHorarioInicio.value = '';
    if (novaAutomacaoHorarioFim) novaAutomacaoHorarioFim.value = '';
    if (novaAutomacaoEtiqueta) {
        novaAutomacaoEtiqueta.innerHTML = '<option value="">Selecione uma etiqueta...</option>' +
            todasEtiquetas.map(e => `<option value="${e.id}">${e.nome}</option>`).join('');
    }
    modalNovaAutomacao?.classList.add('open');
}
btnNovaAutomacao?.addEventListener('click', abrirNovaAutomacao);
document.getElementById('modal-nova-automacao-fechar')?.addEventListener('click', () => modalNovaAutomacao?.classList.remove('open'));

document.getElementById('btn-nova-automacao-criar')?.addEventListener('click', async () => {
    const nome = (novaAutomacaoNome?.value || '').trim();
    const etiqueta_id = novaAutomacaoEtiqueta?.value;
    if (!nome) { showToast('Nome obrigatório', 'Dê um nome para a automação.', 'error'); return; }
    if (!etiqueta_id) { showToast('Etiqueta obrigatória', 'Selecione qual etiqueta dispara essa automação.', 'error'); return; }
    try {
        const res = await fetch('/api/automacoes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nome, etiqueta_id: Number(etiqueta_id),
                horario_inicio: novaAutomacaoHorarioInicio?.value || null,
                horario_fim: novaAutomacaoHorarioFim?.value || null
            })
        });
        const nova = await res.json();
        if (!res.ok) throw new Error(nova.error || 'Erro ao criar automação');
        modalNovaAutomacao?.classList.remove('open');
        showToast('Automação criada!', 'Agora configure as etapas dela.', 'success', 3000);
        await loadAutomacoes();
        abrirConfigurarEtapas(nova.id, nova.nome);
    } catch (e) {
        showToast('Erro ao criar', e.message, 'error');
    }
});

// ---- Modal: Configurar Etapas ----
function etapaVazia() {
    return { texto: '', media_path: null, media_tipo: null, dias_proxima_etapa: 1, unidade_tempo: 'dias', grupo_etiquetas: [], mensagens: [], envio_aleatorio: false };
}

async function abrirConfigurarEtapas(automacaoId, nome) {
    automacaoEditandoId = automacaoId;
    if (modalEtapasTitulo) modalEtapasTitulo.textContent = `⚙️ Etapas — ${nome || ''}`;
    const automacao = automacoesGlobais.find(a => String(a.id) === String(automacaoId));
    if (etapasHorarioInicio) etapasHorarioInicio.value = automacao?.horario_inicio || '';
    if (etapasHorarioFim) etapasHorarioFim.value = automacao?.horario_fim || '';
    removerEtiquetaAoConcluir = automacao?.remove_etiqueta_ao_concluir === undefined || automacao?.remove_etiqueta_ao_concluir === null
        ? true
        : !!automacao.remove_etiqueta_ao_concluir;
    etapasAutomacaoLista.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-3)">Carregando etapas...</div>';
    modalEtapasAutomacao?.classList.add('open');
    try {
        await Promise.all([loadEtiquetas(), loadMensagensPersonalizadas()]);
        const res = await fetch(`/api/automacoes/${automacaoId}/etapas`);
        const etapas = await res.json();
        etapasEditando = etapas.length > 0
            ? etapas.map(e => ({ ...e, grupo_etiquetas: e.grupo_etiquetas || [], mensagens: e.mensagens || [], envio_aleatorio: !!e.envio_aleatorio }))
            : [etapaVazia()];
        renderEtapasLista();
    } catch (e) {
        etapasAutomacaoLista.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--red)">Erro ao carregar etapas.</div>';
    }
}

function fecharConfigurarEtapas() {
    automacaoEditandoId = null;
    etapasEditando = [];
    modalEtapasAutomacao?.classList.remove('open');
}
document.getElementById('modal-etapas-fechar')?.addEventListener('click', fecharConfigurarEtapas);
document.getElementById('modal-etapas-fechar-x')?.addEventListener('click', fecharConfigurarEtapas);

// ---- Modal: Contatos com a Etiqueta ----
const modalContatosEtiqueta = document.getElementById('modal-contatos-etiqueta');
const modalContatosEtiquetaTitulo = document.getElementById('modal-contatos-etiqueta-titulo');
const modalContatosEtiquetaLista = document.getElementById('modal-contatos-etiqueta-lista');
const btnAdicionarQuemFalta = document.getElementById('btn-adicionar-quem-falta');
let contatosEtiquetaAutomacaoId = null;

async function abrirContatosComEtiqueta(automacaoId, nomeAutomacao) {
    contatosEtiquetaAutomacaoId = automacaoId;
    if (modalContatosEtiquetaTitulo) modalContatosEtiquetaTitulo.textContent = `👥 Contatos com a Etiqueta — ${nomeAutomacao || ''}`;
    modalContatosEtiquetaLista.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-3)">Carregando...</div>';
    modalContatosEtiqueta?.classList.add('open');
    await carregarContatosComEtiqueta();
}

async function carregarContatosComEtiqueta() {
    if (!contatosEtiquetaAutomacaoId) return;
    try {
        const res = await fetch(`/api/automacoes/${contatosEtiquetaAutomacaoId}/contatos-com-etiqueta`);
        const contatos = await res.json();
        if (!res.ok) throw new Error(contatos.error || 'Erro ao carregar');
        if (contatos.length === 0) {
            modalContatosEtiquetaLista.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-3)">Ninguém com essa etiqueta ainda.</div>';
            return;
        }
        modalContatosEtiquetaLista.innerHTML = contatos.map(c => `
            <div class="card glass" style="padding:.7rem .9rem;display:flex;align-items:center;gap:.8rem;flex-wrap:wrap">
                <div style="flex:1;min-width:160px">
                    <div style="font-weight:500;color:var(--text-1);font-size:.88rem">${c.nome}</div>
                    <div style="font-size:.75rem;color:var(--text-3);margin-bottom:.3rem">${c.telefone}</div>
                    <div style="display:flex;gap:.3rem;flex-wrap:wrap">${c.etiquetas.map(e => etiquetaChipHtml(e, false)).join('')}</div>
                    ${c.mensagem_nome ? `<div style="font-size:.72rem;color:var(--text-3);margin-top:.3rem">💬 Mensagem sorteada: <strong style="color:var(--text-2)">${c.mensagem_nome}</strong></div>` : ''}
                </div>
                <span style="font-size:.75rem;font-weight:600;padding:.25rem .6rem;border-radius:50px;white-space:nowrap;${c.matriculado ? 'background:rgba(37,211,102,0.12);color:var(--green)' : 'background:rgba(245,158,11,0.12);color:var(--amber)'}">
                    ${c.matriculado ? '✅ Já importado' : '⏳ Aguardando importar'}
                </span>
            </div>
        `).join('');
    } catch (e) {
        modalContatosEtiquetaLista.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--red)">Erro ao carregar contatos.</div>';
    }
}

function fecharContatosComEtiqueta() {
    contatosEtiquetaAutomacaoId = null;
    modalContatosEtiqueta?.classList.remove('open');
}
document.getElementById('modal-contatos-etiqueta-fechar')?.addEventListener('click', fecharContatosComEtiqueta);
document.getElementById('modal-contatos-etiqueta-fechar-x')?.addEventListener('click', fecharContatosComEtiqueta);

btnAdicionarQuemFalta?.addEventListener('click', async () => {
    if (!contatosEtiquetaAutomacaoId) return;
    btnAdicionarQuemFalta.disabled = true;
    btnAdicionarQuemFalta.textContent = '⏳ Importando...';
    try {
        const res = await fetch(`/api/automacoes/${contatosEtiquetaAutomacaoId}/importar-contatos`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao importar');
        showToast('Importado!', `${data.importados} contato(s) adicionado(s) à automação. Nenhuma mensagem foi enviada.`, 'success', 4000);
        await carregarContatosComEtiqueta();
        loadAutomacoes();
    } catch (e) {
        showToast('Erro', e.message, 'error');
    } finally {
        btnAdicionarQuemFalta.disabled = false;
        btnAdicionarQuemFalta.textContent = '📥 Importar Contatos';
    }
});

function etapaMediaPreviewHtml(etapa) {
    if (!etapa.media_path) return '<span style="color:var(--text-3);font-size:.78rem">Nenhum arquivo anexado</span>';
    const icones = { image: '🖼️', video: '🎥', audio: '🎤', file: '📄' };
    const nomeArquivo = etapa.media_path.split('/').pop();
    return `<span style="color:var(--text-2);font-size:.78rem">${icones[etapa.media_tipo] || '📎'} ${nomeArquivo}</span>`;
}

function renderEtapasLista() {
    if (!etapasAutomacaoLista) return;
    etapasAutomacaoLista.innerHTML = etapasEditando.map((etapa, i) => {
        const ehUltima = i === etapasEditando.length - 1;
        return `
            <div class="card glass" style="padding:1rem;border:1px solid rgba(255,255,255,0.06)" data-etapa-index="${i}">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem">
                    <strong style="color:var(--green);font-size:.85rem">Etapa ${i + 1}${ehUltima ? ' (final)' : ''}</strong>
                    <button type="button" class="btn-danger btn-remover-etapa" data-index="${i}" style="padding:.3rem .6rem;font-size:.75rem">🗑️</button>
                </div>
                <textarea class="etapa-texto" data-index="${i}" placeholder="Mensagem ou legenda do arquivo..." rows="2" style="width:100%;background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:var(--radius-sm);padding:.6rem .8rem;color:var(--text-1);font-size:.85rem;font-family:'Inter',sans-serif;resize:vertical;margin-bottom:.4rem">${etapa.texto || ''}</textarea>
                <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.6rem">
                    <button type="button" class="btn-secondary btn-inserir-nome" data-index="${i}" style="padding:.25rem .6rem;font-size:.72rem">➕ Nome do aluno</button>
                    <span style="font-size:.72rem;color:var(--text-3)">insere {nome} — vira o primeiro nome dele na hora de enviar. Também dá pra usar {nome_completo}, {matricula} e, pra quem está na lista de inadimplentes, {parcelas}, {valor} e {dias_atrasados}.</span>
                </div>

                <div style="margin-bottom:.6rem;background:rgba(255,255,255,0.02);border-radius:var(--radius-sm);padding:.7rem .8rem">
                    <label style="display:block;font-size:.72rem;color:var(--text-3);margin-bottom:.4rem">🎯 Grupo de Alunos (opcional) — além da etiqueta da automação, só quem também tem uma dessas etiquetas recebe esta etapa</label>
                    <div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;margin-bottom:.4rem">
                        ${(etapa.grupo_etiquetas || []).map(etId => {
                            const et = todasEtiquetas.find(x => x.id === etId);
                            if (!et) return '';
                            return `<span class="etiqueta-chip" style="background:${et.cor}22;color:${et.cor};border:1px solid ${et.cor}55">${et.nome}<button type="button" class="etapa-remover-grupo" data-index="${i}" data-etiqueta-id="${et.id}">×</button></span>`;
                        }).join('')}
                    </div>
                    <select class="etapa-add-grupo" data-index="${i}" style="width:100%;background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:.4rem .6rem;color:var(--text-1);font-size:.78rem">
                        <option value="">+ Adicionar etiqueta ao grupo...</option>
                        ${todasEtiquetas.filter(e => !(etapa.grupo_etiquetas || []).includes(e.id)).map(e => `<option value="${e.id}">${e.nome}</option>`).join('')}
                    </select>
                </div>

                <div style="margin-bottom:.6rem;background:rgba(255,255,255,0.02);border-radius:var(--radius-sm);padding:.7rem .8rem">
                    <label style="display:block;font-size:.72rem;color:var(--text-3);margin-bottom:.4rem">💬 Adicionar Mensagem — puxa mensagens prontas de "Mensagens Personalizadas"; se escolher uma ou mais, elas substituem o texto/anexo digitado acima</label>
                    <div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;margin-bottom:.4rem">
                        ${(etapa.mensagens || []).map(mId => {
                            const msg = mensagensPersonalizadasGlobais.find(x => x.id === mId);
                            if (!msg) return '';
                            return `<span class="etiqueta-chip" style="background:rgba(37,211,102,0.12);color:var(--green);border:1px solid rgba(37,211,102,0.35)">${msg.nome}<button type="button" class="etapa-remover-mensagem" data-index="${i}" data-mensagem-id="${msg.id}">×</button></span>`;
                        }).join('')}
                    </div>
                    <select class="etapa-add-mensagem" data-index="${i}" style="width:100%;background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:.4rem .6rem;color:var(--text-1);font-size:.78rem;margin-bottom:.4rem">
                        <option value="">+ Adicionar mensagem...</option>
                        ${mensagensPersonalizadasGlobais.filter(m => !(etapa.mensagens || []).includes(m.id)).map(m => `<option value="${m.id}">${m.nome}</option>`).join('')}
                    </select>
                    ${(etapa.mensagens || []).length > 1 ? `
                        <label style="display:flex;align-items:center;gap:.4rem;font-size:.75rem;color:var(--text-3);cursor:pointer">
                            <input type="checkbox" class="etapa-envio-aleatorio" data-index="${i}" ${etapa.envio_aleatorio ? 'checked' : ''} style="accent-color:var(--green);width:15px;height:15px">
                            🎲 Enviar de forma aleatória — cada aluno recebe uma mensagem diferente do grupo, em vez da mesma pra todo mundo
                        </label>
                    ` : ''}
                </div>

                <div style="display:flex;align-items:center;gap:.8rem;flex-wrap:wrap">
                    <label class="btn-secondary etapa-anexar-label" style="padding:.4rem .7rem;font-size:.78rem;cursor:pointer">
                        📎 Anexar arquivo
                        <input type="file" class="etapa-anexo-input" data-index="${i}" accept="image/*,video/*,audio/*,.pdf,.doc,.docx" style="display:none">
                    </label>
                    <span class="etapa-media-preview" data-index="${i}">${etapaMediaPreviewHtml(etapa)}</span>
                    ${etapa.media_path ? `<button type="button" class="btn-cancel btn-remover-anexo" data-index="${i}" style="padding:.3rem .6rem;font-size:.72rem">Remover anexo</button>` : ''}
                    ${!ehUltima ? `
                        <span style="margin-left:auto;display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--text-3)">
                            Aguardar
                            <input type="number" class="etapa-dias" data-index="${i}" min="0" value="${etapa.dias_proxima_etapa ?? 1}" style="width:56px;background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:.3rem .4rem;color:var(--text-1);text-align:center">
                            <select class="etapa-unidade" data-index="${i}" style="background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:.3rem .4rem;color:var(--text-1);font-family:'Inter',sans-serif;font-size:.78rem">
                                <option value="dias" ${(etapa.unidade_tempo || 'dias') === 'dias' ? 'selected' : ''}>dia(s)</option>
                                <option value="horas" ${etapa.unidade_tempo === 'horas' ? 'selected' : ''}>hora(s)</option>
                            </select>
                            e passar pra etapa ${i + 2}
                        </span>
                    ` : `<label style="margin-left:auto;display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--text-3);cursor:pointer">
                            <input type="checkbox" id="etapa-final-remover-etiqueta" ${removerEtiquetaAoConcluir ? 'checked' : ''} style="accent-color:var(--green);width:15px;height:15px">
                            Ao enviar, remove a etiqueta do contato
                        </label>`}
                </div>
            </div>
        `;
    }).join('');
}

etapasAutomacaoLista?.addEventListener('input', (e) => {
    const textoEl = e.target.closest('.etapa-texto');
    if (textoEl) { etapasEditando[Number(textoEl.dataset.index)].texto = textoEl.value; return; }
    const diasEl = e.target.closest('.etapa-dias');
    if (diasEl) { etapasEditando[Number(diasEl.dataset.index)].dias_proxima_etapa = parseInt(diasEl.value) || 0; }
});

etapasAutomacaoLista?.addEventListener('change', async (e) => {
    const checkboxRemover = e.target.closest('#etapa-final-remover-etiqueta');
    if (checkboxRemover) { removerEtiquetaAoConcluir = checkboxRemover.checked; return; }

    const unidadeEl = e.target.closest('.etapa-unidade');
    if (unidadeEl) { etapasEditando[Number(unidadeEl.dataset.index)].unidade_tempo = unidadeEl.value; return; }

    const addGrupoEl = e.target.closest('.etapa-add-grupo');
    if (addGrupoEl && addGrupoEl.value) {
        const index = Number(addGrupoEl.dataset.index);
        const etapa = etapasEditando[index];
        etapa.grupo_etiquetas = [...(etapa.grupo_etiquetas || []), Number(addGrupoEl.value)];
        renderEtapasLista();
        return;
    }

    const addMensagemEl = e.target.closest('.etapa-add-mensagem');
    if (addMensagemEl && addMensagemEl.value) {
        const index = Number(addMensagemEl.dataset.index);
        const etapa = etapasEditando[index];
        etapa.mensagens = [...(etapa.mensagens || []), Number(addMensagemEl.value)];
        renderEtapasLista();
        return;
    }

    const aleatorioEl = e.target.closest('.etapa-envio-aleatorio');
    if (aleatorioEl) { etapasEditando[Number(aleatorioEl.dataset.index)].envio_aleatorio = aleatorioEl.checked; return; }

    const fileInput = e.target.closest('.etapa-anexo-input');
    if (!fileInput || !fileInput.files?.[0]) return;
    const index = Number(fileInput.dataset.index);
    const preview = etapasAutomacaoLista.querySelector(`.etapa-media-preview[data-index="${index}"]`);
    if (preview) preview.innerHTML = '<span style="color:var(--text-3);font-size:.78rem">Enviando...</span>';
    try {
        const formData = new FormData();
        formData.append('media', fileInput.files[0]);
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao enviar arquivo');
        etapasEditando[index].media_path = data.path;
        etapasEditando[index].media_tipo = data.tipo;
        renderEtapasLista();
    } catch (err) {
        showToast('Erro ao anexar', err.message, 'error');
        renderEtapasLista();
    }
});

etapasAutomacaoLista?.addEventListener('click', (e) => {
    const btnRemoverGrupo = e.target.closest('.etapa-remover-grupo');
    if (btnRemoverGrupo) {
        const index = Number(btnRemoverGrupo.dataset.index);
        const etiquetaId = Number(btnRemoverGrupo.dataset.etiquetaId);
        etapasEditando[index].grupo_etiquetas = (etapasEditando[index].grupo_etiquetas || []).filter(id => id !== etiquetaId);
        renderEtapasLista();
        return;
    }
    const btnRemoverMensagem = e.target.closest('.etapa-remover-mensagem');
    if (btnRemoverMensagem) {
        const index = Number(btnRemoverMensagem.dataset.index);
        const mensagemId = Number(btnRemoverMensagem.dataset.mensagemId);
        etapasEditando[index].mensagens = (etapasEditando[index].mensagens || []).filter(id => id !== mensagemId);
        renderEtapasLista();
        return;
    }
    const btnRemover = e.target.closest('.btn-remover-etapa');
    if (btnRemover) {
        if (etapasEditando.length <= 1) { showToast('A automação precisa de pelo menos uma etapa', '', 'error'); return; }
        etapasEditando.splice(Number(btnRemover.dataset.index), 1);
        renderEtapasLista();
        return;
    }
    const btnRemoverAnexo = e.target.closest('.btn-remover-anexo');
    if (btnRemoverAnexo) {
        const index = Number(btnRemoverAnexo.dataset.index);
        etapasEditando[index].media_path = null;
        etapasEditando[index].media_tipo = null;
        renderEtapasLista();
        return;
    }
    const btnNome = e.target.closest('.btn-inserir-nome');
    if (btnNome) {
        const index = Number(btnNome.dataset.index);
        const textarea = etapasAutomacaoLista.querySelector(`.etapa-texto[data-index="${index}"]`);
        if (!textarea) return;
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        textarea.value = textarea.value.slice(0, start) + '{nome}' + textarea.value.slice(end);
        etapasEditando[index].texto = textarea.value;
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = start + '{nome}'.length;
    }
});

btnAddEtapa?.addEventListener('click', () => {
    etapasEditando.push(etapaVazia());
    renderEtapasLista();
});

btnSalvarEtapas?.addEventListener('click', async () => {
    if (!automacaoEditandoId) return;
    const semConteudo = etapasEditando.some(e => !e.texto?.trim() && !e.media_path && (!e.mensagens || e.mensagens.length === 0));
    if (semConteudo) { showToast('Etapa vazia', 'Toda etapa precisa de uma mensagem, um arquivo anexado ou mensagens personalizadas selecionadas.', 'error'); return; }
    btnSalvarEtapas.disabled = true;
    try {
        const res = await fetch(`/api/automacoes/${automacaoEditandoId}/etapas`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ etapas: etapasEditando })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao salvar etapas');

        await fetch(`/api/automacoes/${automacaoEditandoId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                horario_inicio: etapasHorarioInicio?.value || '',
                horario_fim: etapasHorarioFim?.value || '',
                remove_etiqueta_ao_concluir: removerEtiquetaAoConcluir
            })
        });

        showToast('Etapas salvas!', '', 'success', 2500);
        fecharConfigurarEtapas();
        loadAutomacoes();
    } catch (e) {
        showToast('Erro ao salvar', e.message, 'error');
    } finally {
        btnSalvarEtapas.disabled = false;
    }
});

socket.on('automacoes_atualizadas', () => {
    if (document.getElementById('automacoes-section') && !document.getElementById('automacoes-section').classList.contains('hidden')) {
        loadAutomacoes();
    }
    if (document.getElementById('disparos-section') && !document.getElementById('disparos-section').classList.contains('hidden')) {
        loadAcompanhamentoAutomacoes();
    }
    if (contatosEtiquetaAutomacaoId && modalContatosEtiqueta?.classList.contains('open')) {
        carregarContatosComEtiqueta();
    }
});

// =====================================
// MENSAGENS PERSONALIZADAS (aniversário automático)
// =====================================
const mensagensPersonalizadasLista = document.getElementById('mensagens-personalizadas-lista');
const btnNovaMensagemPersonalizada = document.getElementById('btn-nova-mensagem-personalizada');
const modalMensagemPersonalizada = document.getElementById('modal-mensagem-personalizada-overlay');
const modalMensagemPersonalizadaTitulo = document.getElementById('modal-mensagem-personalizada-titulo');
const mensagemPersonalizadaId = document.getElementById('mensagem-personalizada-id');
const mensagemPersonalizadaNome = document.getElementById('mensagem-personalizada-nome');
const mensagemPersonalizadaTexto = document.getElementById('mensagem-personalizada-texto');
const mensagemPersonalizadaMediaPath = document.getElementById('mensagem-personalizada-media-path');
const mensagemPersonalizadaMediaTipo = document.getElementById('mensagem-personalizada-media-tipo');
const mpUploadArea = document.getElementById('mp-upload-area');
const mpUploadAreaText = document.getElementById('mp-upload-area-text');
const mpModalFile = document.getElementById('mp-modal-file');
const mpUploadPreview = document.getElementById('mp-upload-preview');
const btnMensagemPersonalizadaSalvar = document.getElementById('btn-mensagem-personalizada-salvar');

modalMensagemPersonalizada?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-inserir-placeholder-mp');
    if (!btn || !mensagemPersonalizadaTexto) return;
    const placeholder = btn.dataset.placeholder;
    const start = mensagemPersonalizadaTexto.selectionStart ?? mensagemPersonalizadaTexto.value.length;
    const end = mensagemPersonalizadaTexto.selectionEnd ?? mensagemPersonalizadaTexto.value.length;
    mensagemPersonalizadaTexto.value = mensagemPersonalizadaTexto.value.slice(0, start) + placeholder + mensagemPersonalizadaTexto.value.slice(end);
    mensagemPersonalizadaTexto.focus();
    mensagemPersonalizadaTexto.selectionStart = mensagemPersonalizadaTexto.selectionEnd = start + placeholder.length;
});

let mensagensPersonalizadasGlobais = [];

async function loadMensagensPersonalizadas() {
    if (!mensagensPersonalizadasLista) return;
    try {
        const res = await fetch('/api/mensagens-personalizadas');
        mensagensPersonalizadasGlobais = await res.json();
        renderMensagensPersonalizadasLista();
    } catch (e) {
        mensagensPersonalizadasLista.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-3)">Erro ao carregar mensagens.</div>';
    }
}

function renderMensagensPersonalizadasLista() {
    if (!mensagensPersonalizadasLista) return;
    if (mensagensPersonalizadasGlobais.length === 0) {
        mensagensPersonalizadasLista.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-3)">Nenhuma mensagem criada ainda. Crie a primeira!</div>';
        return;
    }
    mensagensPersonalizadasLista.innerHTML = mensagensPersonalizadasGlobais.map(m => `
        <div class="card glass" style="padding:1.1rem 1.3rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap" data-mensagem-id="${m.id}">
            <div style="flex:1;min-width:200px">
                <div style="font-weight:600;color:var(--text-1);font-size:.95rem;margin-bottom:.3rem">🎂 ${m.nome}</div>
                ${m.media_path ? '<span style="font-size:.75rem;color:var(--text-3)">📎 com mídia</span>' : ''}
            </div>
            <button type="button" class="btn-secondary btn-editar-mensagem-personalizada" data-id="${m.id}" style="padding:.5rem .8rem;font-size:.82rem">✏️ Editar</button>
            <button type="button" class="btn-danger btn-excluir-mensagem-personalizada" data-id="${m.id}" style="padding:.5rem .7rem;font-size:.82rem">🗑️</button>
        </div>
    `).join('');
}

mensagensPersonalizadasLista?.addEventListener('click', async (e) => {
    const btnEditar = e.target.closest('.btn-editar-mensagem-personalizada');
    if (btnEditar) { abrirModalMensagemPersonalizada(mensagensPersonalizadasGlobais.find(x => x.id == btnEditar.dataset.id)); return; }

    const btnExcluir = e.target.closest('.btn-excluir-mensagem-personalizada');
    if (btnExcluir) {
        if (!confirm('Excluir esta mensagem de aniversário? Ela para de ser enviada automaticamente.')) return;
        try {
            await fetch(`/api/mensagens-personalizadas/${btnExcluir.dataset.id}`, { method: 'DELETE' });
            showToast('Mensagem excluída', '', 'success', 2000);
            loadMensagensPersonalizadas();
        } catch (e) {
            showToast('Erro', 'Não foi possível excluir a mensagem', 'error');
        }
    }
});

function abrirModalMensagemPersonalizada(m = null) {
    mensagemPersonalizadaId.value = m ? m.id : '';
    modalMensagemPersonalizadaTitulo.textContent = m ? '✏️ Editar Mensagem de Aniversário' : '➕ Nova Mensagem de Aniversário';
    mensagemPersonalizadaNome.value = m ? m.nome : '';
    mensagemPersonalizadaTexto.value = m ? m.texto : '';
    mensagemPersonalizadaMediaPath.value = m?.media_path || '';
    mensagemPersonalizadaMediaTipo.value = m?.media_tipo || '';
    mpUploadArea.classList.remove('has-file');
    mpUploadAreaText.textContent = m?.media_path ? '✅ Mídia já configurada' : '📎 Clique ou arraste um arquivo aqui';
    if (m?.media_path) mpUploadArea.classList.add('has-file');
    mpUploadPreview.style.display = 'none';
    mpUploadPreview.innerHTML = '';
    modalMensagemPersonalizada?.classList.add('open');
}
function fecharModalMensagemPersonalizada() {
    modalMensagemPersonalizada?.classList.remove('open');
}

btnNovaMensagemPersonalizada?.addEventListener('click', () => abrirModalMensagemPersonalizada());
document.getElementById('modal-mensagem-personalizada-fechar')?.addEventListener('click', fecharModalMensagemPersonalizada);

mpUploadArea?.addEventListener('click', () => mpModalFile?.click());
mpUploadArea?.addEventListener('dragover', (e) => { e.preventDefault(); mpUploadArea.style.borderColor = 'var(--green)'; });
mpUploadArea?.addEventListener('dragleave', () => { mpUploadArea.style.borderColor = ''; });
mpUploadArea?.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFileUploadMensagemPersonalizada(e.dataTransfer.files[0]); });
mpModalFile?.addEventListener('change', () => { if (mpModalFile.files[0]) handleFileUploadMensagemPersonalizada(mpModalFile.files[0]); });

async function handleFileUploadMensagemPersonalizada(file) {
    mpUploadAreaText.textContent = `⏳ Enviando ${file.name}...`;
    mpUploadArea.classList.add('has-file');
    const formData = new FormData();
    formData.append('media', file);
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        mensagemPersonalizadaMediaPath.value = data.path;
        mensagemPersonalizadaMediaTipo.value = data.tipo;
        mpUploadAreaText.textContent = `✅ ${data.originalName}`;
        mpUploadPreview.style.display = 'block';
        mpUploadPreview.innerHTML = data.tipo === 'image'
            ? `<img src="${data.path}" class="upload-preview-img">`
            : `<span style="color:var(--text-2);font-size:.82rem">📄 ${data.originalName}</span>`;
        showToast('Upload concluído', data.originalName, 'success', 3000);
    } catch {
        mpUploadAreaText.textContent = '❌ Erro no upload. Tente novamente.';
        mpUploadArea.classList.remove('has-file');
    }
}

btnMensagemPersonalizadaSalvar?.addEventListener('click', async () => {
    const nome = mensagemPersonalizadaNome.value.trim();
    const texto = mensagemPersonalizadaTexto.value.trim();
    if (!nome) { showToast('Nome obrigatório', 'Digite um nome pra identificar a mensagem.', 'error'); return; }
    if (!texto) { showToast('Mensagem obrigatória', 'Digite o texto da mensagem.', 'error'); return; }

    const payload = {
        nome, texto,
        media_path: mensagemPersonalizadaMediaPath.value || null,
        media_tipo: mensagemPersonalizadaMediaTipo.value || null
    };
    const id = mensagemPersonalizadaId.value;
    try {
        const res = await fetch(id ? `/api/mensagens-personalizadas/${id}` : '/api/mensagens-personalizadas', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao salvar');
        showToast(id ? 'Mensagem atualizada!' : 'Mensagem criada!', '', 'success', 2500);
        fecharModalMensagemPersonalizada();
        loadMensagensPersonalizadas();
    } catch (e) {
        showToast('Erro ao salvar', e.message, 'error');
    }
});

// =====================================
// ACOMPANHAMENTO DE AUTOMAÇÕES (tela de Disparos)
// =====================================
const acompanhamentoAutomacoesLista = document.getElementById('acompanhamento-automacoes-lista');
const automacaoDelayModo = document.getElementById('automacao-delay-modo');
const automacaoDelaySegundos = document.getElementById('automacao-delay-segundos');
const automacaoDelayVelocidade = document.getElementById('automacao-delay-velocidade');
const automacaoDelayFixoGroup = document.getElementById('automacao-delay-fixo-group');
const automacaoDelayAleatorioGroup = document.getElementById('automacao-delay-aleatorio-group');
const progressoAbertoPorAutomacao = new Set();

function atualizarGruposDelayAutomacao() {
    const aleatorio = automacaoDelayModo?.value === 'aleatorio';
    if (automacaoDelayFixoGroup) automacaoDelayFixoGroup.style.display = aleatorio ? 'none' : 'flex';
    if (automacaoDelayAleatorioGroup) automacaoDelayAleatorioGroup.style.display = aleatorio ? 'flex' : 'none';
}

async function loadAutomacaoDelayConfig() {
    if (!automacaoDelayModo) return;
    try {
        const res = await fetch('/api/configuracoes');
        const config = await res.json();
        automacaoDelayModo.value = config.automacao_delay_modo || 'fixo';
        automacaoDelaySegundos.value = config.automacao_delay_segundos || 5;
        automacaoDelayVelocidade.value = config.automacao_delay_velocidade || 'medio';
        atualizarGruposDelayAutomacao();
    } catch (e) {}
}

async function salvarAutomacaoDelayConfig() {
    try {
        await fetch('/api/configuracoes', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                automacao_delay_modo: automacaoDelayModo.value,
                automacao_delay_segundos: Math.max(1, parseInt(automacaoDelaySegundos.value) || 5),
                automacao_delay_velocidade: automacaoDelayVelocidade.value
            })
        });
        showToast('Intervalo salvo', '', 'success', 2000);
    } catch (e) {
        showToast('Erro', 'Não foi possível salvar o intervalo', 'error');
    }
}

automacaoDelayModo?.addEventListener('change', () => { atualizarGruposDelayAutomacao(); salvarAutomacaoDelayConfig(); });
automacaoDelaySegundos?.addEventListener('change', () => {
    automacaoDelaySegundos.value = Math.max(1, parseInt(automacaoDelaySegundos.value) || 5);
    salvarAutomacaoDelayConfig();
});
automacaoDelayVelocidade?.addEventListener('change', salvarAutomacaoDelayConfig);

async function loadAcompanhamentoAutomacoes() {
    if (!acompanhamentoAutomacoesLista) return;
    try {
        const res = await fetch('/api/automacoes');
        const automacoes = await res.json();
        renderAcompanhamentoAutomacoes(automacoes);
    } catch (e) {
        acompanhamentoAutomacoesLista.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-3)">Erro ao carregar automações.</div>';
    }
}

function renderAcompanhamentoAutomacoes(automacoes) {
    if (!acompanhamentoAutomacoesLista) return;
    if (automacoes.length === 0) {
        acompanhamentoAutomacoesLista.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-3)">Nenhuma automação criada ainda.</div>';
        return;
    }
    acompanhamentoAutomacoesLista.innerHTML = automacoes.map(a => {
        const etiquetaChip = a.etiqueta_nome
            ? etiquetaChipHtml({ id: a.etiqueta_id, nome: a.etiqueta_nome, cor: a.etiqueta_cor || '#25D366' }, false)
            : '<span style="color:var(--text-3);font-size:.75rem">Etiqueta removida</span>';
        const aberto = progressoAbertoPorAutomacao.has(a.id);
        return `
            <div class="card glass" style="padding:1rem 1.2rem" data-acompanhar-id="${a.id}">
                <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
                    <div style="flex:1;min-width:180px">
                        <div style="font-weight:600;color:var(--text-1);font-size:.9rem;margin-bottom:.25rem">${a.nome}</div>
                        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">${etiquetaChip}</div>
                    </div>
                    <div style="text-align:center">
                        <div style="font-size:1.2rem;font-weight:700;color:var(--green)">${a.total_ativos}</div>
                        <div style="font-size:.7rem;color:var(--text-3)">em andamento</div>
                    </div>
                    <div style="text-align:center">
                        <div style="font-size:1.2rem;font-weight:700;color:var(--text-1)">${a.concluidos_hoje || 0}</div>
                        <div style="font-size:.7rem;color:var(--text-3)">concluídos hoje</div>
                    </div>
                    <label style="display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--text-3);cursor:pointer">
                        <input type="checkbox" class="acompanhamento-toggle-ativo" data-id="${a.id}" ${a.ativo ? 'checked' : ''} style="accent-color:var(--green);width:16px;height:16px">
                        Ativo
                    </label>
                    <button type="button" class="btn-secondary btn-toggle-progresso" data-id="${a.id}" style="padding:.4rem .8rem;font-size:.78rem">
                        ${aberto ? '▲ Esconder' : '▼ Ver contatos'}
                    </button>
                    <button type="button" class="btn-primary btn-disparar-automacao" data-id="${a.id}" data-nome="${a.nome}" style="padding:.4rem .8rem;font-size:.78rem" title="Manda a mensagem sorteada pra cada contato em andamento">🚀 Disparar Mensagens</button>
                    ${a.etiqueta_nome === 'Inadimplente' ? `
                        <button type="button" class="btn-secondary btn-atualizar-inadimplentes" style="padding:.4rem .8rem;font-size:.78rem" title="Roda a varredura no Pacto de novo pra atualizar quem está inadimplente antes de disparar">🔄 Atualizar Lista de Inadimplentes</button>
                    ` : ''}
                </div>
                <div class="acompanhamento-detalhe" data-id="${a.id}" style="margin-top:1rem;${aberto ? '' : 'display:none'}">
                    <div style="padding:1rem;text-align:center;color:var(--text-3);font-size:.82rem">Carregando...</div>
                </div>
            </div>
        `;
    }).join('');
    progressoAbertoPorAutomacao.forEach(id => carregarProgressoDetalhe(id));
}

function formatDataCurta(tsStr) {
    if (!tsStr) return '-';
    const d = new Date(tsStr);
    if (isNaN(d)) return '-';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function carregarProgressoDetalhe(automacaoId) {
    const container = acompanhamentoAutomacoesLista?.querySelector(`.acompanhamento-detalhe[data-id="${automacaoId}"]`);
    if (!container) return;
    try {
        const res = await fetch(`/api/automacoes/${automacaoId}/progresso`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao carregar progresso');

        const filaHtml = data.contatos.length === 0
            ? '<div style="padding:1rem;text-align:center;color:var(--text-3);font-size:.82rem">Ninguém em andamento nessa automação agora.</div>'
            : `
            <table class="leads-table">
                <thead>
                    <tr>
                        <th>Contato</th>
                        <th>Etapa</th>
                        <th>Mensagem</th>
                        <th>Horário previsto</th>
                        <th>Erro no último envio</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.contatos.map(c => `
                        <tr>
                            <td>
                                <div style="font-weight:500;color:var(--text-1);font-size:.85rem">${c.nome}</div>
                                <div style="font-size:.72rem;color:var(--text-3)">${c.telefone}</div>
                            </td>
                            <td style="color:var(--text-2);font-size:.85rem">${c.etapa_atual} de ${data.total_etapas}</td>
                            <td style="color:var(--text-2);font-size:.85rem">${c.mensagem_nome || '<span style="color:var(--text-3)">será sorteada no envio</span>'}</td>
                            <td style="color:var(--text-2);font-size:.85rem">${data.disparo_ativo ? formatDataCurta(c.horario_previsto) : '<span style="color:var(--text-3)">aguardando clicar em Disparar</span>'}</td>
                            <td style="font-size:.8rem">${c.ultimo_erro ? `<span style="color:var(--red)" title="${c.ultimo_erro}">⚠️ ${c.ultimo_erro}</span>` : '<span style="color:var(--text-3)">-</span>'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        const enviadasHtml = (data.enviadas || []).length === 0
            ? '<div style="padding:1rem;text-align:center;color:var(--text-3);font-size:.82rem">Ninguém recebeu mensagem ainda.</div>'
            : `
            <table class="leads-table">
                <thead>
                    <tr>
                        <th>Contato</th>
                        <th>Mensagem</th>
                        <th>Enviado em</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.enviadas.map(e => `
                        <tr>
                            <td>
                                <div style="font-weight:500;color:var(--text-1);font-size:.85rem">${e.nome || e.telefone}</div>
                                <div style="font-size:.72rem;color:var(--text-3)">${e.telefone}</div>
                            </td>
                            <td style="color:var(--text-2);font-size:.85rem">${e.mensagem_nome || '-'}</td>
                            <td style="color:var(--text-2);font-size:.85rem">${formatDataCurta(e.enviado_em)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        container.innerHTML = `
            <div style="font-weight:600;color:var(--text-1);font-size:.82rem;margin-bottom:.5rem">📋 Em andamento (${data.contatos.length})</div>
            ${filaHtml}
            <div style="font-weight:600;color:var(--text-1);font-size:.82rem;margin:1rem 0 .5rem">✅ Já enviadas (últimas ${(data.enviadas || []).length})</div>
            ${enviadasHtml}
        `;
    } catch (e) {
        container.innerHTML = `<div style="padding:1rem;text-align:center;color:var(--red);font-size:.82rem">Erro ao carregar detalhes.</div>`;
    }
}

acompanhamentoAutomacoesLista?.addEventListener('change', async (e) => {
    const toggle = e.target.closest('.acompanhamento-toggle-ativo');
    if (!toggle) return;
    try {
        await fetch(`/api/automacoes/${toggle.dataset.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ativo: toggle.checked })
        });
        showToast(toggle.checked ? 'Automação ativada' : 'Automação pausada', '', 'success', 2000);
    } catch (e) {
        showToast('Erro', 'Não foi possível atualizar a automação', 'error');
    }
});

acompanhamentoAutomacoesLista?.addEventListener('click', async (e) => {
    const btnAtualizarInadimplentes = e.target.closest('.btn-atualizar-inadimplentes');
    if (btnAtualizarInadimplentes) {
        btnAtualizarInadimplentes.disabled = true;
        btnAtualizarInadimplentes.textContent = '⏳ Atualizando...';
        try {
            const res = await fetch('/api/pacto/inadimplentes/atualizar', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Erro ao iniciar atualização');
            showToast('Atualização iniciada!', 'Pode levar alguns minutos — quem quitou sai da etiqueta e quem venceu entra, sozinho, conforme a varredura avança.', 'success', 6000);
        } catch (err) {
            showToast('Erro', err.message, 'error');
            btnAtualizarInadimplentes.disabled = false;
            btnAtualizarInadimplentes.textContent = '🔄 Atualizar Lista de Inadimplentes';
        }
        return;
    }

    const btnDisparar = e.target.closest('.btn-disparar-automacao');
    if (btnDisparar) {
        if (!confirm(`Disparar as mensagens da automação "${btnDisparar.dataset.nome}"? Cada contato em andamento recebe a mensagem que foi sorteada pra ele. O envio é espaçado (30-120s por contato) pra não arriscar bloqueio no WhatsApp — pode levar minutos.`)) return;
        btnDisparar.disabled = true;
        btnDisparar.textContent = '⏳ Disparando...';
        try {
            const res = await fetch(`/api/automacoes/${btnDisparar.dataset.id}/disparar`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Erro ao iniciar disparo');
            showToast('Disparo iniciado!', 'Rodando em segundo plano — os números vão atualizando sozinhos conforme cada mensagem for enviada.', 'success', 6000);
        } catch (err) {
            showToast('Erro', err.message, 'error');
        } finally {
            btnDisparar.disabled = false;
            btnDisparar.textContent = '🚀 Disparar Mensagens';
        }
        return;
    }

    const btn = e.target.closest('.btn-toggle-progresso');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const detalhe = acompanhamentoAutomacoesLista.querySelector(`.acompanhamento-detalhe[data-id="${id}"]`);
    if (!detalhe) return;
    if (progressoAbertoPorAutomacao.has(id)) {
        progressoAbertoPorAutomacao.delete(id);
        detalhe.style.display = 'none';
        btn.textContent = '▼ Ver contatos';
    } else {
        progressoAbertoPorAutomacao.add(id);
        detalhe.style.display = 'block';
        btn.textContent = '▲ Esconder';
        carregarProgressoDetalhe(id);
    }
});
