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
        const text = btn.textContent.trim();
        pageTitle.textContent = text;
        if (targetId === 'mensagens-section') loadRegras();
        if (targetId === 'ia-section') loadIaConfig();
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
// GERENCIADOR DE REGRAS
// =====================================
const modalOverlay    = document.getElementById('modal-overlay');
const modalTitle      = document.getElementById('modal-title');
const modalEditId     = document.getElementById('modal-edit-id');
const modalKeywords   = document.getElementById('modal-keywords');
const modalResposta   = document.getElementById('modal-resposta');
const modalOrdem      = document.getElementById('modal-ordem');
const modalAudio      = document.getElementById('modal-audio');
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

function openModal(regra = null) {
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
    modalOverlay.classList.add('open');
}

function closeModal() { modalOverlay.classList.remove('open'); }

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
        const res = await fetch('/api/respostas');
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
                <div style="margin-top:.4rem;display:flex;gap:.3rem">${audioBadge}${mediaBadge}</div>
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
