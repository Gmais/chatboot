// =====================================
// SOCKET.IO
// =====================================
const socket = io();

// =====================================
// SIDEBAR RECOLHÍVEL — mais espaço de tela pras telas do painel. Preferência
// fica salva no localStorage, então volta do jeito que a pessoa deixou.
// =====================================
const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
if (localStorage.getItem('sidebarCollapsed') === '1') {
    document.body.classList.add('sidebar-collapsed');
}
function atualizarTituloSidebarToggle() {
    if (!btnSidebarToggle) return;
    const recolhida = document.body.classList.contains('sidebar-collapsed');
    const rotulo = recolhida ? 'Expandir menu' : 'Recolher menu';
    btnSidebarToggle.title = rotulo;
    btnSidebarToggle.setAttribute('aria-label', rotulo);
}
atualizarTituloSidebarToggle();
btnSidebarToggle?.addEventListener('click', () => {
    const recolhida = document.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem('sidebarCollapsed', recolhida ? '1' : '0');
    atualizarTituloSidebarToggle();
});

// =====================================
// MENU MOBILE — em telas de celular a sidebar vira um painel off-canvas
// (escondido por padrão, desliza por cima do conteúdo quando aberto).
// =====================================
const btnMobileMenu = document.getElementById('btn-mobile-menu');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');

function fecharMenuMobile() {
    document.body.classList.remove('mobile-menu-open');
}
btnMobileMenu?.addEventListener('click', () => document.body.classList.toggle('mobile-menu-open'));
sidebarBackdrop?.addEventListener('click', fecharMenuMobile);

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
// ESTATÍSTICAS (PAINEL DE CONTROLE)
// =====================================
async function carregarEstatisticas() {
    const kpiGrid = document.getElementById('stats-kpi-grid');
    if (!kpiGrid) return;
    const periodo = document.getElementById('stats-periodo')?.value || 30;
    const msgsChart = document.getElementById('stats-msgs-chart');
    const msgsEixo = document.getElementById('stats-msgs-eixo');
    const statusLista = document.getElementById('stats-status-lista');
    const etiquetasLista = document.getElementById('stats-etiquetas-lista');
    const automacaoLista = document.getElementById('stats-automacao-lista');
    const iaCustoEl = document.getElementById('stats-ia-custo');
    const iaChamadasEl = document.getElementById('stats-ia-chamadas');
    const iaModelosEl = document.getElementById('stats-ia-modelos');
    const conexaoDesconexoesEl = document.getElementById('stats-conexao-desconexoes');
    const conexaoCrashesEl = document.getElementById('stats-conexao-crashes');
    const conexaoWatchdogEl = document.getElementById('stats-conexao-watchdog');
    const conexaoUltimaEl = document.getElementById('stats-conexao-ultima');
    const disparosTaxaEl = document.getElementById('stats-disparos-taxa');
    const disparosFalhasEl = document.getElementById('stats-disparos-falhas');
    const disparosErrosEl = document.getElementById('stats-disparos-erros');

    try {
        const res = await fetch(`/api/estatisticas?dias=${periodo}`);
        const s = await res.json();

        // ---- KPIs ----
        const tempoResp = s.atendimento.tempo_medio_resposta_min;
        const tempoRespFmt = tempoResp < 60 ? `${tempoResp}min` : `${(tempoResp / 60).toFixed(1)}h`;
        const kpis = [
            ['📥', 'green', 'Recebidas no período', s.mensagens.recebidas],
            ['📤', 'blue',  'Enviadas no período', s.mensagens.enviadas],
            ['🤖', 'green', 'Respostas automáticas', s.mensagens.respostas_automaticas],
            ['🙋', 'blue',  'Respostas manuais', s.mensagens.respostas_manuais],
            ['⏱️', 'amber', 'Tempo médio de resposta', tempoRespFmt],
            ['⚠️', 'amber', 'Ainda sem resposta', s.mensagens.nao_respondidas],
            ['👥', 'green', 'Novos contatos', s.contatos.novos_periodo],
            ['😴', 'amber', 'Inativos (30 dias)', s.contatos.inativos_30d],
        ];
        kpiGrid.innerHTML = kpis.map(([icone, cor, label, valor]) => `
            <div class="metric-card">
                <div class="metric-icon ${cor}">${icone}</div>
                <div class="metric-info">
                    <span class="metric-label">${label}</span>
                    <span class="metric-value" style="font-size:1.4rem">${valor}</span>
                </div>
            </div>
        `).join('');

        // ---- Gráfico: mensagens por dia (recebidas x enviadas) ----
        if (msgsChart) {
            const max = Math.max(1, ...s.mensagens.por_dia.flatMap(d => [d.recebidas, d.enviadas]));
            msgsChart.innerHTML = '';
            s.mensagens.por_dia.forEach(d => {
                const grupo = document.createElement('div');
                grupo.style.cssText = 'flex:1;min-width:3px;display:flex;align-items:flex-end;gap:1px;height:100%;cursor:pointer';
                grupo.tabIndex = 0;

                const alturaRec = Math.max(2, Math.round((d.recebidas / max) * 100));
                const alturaEnv = Math.max(2, Math.round((d.enviadas / max) * 100));
                const barRec = document.createElement('div');
                barRec.style.cssText = `flex:1;height:${alturaRec}%;background:var(--green);border-radius:2px 2px 0 0;min-width:1px`;
                const barEnv = document.createElement('div');
                barEnv.style.cssText = `flex:1;height:${alturaEnv}%;background:var(--blue);border-radius:2px 2px 0 0;min-width:1px`;
                grupo.append(barRec, barEnv);

                const dataFmt = new Date(d.data + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
                const rotulo = `${d.recebidas} recebida${d.recebidas !== 1 ? 's' : ''} · ${d.enviadas} enviada${d.enviadas !== 1 ? 's' : ''}`;
                const mostrar = () => mostrarChartTooltip(grupo, rotulo, dataFmt);
                grupo.addEventListener('mouseenter', mostrar);
                grupo.addEventListener('focus', mostrar);
                grupo.addEventListener('mouseleave', esconderChartTooltip);
                grupo.addEventListener('blur', esconderChartTooltip);

                msgsChart.appendChild(grupo);
            });
        }
        if (msgsEixo) {
            msgsEixo.innerHTML = '';
            const total = s.mensagens.por_dia.length;
            const passo = total > 14 ? Math.ceil(total / 10) : 1;
            s.mensagens.por_dia.forEach((d, i) => {
                const lbl = document.createElement('span');
                lbl.style.cssText = 'flex:1;text-align:center;font-size:.63rem;color:var(--text-3);min-width:3px';
                lbl.textContent = (i % passo === 0) ? d.diaMes : '';
                msgsEixo.appendChild(lbl);
            });
        }

        // ---- Conversas por status ----
        if (statusLista) {
            const rotulos = { aberta: '🟢 Abertas', fechada: '⚪ Fechadas', aguardando: '🟡 Aguardando' };
            const maxStatus = Math.max(1, ...s.atendimento.por_status.map(x => x.total));
            statusLista.innerHTML = s.atendimento.por_status.map(x => `
                <div>
                    <div style="display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:.3rem">
                        <span style="color:var(--text-2)">${rotulos[x.status] || x.status}</span>
                        <b style="color:var(--text-1)">${x.total}</b>
                    </div>
                    <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${(x.total / maxStatus) * 100}%"></div></div>
                </div>
            `).join('') + `
                <div style="display:flex;justify-content:space-between;font-size:.8rem;color:var(--text-3);margin-top:.2rem;padding-top:.7rem;border-top:1px solid rgba(255,255,255,0.06)">
                    <span>🙋 Aguardando humano agora</span><b style="color:var(--text-1)">${s.atendimento.aguardando_humano}</b>
                </div>
            `;
        }

        // ---- Contatos por etiqueta ----
        if (etiquetasLista) {
            const comEtiqueta = s.contatos.por_etiqueta.filter(e => e.total > 0);
            const maxE = Math.max(1, ...comEtiqueta.map(e => e.total));
            etiquetasLista.innerHTML = comEtiqueta.length
                ? comEtiqueta.map(e => `
                    <div style="display:flex;align-items:center;gap:.7rem">
                        <span style="width:110px;font-size:.8rem;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0">${e.nome}</span>
                        <div class="progress-bar-track" style="flex:1"><div class="progress-bar-fill" style="width:${(e.total / maxE) * 100}%;background:${e.cor}"></div></div>
                        <b style="width:28px;text-align:right;font-size:.8rem;flex-shrink:0">${e.total}</b>
                    </div>
                `).join('')
                : '<p style="color:var(--text-3);font-size:.85rem;text-align:center;padding:1rem 0">Nenhum contato etiquetado ainda.</p>';
        }

        // ---- Automações ----
        if (automacaoLista) {
            automacaoLista.innerHTML = s.automacao.fluxos.length
                ? s.automacao.fluxos.map(a => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:.5rem 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                        <div>
                            <div style="font-size:.85rem;color:var(--text-1);font-weight:500">${a.nome}${!a.ativo ? ' <span style="color:var(--text-3);font-weight:400">(pausada)</span>' : ''}</div>
                            <div style="font-size:.72rem;color:var(--text-3)">${a.em_andamento} em andamento</div>
                        </div>
                        <b style="color:var(--green);font-size:.9rem">${a.concluidos_total}</b>
                    </div>
                `).join('')
                : '<p style="color:var(--text-3);font-size:.85rem;text-align:center;padding:1rem 0">Nenhuma automação criada ainda.</p>';
        }

        // ---- Custo de IA ----
        if (iaCustoEl) iaCustoEl.textContent = `$${s.ia.custo_estimado_usd.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
        if (iaChamadasEl) iaChamadasEl.textContent = s.ia.chamadas;
        if (iaModelosEl) {
            iaModelosEl.innerHTML = s.ia.por_modelo.length
                ? s.ia.por_modelo.map(m => `
                    <div style="display:flex;justify-content:space-between;font-size:.8rem;padding:.3rem 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                        <span style="color:var(--text-2)">${m.provedor === 'groq' ? '⚡' : '🟢'} ${m.modelo}</span>
                        <span style="color:var(--text-3)">${m.chamadas}x ${m.custo_estimado_usd > 0 ? `· $${m.custo_estimado_usd.toFixed(4)}` : '· grátis'}</span>
                    </div>
                `).join('')
                : '<p style="color:var(--text-3);font-size:.85rem;text-align:center;padding:.5rem 0">Nenhuma resposta de IA no período.</p>';
        }

        // ---- Conexão ----
        if (conexaoDesconexoesEl) conexaoDesconexoesEl.textContent = s.conexao.desconexoes_periodo;
        if (conexaoCrashesEl) conexaoCrashesEl.textContent = s.conexao.crashes_periodo;
        if (conexaoWatchdogEl) conexaoWatchdogEl.textContent = s.conexao.watchdog_periodo;
        if (conexaoUltimaEl) {
            const u = s.conexao.ultima_desconexao;
            const ROTULO_TIPO = { crash: 'crash', runtime_watchdog: 'watchdog (sessão travada)' };
            conexaoUltimaEl.textContent = u
                ? `Última: ${ROTULO_TIPO[u.tipo] || 'desconexão'} em ${new Date(u.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${u.motivo ? ` — ${u.motivo}` : ''}`
                : 'Sem desconexões registradas.';
        }

        // ---- Disparos ----
        if (disparosTaxaEl) {
            disparosTaxaEl.textContent = `${s.disparos.taxa_entrega_pct}%`;
            disparosTaxaEl.style.color = s.disparos.taxa_entrega_pct >= 90 ? 'var(--green)' : (s.disparos.taxa_entrega_pct >= 70 ? 'var(--amber)' : 'var(--red)');
        }
        if (disparosFalhasEl) disparosFalhasEl.textContent = s.disparos.falhas_periodo;
        if (disparosErrosEl) {
            disparosErrosEl.innerHTML = s.disparos.principais_erros.length
                ? s.disparos.principais_erros.map(e => `
                    <div style="display:flex;justify-content:space-between;font-size:.78rem;color:var(--text-2)">
                        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:75%">${e.erro}</span>
                        <b style="color:var(--text-3)">${e.n}</b>
                    </div>
                `).join('')
                : '<p style="color:var(--text-3);font-size:.85rem;text-align:center;padding:.5rem 0">Nenhuma falha no período.</p>';
        }
    } catch (e) {
        console.error('Erro ao carregar estatísticas', e);
        kpiGrid.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:1rem;grid-column:1/-1">Erro ao carregar estatísticas.</p>';
    }
}

document.getElementById('stats-periodo')?.addEventListener('change', carregarEstatisticas);
carregarEstatisticas();

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
        fecharMenuMobile();
        const secaoAnteriorId = document.querySelector('.page-section:not(.hidden)')?.id;
        navBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const targetId = btn.getAttribute('data-target');
        // Busca/filtro de contatos não fica "salvo" de uma visita pra outra —
        // sair de Contatos ou Disparos limpa a barra de pesquisa e as etiquetas
        // selecionadas, voltando a lista pro estado vazio de novo.
        if (secaoAnteriorId && secaoAnteriorId !== targetId) {
            if (secaoAnteriorId === 'contatos-section') {
                if (contatosPageBusca) contatosPageBusca.value = '';
                etiquetasFiltroAtivasPage.clear();
                renderFiltroEtiquetasPage();
                renderContatosPage();
            } else if (secaoAnteriorId === 'disparos-section') {
                if (contatosBusca) contatosBusca.value = '';
                etiquetasFiltroAtivas.clear();
                renderFiltroEtiquetas();
                renderContatos();
            }
        }
        pageSections.forEach(s => s.classList.add('hidden'));
        const target = document.getElementById(targetId);
        if (target) target.classList.remove('hidden');
        // Título limpo (sem emojis de SVG)
        const text = btn.textContent.trim().split('\n')[0].trim();
        pageTitle.textContent = text;
        if (targetId === 'dashboard-section') {
            carregarEstatisticas();
            loadDisparoNumeros();
            loadDisparoRoteamento();
        }
        if (targetId === 'mensagens-section') loadRegras();
        if (targetId === 'ia-section') { loadIaConfig(); loadIaExemplosContagem(); }
        if (targetId === 'configuracoes-section') { loadHorarioConfig(); loadDelayResposta(); loadProgramacoes(); loadInstagramConfig(); }
        if (targetId === 'conversas-section') CM.onEnterSection();
        if (targetId === 'contatos-section' || targetId === 'disparos-section') loadContatos();
        if (targetId === 'integracoes-section') { loadPactoInadimplentes(); loadPactoVencemHoje(); loadAgendaAvaliacao(); loadGympulseConfig(); }
        if (targetId === 'automacoes-section') { loadEtiquetas().then(() => loadAutomacoes()); }
        if (targetId === 'mensagens-personalizadas-section') loadMensagensPersonalizadas();
        if (targetId === 'disparos-section') {
            loadAcompanhamentoAutomacoes();
            loadAutomacaoDelayConfig();
            carregarMensagensPersonalizadasParaDisparo();
            // Limpa o formulário de Disparo em massa toda vez que a tela é
            // aberta — antes só limpava quando um disparo terminava
            // (broadcast_done), então reload/navegação/cache do navegador
            // ainda podiam trazer de volta números/mensagem do disparo
            // anterior. Sem efeito nenhum se um disparo estiver rodando —
            // ele usa o estado do servidor, não o valor local do campo.
            resetarFormularioDisparo();
            sincronizarEstadoDisparo();
            carregarDisparoHistorico();
        }
        if (targetId === 'relatorio-section') { loadRelatorioErrosWhatsapp(); loadRelatorioSemCadastro(); loadContratosSemAssinar('juliana'); loadContratosSemAssinar('isadora'); }
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
        // Rota dedicada (não a genérica /api/configuracoes) — é a única tela
        // que precisa mesmo da chave de API em texto puro, pra mostrar/editar
        // o que já está salvo.
        const res = await fetch('/api/ia/config');
        const config = await res.json();
        const provider = config.ia_provider || 'openai';
        if (iaProvider)    iaProvider.value  = provider;
        updateIaProviderUI(provider);
        if (iaStatus)      iaStatus.checked  = config.openai_status === 'true';
        if (iaTreinamento) iaTreinamento.value = config.openai_treinamento || '';
        if (iaCampanhaMes) iaCampanhaMes.value = config.ia_campanha_mes || '';
        if (iaAprenderConsultoras) iaAprenderConsultoras.checked = config.ia_aprender_com_consultoras === 'true';
        if (iaEmbeddingsApikey) iaEmbeddingsApikey.value = config.ia_embeddings_api_key || '';
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
        ia_aprender_com_consultoras: iaAprenderConsultoras?.checked ? 'true' : 'false',
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
// IA — APRENDER COM CONSULTORAS (exemplos reais via RAG)
// =====================================
const iaAprenderConsultoras   = document.getElementById('ia-aprender-consultoras');
const iaExemplosContagemEl    = document.getElementById('ia-exemplos-contagem');
const btnIaImportarHistorico  = document.getElementById('btn-ia-importar-historico');
const iaExemplosProgressoEl   = document.getElementById('ia-exemplos-progresso');
const iaEmbeddingsApikey      = document.getElementById('ia-embeddings-apikey');
const btnIaEmbeddingsApikeySalvar = document.getElementById('btn-ia-embeddings-apikey-salvar');

// Chave separada da usada pro chat — embeddings sempre passam pela OpenAI,
// mesmo com o provider de chat em Groq (é exatamente essa mistura que causou
// o bug real: um valor de chave do Groq acabou salvo no campo de chave da
// OpenAI, e como o campo só aparece na tela quando o provider é "OpenAI",
// ninguém percebeu até o backfill falhar com 401).
btnIaEmbeddingsApikeySalvar?.addEventListener('click', async () => {
    const valor = (iaEmbeddingsApikey?.value || '').trim();
    if (valor && !valor.startsWith('sk-')) {
        if (!confirm('Essa chave não começa com "sk-", que é o formato padrão das chaves da OpenAI — parece ser de outro provider (Groq, por exemplo). Salvar mesmo assim?')) return;
    }
    try {
        await fetch('/api/configuracoes', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ia_embeddings_api_key: valor })
        });
        showToast('Chave salva!', '', 'success', 2000);
    } catch (e) {
        showToast('Erro', 'Não foi possível salvar a chave', 'error');
    }
});

// Esse checkbox fica longe do botão "Salvar Configurações da IA" (outro
// card, lá em cima) — salva sozinho ao clicar, mesmo padrão dos outros
// toggles independentes do sistema (Automação, Programação), senão a pessoa
// marca, sai da tela sem lembrar de clicar em Salvar lá em cima, e ao voltar
// parece que "não salvou".
iaAprenderConsultoras?.addEventListener('change', async () => {
    try {
        await fetch('/api/configuracoes', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ia_aprender_com_consultoras: iaAprenderConsultoras.checked ? 'true' : 'false' })
        });
        showToast(iaAprenderConsultoras.checked ? 'Ativado' : 'Desativado', '', 'success', 2000);
    } catch (e) {
        showToast('Erro', 'Não foi possível salvar', 'error');
    }
});

async function loadIaExemplosContagem() {
    if (!iaExemplosContagemEl) return;
    try {
        const res = await fetch('/api/ia/exemplos/contagem');
        const data = await res.json();
        iaExemplosContagemEl.textContent = data.total || 0;
    } catch (e) {
        console.error('Erro ao carregar contagem de exemplos de IA', e);
    }
}

btnIaImportarHistorico?.addEventListener('click', async () => {
    if (!confirm('Isso vai escanear todo o histórico de conversas com respostas manuais de consultoras e gerar exemplos pra IA — usa a API da OpenAI (custo pequeno) e pode levar alguns minutos. Continuar?')) return;
    try {
        const res = await fetch('/api/ia/exemplos/importar-historico', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao iniciar importação');
        btnIaImportarHistorico.disabled = true;
        if (iaExemplosProgressoEl) { iaExemplosProgressoEl.style.display = 'block'; iaExemplosProgressoEl.textContent = 'Iniciando...'; }
        showToast('Importação iniciada', 'Rodando em segundo plano.', 'success');
    } catch (err) {
        showToast('Erro', err.message, 'error');
    }
});

socket.on('ia_exemplos_progress', (p) => {
    if (!iaExemplosProgressoEl) return;
    iaExemplosProgressoEl.style.display = 'block';
    iaExemplosProgressoEl.textContent = `Processando ${p.processados}/${p.total} — ${p.indexados} exemplo(s) indexado(s)...`;
});

socket.on('ia_exemplos_done', (p) => {
    if (btnIaImportarHistorico) btnIaImportarHistorico.disabled = false;
    if (iaExemplosProgressoEl) iaExemplosProgressoEl.textContent = `✅ Concluído: ${p.indexados} exemplo(s) novo(s) indexado(s) de ${p.total} conversa(s) revisada(s).`;
    loadIaExemplosContagem();
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
// COMPORTAMENTO DO ROBÔ — DELAY antes de responder
// =====================================
const cfgDelayResposta = document.getElementById('cfg-delay-resposta');

async function loadDelayResposta() {
    if (!cfgDelayResposta) return;
    try {
        const res = await fetch('/api/configuracoes');
        const config = await res.json();
        cfgDelayResposta.value = config.robo_delay_resposta_segundos || '0';
    } catch (e) {
        console.error('Erro ao carregar delay de resposta', e);
    }
}

cfgDelayResposta?.addEventListener('change', async () => {
    try {
        await fetch('/api/configuracoes', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ robo_delay_resposta_segundos: cfgDelayResposta.value })
        });
        const texto = cfgDelayResposta.value === '0' ? 'sem atraso' : `${cfgDelayResposta.value}s de atraso`;
        showToast('Delay atualizado!', `O robô agora responde com ${texto} antes de começar a digitar.`, 'success', 3500);
    } catch (e) {
        showToast('Erro', 'Não foi possível salvar o delay.', 'error');
    }
});

// =====================================
// INSTAGRAM (DMs)
// =====================================
const instagramWebhookUrlInput = document.getElementById('instagram-webhook-url');
const instagramVerifyTokenInput = document.getElementById('instagram-verify-token');
const instagramPageAccessTokenInput = document.getElementById('instagram-page-access-token');
const instagramAppSecretInput = document.getElementById('instagram-app-secret');
const btnInstagramConfigSalvar = document.getElementById('btn-instagram-config-salvar');

async function loadInstagramConfig() {
    if (!instagramWebhookUrlInput) return;
    instagramWebhookUrlInput.value = `${window.location.origin}/webhook/instagram`;
    try {
        const res = await fetch('/api/instagram/config');
        const config = await res.json();
        if (instagramVerifyTokenInput) instagramVerifyTokenInput.value = config.verify_token || '';
        if (instagramPageAccessTokenInput) instagramPageAccessTokenInput.value = config.page_access_token || '';
        if (instagramAppSecretInput) instagramAppSecretInput.value = config.app_secret || '';
    } catch (e) {
        console.error('Erro ao carregar configuração do Instagram', e);
    }
}

btnInstagramConfigSalvar?.addEventListener('click', async () => {
    try {
        await fetch('/api/instagram/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                verify_token: instagramVerifyTokenInput?.value || '',
                page_access_token: instagramPageAccessTokenInput?.value || '',
                app_secret: instagramAppSecretInput?.value || '',
            }),
        });
        showToast('Instagram salvo!', 'Configuração atualizada.', 'success', 3000);
    } catch (e) {
        showToast('Erro', 'Não foi possível salvar a configuração do Instagram.', 'error');
    }
});

// =====================================
// GYMPULSEPRO (resumo diário de treino)
// =====================================
const gympulseWebhookUrlInput = document.getElementById('gympulse-webhook-url');
const gympulseWebhookKeyInput = document.getElementById('gympulse-webhook-key');
const btnGympulseGerarChave = document.getElementById('btn-gympulse-gerar-chave');

async function loadGympulseConfig() {
    if (!gympulseWebhookUrlInput) return;
    gympulseWebhookUrlInput.value = `${window.location.origin}/webhooks/gympulse-daily-report`;
    try {
        const res = await fetch('/api/gympulse/config');
        const config = await res.json();
        if (gympulseWebhookKeyInput) gympulseWebhookKeyInput.value = config.webhook_key || '';
    } catch (e) {
        console.error('Erro ao carregar configuração do GympulsePro', e);
    }
}

btnGympulseGerarChave?.addEventListener('click', async () => {
    if (!confirm('Gerar uma chave nova? A chave atual para de funcionar na hora — só faça isso se já for atualizar do lado do GympulsePro também.')) return;
    try {
        const res = await fetch('/api/gympulse/config', { method: 'PUT' });
        const data = await res.json();
        if (gympulseWebhookKeyInput) gympulseWebhookKeyInput.value = data.webhook_key || '';
        showToast('Chave gerada!', 'Atualize a configuração no GympulsePro com a nova chave.', 'success', 4000);
    } catch (e) {
        showToast('Erro', 'Não foi possível gerar uma nova chave.', 'error');
    }
});

// =====================================
// HORÁRIO DE FUNCIONAMENTO
// =====================================
const horarioAtivo          = document.getElementById('horario-ativo');
const horarioModoPadrao     = document.getElementById('horario-modo-padrao');
const horarioMensagemHumano = document.getElementById('horario-mensagem-humano');
const horarioFallbackAtivo    = document.getElementById('horario-fallback-ativo');
const horarioFallbackSegundos = document.getElementById('horario-fallback-segundos');
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
        if (horarioFallbackAtivo) horarioFallbackAtivo.checked = !!data.fallback_ativo;
        if (horarioFallbackSegundos) horarioFallbackSegundos.value = data.fallback_segundos || 180;
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
        fallback_ativo: !!horarioFallbackAtivo?.checked,
        fallback_segundos: Number(horarioFallbackSegundos?.value) || 180,
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
// PROGRAMAÇÃO — agenda automações pra disparar sozinhas em dias/horário
// =====================================
const programacoesLista        = document.getElementById('programacoes-lista');
const btnNovaProgramacao       = document.getElementById('btn-nova-programacao');
const modalProgramacao         = document.getElementById('modal-programacao-overlay');
const modalProgramacaoTitulo   = document.getElementById('modal-programacao-titulo');
const programacaoIdInput       = document.getElementById('programacao-id');
const programacaoNomeInput     = document.getElementById('programacao-nome');
const programacaoDiasDiv       = document.getElementById('programacao-dias');
const programacaoHorarioInput  = document.getElementById('programacao-horario');
const programacaoAcoesListaDiv = document.getElementById('programacao-acoes-lista');
const btnAddProgramacaoAcao    = document.getElementById('btn-add-programacao-acao');
const btnProgramacaoSalvar     = document.getElementById('btn-programacao-salvar');
const modalProgramacaoFechar   = document.getElementById('modal-programacao-fechar');

let programacaoDiasSelecionados = [1, 2, 3, 4, 5];
let programacaoAcoesForm = []; // [{ tipo: 'automacao'|'disparo', valor: automacao_id | chave_da_campanha }, ...]

function renderProgramacaoDias() {
    if (!programacaoDiasDiv) return;
    programacaoDiasDiv.innerHTML = DIAS_SEMANA.map((label, d) => `
        <label style="display:flex;align-items:center;gap:.3rem;cursor:pointer;font-size:.82rem">
            <input type="checkbox" class="programacao-dia" data-dia="${d}" ${programacaoDiasSelecionados.includes(d) ? 'checked' : ''} style="accent-color:var(--green)"> ${label}
        </label>
    `).join('');
}

programacaoDiasDiv?.addEventListener('change', (e) => {
    if (!e.target.classList.contains('programacao-dia')) return;
    const dia = Number(e.target.dataset.dia);
    if (e.target.checked) { if (!programacaoDiasSelecionados.includes(dia)) programacaoDiasSelecionados.push(dia); }
    else programacaoDiasSelecionados = programacaoDiasSelecionados.filter(d => d !== dia);
});

// Cada ação escolhe primeiro um TIPO — e o tipo decide qual AÇÃO roda de
// verdade no horário agendado (ver checarProgramacoes no backend):
// "Automação" (escolhe da lista completa) roda Importar Lista — sincroniza a
// fila da automação com quem tem a etiqueta agora. "Disparo" (escolhe pela
// Campanha Rápida, ver CAMPANHAS_INFO) roda Disparar Mensagens — manda pra
// quem já está na fila. Por isso costuma fazer sentido encadear os dois na
// mesma automação: 1ª ação "Automação" importa, 2ª ação "Disparo" dispara.
function renderProgramacaoAcoesForm() {
    if (!programacaoAcoesListaDiv) return;
    if (programacaoAcoesForm.length === 0) {
        programacaoAcoesListaDiv.innerHTML = '<p style="color:var(--text-3);font-size:.82rem">Nenhuma ação adicionada — clique em "+ Adicionar outra ação".</p>';
        return;
    }
    programacaoAcoesListaDiv.innerHTML = programacaoAcoesForm.map((acao, idx) => `
        <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;background:rgba(255,255,255,0.03);border-radius:8px;padding:.6rem">
            <select class="programacao-acao-tipo" data-idx="${idx}" style="background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:var(--radius-sm);padding:.55rem .7rem;color:var(--text-1);font-family:'Inter',sans-serif;font-size:.85rem">
                <option value="automacao" ${acao.tipo === 'automacao' ? 'selected' : ''}>Automação</option>
                <option value="disparo" ${acao.tipo === 'disparo' ? 'selected' : ''}>Disparo</option>
            </select>
            ${acao.tipo === 'disparo' ? `
                <select class="programacao-acao-valor" data-idx="${idx}" style="flex:1;min-width:180px;background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:var(--radius-sm);padding:.55rem .7rem;color:var(--text-1);font-family:'Inter',sans-serif;font-size:.85rem">
                    <option value="">Selecione um tipo de disparo...</option>
                    ${Object.entries(CAMPANHAS_INFO).map(([chave, info]) => `<option value="${chave}" ${acao.valor === chave ? 'selected' : ''}>${info.icon} ${info.label}</option>`).join('')}
                </select>
            ` : `
                <select class="programacao-acao-valor" data-idx="${idx}" style="flex:1;min-width:180px;background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:var(--radius-sm);padding:.55rem .7rem;color:var(--text-1);font-family:'Inter',sans-serif;font-size:.85rem">
                    <option value="">Selecione uma automação...</option>
                    ${automacoesGlobais.map(a => `<option value="${a.id}" ${String(acao.valor) === String(a.id) ? 'selected' : ''}>${a.nome}${!a.ativo ? ' (pausada)' : ''}</option>`).join('')}
                </select>
            `}
            <button type="button" class="btn-remove-programacao-acao" data-idx="${idx}" style="background:none;border:none;color:var(--red);font-size:1.1rem;cursor:pointer;padding:.2rem .5rem">✕</button>
        </div>
        ${idx < programacaoAcoesForm.length - 1 ? `
            <div style="display:flex;align-items:center;gap:.5rem;padding:.2rem 0 .2rem .8rem;border-left:2px solid rgba(255,255,255,0.08);margin-left:1rem">
                <span style="color:var(--text-3);font-size:.75rem">⏱️ Esperar</span>
                <select class="programacao-acao-intervalo" data-idx="${idx}" style="background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:var(--radius-sm);padding:.35rem .6rem;color:var(--text-1);font-family:'Inter',sans-serif;font-size:.78rem">
                    <option value="60" ${(acao.intervaloDepoisSegundos || 60) === 60 ? 'selected' : ''}>1 minuto</option>
                    <option value="180" ${acao.intervaloDepoisSegundos === 180 ? 'selected' : ''}>3 minutos</option>
                    <option value="300" ${acao.intervaloDepoisSegundos === 300 ? 'selected' : ''}>5 minutos</option>
                </select>
                <span style="color:var(--text-3);font-size:.75rem">antes da próxima ação</span>
            </div>
        ` : ''}
    `).join('');
}

function sincronizarProgramacaoAcoesDoDOM() {
    if (!programacaoAcoesListaDiv) return;
    programacaoAcoesListaDiv.querySelectorAll('.programacao-acao-tipo').forEach(sel => {
        const idx = Number(sel.dataset.idx);
        if (programacaoAcoesForm[idx]) programacaoAcoesForm[idx].tipo = sel.value;
    });
    programacaoAcoesListaDiv.querySelectorAll('.programacao-acao-valor').forEach(sel => {
        const idx = Number(sel.dataset.idx);
        if (programacaoAcoesForm[idx]) programacaoAcoesForm[idx].valor = sel.value;
    });
    programacaoAcoesListaDiv.querySelectorAll('.programacao-acao-intervalo').forEach(sel => {
        const idx = Number(sel.dataset.idx);
        if (programacaoAcoesForm[idx]) programacaoAcoesForm[idx].intervaloDepoisSegundos = Number(sel.value);
    });
}

btnAddProgramacaoAcao?.addEventListener('click', () => {
    sincronizarProgramacaoAcoesDoDOM();
    programacaoAcoesForm.push({ tipo: 'automacao', valor: '', intervaloDepoisSegundos: 60 });
    renderProgramacaoAcoesForm();
});

programacaoAcoesListaDiv?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-remove-programacao-acao');
    if (!btn) return;
    sincronizarProgramacaoAcoesDoDOM();
    programacaoAcoesForm.splice(Number(btn.dataset.idx), 1);
    renderProgramacaoAcoesForm();
});

// Trocar o Tipo (Automação ↔ Disparo) troca as opções do segundo seletor —
// reseta o valor escolhido antes, senão fica um automacao_id "vazando" pro
// contexto de chave de campanha (ou vice-versa) até o usuário escolher de novo.
programacaoAcoesListaDiv?.addEventListener('change', (e) => {
    if (!e.target.classList.contains('programacao-acao-tipo')) return;
    sincronizarProgramacaoAcoesDoDOM();
    const idx = Number(e.target.dataset.idx);
    if (programacaoAcoesForm[idx]) programacaoAcoesForm[idx].valor = '';
    renderProgramacaoAcoesForm();
});

async function abrirModalProgramacao(prog = null) {
    if (automacoesGlobais.length === 0) await loadAutomacoes();
    if (modalProgramacaoTitulo) modalProgramacaoTitulo.textContent = prog ? '✏️ Editar Programação' : '➕ Nova Programação';
    if (programacaoIdInput) programacaoIdInput.value = prog?.id || '';
    if (programacaoNomeInput) programacaoNomeInput.value = prog?.nome || '';
    if (programacaoHorarioInput) programacaoHorarioInput.value = prog?.horario || '08:00';
    programacaoDiasSelecionados = prog ? [...prog.dias] : [1, 2, 3, 4, 5];
    // "Automação" = roda Importar Lista (sincroniza fila); "Disparo" = roda
    // Disparar Mensagens (manda pra fila). Ao editar, uma ação "Disparo" volta
    // a mostrar a Campanha Rápida certa (campanha_chave) — se não tiver (ação
    // criada antes dessa distinção existir), abre vazia pra escolher de novo.
    programacaoAcoesForm = prog ? prog.acoes.map(a => ({
        tipo: a.tipo === 'automacao' ? 'automacao' : 'disparo',
        valor: a.tipo === 'automacao' ? a.automacao_id : (a.campanha_chave || ''),
        intervaloDepoisSegundos: a.intervalo_depois_segundos || 60,
    })) : [];
    renderProgramacaoDias();
    renderProgramacaoAcoesForm();
    modalProgramacao?.classList.add('open');
}

btnNovaProgramacao?.addEventListener('click', () => abrirModalProgramacao(null));
modalProgramacaoFechar?.addEventListener('click', () => modalProgramacao?.classList.remove('open'));

btnProgramacaoSalvar?.addEventListener('click', async () => {
    sincronizarProgramacaoAcoesDoDOM();
    const nome = (programacaoNomeInput?.value || '').trim();
    const horario = programacaoHorarioInput?.value || '';
    if (!nome) { showToast('Erro', 'Digite um nome pra programação.', 'error'); return; }
    if (programacaoDiasSelecionados.length === 0) { showToast('Erro', 'Escolha pelo menos um dia da semana.', 'error'); return; }
    if (!horario) { showToast('Erro', 'Escolha um horário.', 'error'); return; }
    if (programacaoAcoesForm.length === 0) { showToast('Erro', 'Adicione pelo menos uma ação.', 'error'); return; }

    // "Automação" roda Importar Lista (gera a fila a partir da etiqueta);
    // "Disparo" roda Disparar Mensagens (manda pra quem já está na fila) —
    // resolve a campanha escolhida pra automação correspondente (mesma
    // lógica de encontrarAutomacaoDaCampanha, usada pelas Campanhas Rápidas
    // em Disparos).
    if (automacoesGlobais.length === 0) await loadAutomacoes();
    const acoes = [];
    for (const acao of programacaoAcoesForm) {
        if (!acao.valor) { showToast('Erro', 'Preencha todas as ações antes de salvar.', 'error'); return; }
        if (acao.tipo === 'disparo') {
            const automacao = encontrarAutomacaoDaCampanha(acao.valor);
            if (!automacao) {
                showToast('Erro', `Nenhuma automação encontrada pra "${CAMPANHAS_INFO[acao.valor]?.label || acao.valor}". Crie ou renomeie uma automação com um nome parecido.`, 'error', 6000);
                return;
            }
            acoes.push({ automacao_id: automacao.id, tipo: 'disparo', campanha_chave: acao.valor, intervalo_depois_segundos: acao.intervaloDepoisSegundos || 60 });
        } else {
            acoes.push({ automacao_id: Number(acao.valor), tipo: 'automacao', campanha_chave: null, intervalo_depois_segundos: acao.intervaloDepoisSegundos || 60 });
        }
    }

    const payload = { nome, dias: programacaoDiasSelecionados, horario, acoes };
    const id = programacaoIdInput?.value;
    try {
        const res = await fetch(id ? `/api/programacoes/${id}` : '/api/programacoes', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao salvar programação');
        showToast('Programação salva!', '', 'success');
        modalProgramacao?.classList.remove('open');
        loadProgramacoes();
    } catch (err) {
        showToast('Erro', err.message, 'error');
    }
});

function renderProgramacoes(lista) {
    if (!programacoesLista) return;
    if (lista.length === 0) {
        programacoesLista.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-3)">Nenhuma programação criada ainda.</div>';
        return;
    }
    programacoesLista.innerHTML = lista.map(p => {
        const diasTxt = p.dias.length === 7 ? 'Todos os dias' : p.dias.sort().map(d => DIAS_SEMANA[d]).join(', ');
        const acoesTxt = p.acoes.map(a => {
            const rotulo = a.tipo === 'automacao' ? '📥 Importar' : '🚀 Disparar';
            return `<span class="etiqueta-chip" style="background:${a.etiqueta_cor || '#25D366'}22;color:${a.etiqueta_cor || '#25D366'};border:1px solid ${a.etiqueta_cor || '#25D366'}55">${rotulo} · ${a.nome}${!a.ativo ? ' ⏸️' : ''}</span>`;
        }).join(' ');
        return `
            <div class="card glass" style="padding:1rem 1.2rem" data-programacao-id="${p.id}">
                <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
                    <div style="flex:1;min-width:200px">
                        <div style="font-weight:600;color:var(--text-1);font-size:.9rem;margin-bottom:.3rem">${p.nome}</div>
                        <div style="font-size:.78rem;color:var(--text-3)">🗓️ ${diasTxt} · ⏰ ${p.horario}</div>
                        <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.5rem">${acoesTxt}</div>
                    </div>
                    <label style="display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--text-3);cursor:pointer">
                        <input type="checkbox" class="programacao-toggle-ativo" data-id="${p.id}" ${p.ativo ? 'checked' : ''} style="accent-color:var(--green);width:16px;height:16px">
                        Ativo
                    </label>
                    <button type="button" class="btn-secondary btn-editar-programacao" data-id="${p.id}" style="padding:.4rem .8rem;font-size:.78rem">✏️ Editar</button>
                    <button type="button" class="btn-danger btn-excluir-programacao" data-id="${p.id}" style="padding:.4rem .8rem;font-size:.78rem">🗑️</button>
                </div>
            </div>
        `;
    }).join('');
}

let programacoesGlobais = [];
async function loadProgramacoes() {
    if (!programacoesLista) return;
    try {
        const res = await fetch('/api/programacoes');
        programacoesGlobais = await res.json();
        renderProgramacoes(programacoesGlobais);
    } catch (e) {
        programacoesLista.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-3)">Erro ao carregar programações.</div>';
    }
}

programacoesLista?.addEventListener('click', async (e) => {
    const btnEditar = e.target.closest('.btn-editar-programacao');
    if (btnEditar) {
        const prog = programacoesGlobais.find(p => p.id === Number(btnEditar.dataset.id));
        if (prog) abrirModalProgramacao(prog);
        return;
    }
    const btnExcluir = e.target.closest('.btn-excluir-programacao');
    if (btnExcluir) {
        if (!confirm('Excluir essa programação? As automações vinculadas continuam existindo, só param de disparar sozinhas.')) return;
        try {
            await fetch(`/api/programacoes/${btnExcluir.dataset.id}`, { method: 'DELETE' });
            showToast('Programação excluída', '', 'success', 2500);
            loadProgramacoes();
        } catch (err) {
            showToast('Erro', 'Não foi possível excluir a programação', 'error');
        }
    }
});

programacoesLista?.addEventListener('change', async (e) => {
    const toggle = e.target.closest('.programacao-toggle-ativo');
    if (!toggle) return;
    try {
        await fetch(`/api/programacoes/${toggle.dataset.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ativo: toggle.checked })
        });
        showToast(toggle.checked ? 'Programação ativada' : 'Programação pausada', '', 'success', 2000);
    } catch (e) {
        showToast('Erro', 'Não foi possível atualizar a programação', 'error');
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
        <div class="etiqueta-gerenciar-row" data-id="${e.id}" style="display:flex;align-items:center;gap:.6rem;padding:.6rem;background:rgba(255,255,255,0.03);border-radius:8px;flex-wrap:wrap">
            <input type="color" class="etiqueta-cor-input" value="${e.cor}" style="width:34px;height:34px;border:none;border-radius:6px;cursor:pointer;background:none;flex-shrink:0">
            <input type="text" class="etiqueta-nome-input" value="${e.nome}" style="flex:1;min-width:120px;background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:.4rem .6rem;color:var(--text-1);font-family:'Inter',sans-serif">
            <label style="display:flex;align-items:center;gap:.35rem;font-size:.72rem;color:var(--text-3);white-space:nowrap" title="Deixe em branco pra etiqueta permanente. Se preencher, ela some sozinha desse contato depois de N dias — cada contato tem seu próprio prazo, contado de quando a etiqueta foi aplicada nele.">
                ⏳ dura
                <input type="number" class="etiqueta-duracao-input" min="1" value="${e.duracao_dias || ''}" placeholder="∞" style="width:56px;background:var(--input-bg);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:.35rem .4rem;color:var(--text-1);font-family:'Inter',sans-serif">
                dias
            </label>
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
        const duracao_dias = row.querySelector('.etiqueta-duracao-input').value.trim() || null;
        if (!nome) { showToast('Erro', 'Nome não pode ficar em branco', 'error'); return; }
        try {
            const res = await fetch(`/api/etiquetas/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome, cor, duracao_dias })
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
document.getElementById('btn-chat-gerenciar-etiqueta')?.addEventListener('click', abrirGerenciarEtiquetas);

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
// CAMPANHAS RÁPIDAS (atalhos no topo de Disparos, Automação e Mensagens
// Personalizadas) — o MESMO botão (ex: "INADIMPLENTES") faz uma coisa
// diferente em cada tela; não é um atalho genérico único.
// - Mensagens Personalizadas: abre a biblioteca filtrada por campanha.
// - Automação: acha a automação cujo NOME bate com a campanha (ex: botão
//   "Pós Venda 2" acha a automação chamada "Pós Venda 2") e importa a lista
//   dela — mesma ação do botão "📥 Importar Lista" daquele card.
// - Disparos: ainda espera sua própria função.
// =====================================

// Compara nomes ignorando acento/maiúscula/espaço/pontuação — assim
// "Aniversariante", "Aniversariantes" e "aniversariante(s)" batem igual.
function normalizarTexto(s) {
    // Tira acento sem embutir caractere combinante literal na fonte (evita
    // risco de corrupção de encoding): normaliza NFD e descarta pelo
    // code point (faixa dos diacríticos combinantes, U+0300–U+036F).
    const semAcento = (s || '').toString().normalize('NFD')
        .split('').filter(ch => { const c = ch.codePointAt(0); return c < 0x0300 || c > 0x036f; }).join('');
    return semAcento.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Cada campanha exige que TODAS as palavras-chave apareçam OU no nome da
// automação OU no nome da etiqueta dela (ex: a automação pode se chamar
// "Aviso de Vencimento" mas a etiqueta que a alimenta chama "Vence Hoje" —
// qualquer um dos dois batendo já conta). Evita, por exemplo, o botão
// "Alunos Novos" (precisa de "aluno" E "novo") casar com uma automação
// chamada só "Ex-Alunos".
const CAMPANHA_MATCH_KEYWORDS = {
    'aniversariantes':         ['aniversari'],
    'confirmacao-agendamento': ['agenda'],
    'alunos-novos':            ['aluno', 'novo'],
    'inadimplentes':           ['inadimplent'],
    'parcelas-atrasadas':      ['parcela', 'atrasad'],
    'vence-hoje':              ['vence', 'hoje'],
    'ex-alunos':               ['ex', 'aluno'],
    'pos-venda-1':             ['posvenda', '1'],
    'pos-venda-2':             ['posvenda', '2'],
};

function encontrarAutomacaoDaCampanha(campanha) {
    const keywords = CAMPANHA_MATCH_KEYWORDS[campanha];
    if (!keywords) return null;
    return automacoesGlobais.find(a => {
        const candidatos = [normalizarTexto(a.nome), normalizarTexto(a.etiqueta_nome)];
        return candidatos.some(texto => keywords.every(k => texto.includes(k)));
    }) || null;
}

document.querySelectorAll('.btn-campanha-rapida').forEach(btn => {
    btn.addEventListener('click', async () => {
        const campanha = btn.dataset.campanha;
        const secaoId = btn.closest('.page-section')?.id;

        if (secaoId === 'mensagens-personalizadas-section') {
            filtroCategoriaMensagens = campanha;
            loadMensagensPersonalizadas();
            return;
        }

        if (secaoId === 'automacoes-section') {
            if (btn.disabled) return;
            if (automacoesGlobais.length === 0) await loadAutomacoes();
            const automacao = encontrarAutomacaoDaCampanha(campanha);
            if (!automacao) {
                const label = CAMPANHAS_INFO[campanha]?.label || campanha;
                showToast('Nenhuma automação encontrada', `Crie (ou renomeie) uma automação com um nome parecido com "${label}" pra esse botão importar a lista nela.`, 'error', 5500);
                return;
            }
            btn.disabled = true;
            try {
                const data = await importarListaParaAutomacao(automacao.id);
                const partes = [];
                if (data.importados > 0) partes.push(`${data.importados} novo(s)`);
                if (data.removidos > 0) partes.push(`${data.removidos} removido(s) (não tem mais a etiqueta)`);
                if (!automacao.ativo) partes.push('⚠️ automação está PAUSADA — ative pra ela começar a enviar');
                showToast(`Lista importada em "${automacao.nome}"`, partes.length ? partes.join(' · ') : 'Nenhuma mudança — fila já batia com a etiqueta.', 'success', 5000);
                loadAutomacoes();
            } catch (err) {
                showToast('Erro ao importar', err.message, 'error');
            } finally {
                btn.disabled = false;
            }
            return;
        }

        if (secaoId === 'disparos-section') {
            if (btn.disabled) return;
            if (automacoesGlobais.length === 0) await loadAutomacoes();
            const automacao = encontrarAutomacaoDaCampanha(campanha);
            if (!automacao) {
                const label = CAMPANHAS_INFO[campanha]?.label || campanha;
                showToast('Nenhuma automação encontrada', `Crie (ou renomeie) uma automação com um nome parecido com "${label}" pra esse botão disparar as mensagens dela.`, 'error', 5500);
                return;
            }
            btn.disabled = true;
            try {
                const res = await fetch(`/api/automacoes/${automacao.id}/disparar`, { method: 'POST' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro ao iniciar disparo');
                showToast(`Disparo iniciado — "${automacao.nome}"`, 'Rodando em segundo plano — espaçado pra não arriscar bloqueio no WhatsApp, pode levar minutos.', 'success', 6000);
            } catch (err) {
                showToast('Erro ao disparar', err.message, 'error');
            } finally {
                btn.disabled = false;
            }
            return;
        }

        showToast('Em breve', `Ação da campanha "${campanha}" nessa tela ainda não foi configurada.`, 'info', 2500);
    });
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
    // Sem busca digitada nem etiqueta selecionada, a lista fica vazia de
    // propósito — evita carregar/renderizar milhares de contatos de cara toda
    // vez que a tela abre. Etiqueta sozinha (sem digitar nada) ainda funciona,
    // pra continuar dando pra "navegar" por etiqueta.
    if (!termo && etiquetasFiltroAtivas.size === 0) return [];
    // Telefone é guardado só com dígitos — buscar "(42) 99956-4764" ou
    // "99956-4764" tem que bater mesmo com a pontuação, senão parece que o
    // contato não existe.
    const termoDigits = termo.replace(/\D/g, '');
    return todosContatos.filter(c => {
        const bateBusca = !termo || c.nome.toLowerCase().includes(termo) || (termoDigits && c.telefone.includes(termoDigits)) || (c.matricula || '').toLowerCase().includes(termo);
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
    const atual = contatosFiltroEtiquetas.value;
    contatosFiltroEtiquetas.innerHTML = '<option value="">🏷️ Todas as etiquetas</option>' +
        todasEtiquetas.map(e => `<option value="${e.id}">${e.nome}</option>`).join('');
    contatosFiltroEtiquetas.value = todasEtiquetas.some(e => String(e.id) === atual) ? atual : '';
}

contatosFiltroEtiquetas?.addEventListener('change', () => {
    etiquetasFiltroAtivas.clear();
    if (contatosFiltroEtiquetas.value) etiquetasFiltroAtivas.add(Number(contatosFiltroEtiquetas.value));
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

// Filtros extras (não são etiquetas de verdade) — quem ainda não tem
// matrícula ou data de nascimento cadastrada, pra achar contatos incompletos.
let filtroSemMatriculaAtivo = false;
let filtroSemDnAtivo = false;
const btnFiltroSemMatricula = document.getElementById('contatos-page-filtro-sem-matricula');
const btnFiltroSemDn = document.getElementById('contatos-page-filtro-sem-dn');

btnFiltroSemMatricula?.addEventListener('click', () => {
    filtroSemMatriculaAtivo = !filtroSemMatriculaAtivo;
    btnFiltroSemMatricula.classList.toggle('active', filtroSemMatriculaAtivo);
    btnFiltroSemMatricula.style.background = filtroSemMatriculaAtivo ? 'var(--amber)' : 'rgba(255,255,255,0.05)';
    btnFiltroSemMatricula.style.borderColor = filtroSemMatriculaAtivo ? 'var(--amber)' : 'rgba(245,158,11,0.35)';
    btnFiltroSemMatricula.style.color = filtroSemMatriculaAtivo ? '#000' : 'var(--amber)';
    renderContatosPage();
});

btnFiltroSemDn?.addEventListener('click', () => {
    filtroSemDnAtivo = !filtroSemDnAtivo;
    btnFiltroSemDn.classList.toggle('active', filtroSemDnAtivo);
    btnFiltroSemDn.style.background = filtroSemDnAtivo ? 'var(--red)' : 'rgba(255,255,255,0.05)';
    btnFiltroSemDn.style.borderColor = filtroSemDnAtivo ? 'var(--red)' : 'rgba(239,68,68,0.35)';
    btnFiltroSemDn.style.color = filtroSemDnAtivo ? '#fff' : 'var(--red)';
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
        const semFiltro = !(contatosBusca?.value || '').trim() && etiquetasFiltroAtivas.size === 0;
        contatosLista.innerHTML = `<p style="color:var(--text-3);text-align:center;padding:2rem">${semFiltro ? 'Busque por nome, telefone ou etiqueta pra ver os contatos.' : 'Nenhum contato encontrado.'}</p>`;
        atualizarContadorContatos();
        return;
    }
    contatosLista.innerHTML = filtrados.map(c => `
        <label class="contato-row" style="display:flex;align-items:center;gap:.7rem;padding:.6rem .7rem;border-radius:8px;cursor:pointer">
            <input type="checkbox" class="contato-check" data-telefone="${c.telefone}" ${contatosSelecionados.has(c.telefone) ? 'checked' : ''} style="accent-color:var(--green);width:16px;height:16px;flex-shrink:0">
            <div style="flex:1;min-width:0">
                <div style="font-size:.88rem;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.nome} ${c.etiquetas.map(e => etiquetaChipHtml(e, false)).join(' ')}</div>
                <div style="font-size:.75rem;color:var(--text-3)">${c.telefone}${c.matricula ? ` · Matrícula ${c.matricula}` : ''}</div>
            </div>
            <span style="font-size:.72rem;color:var(--text-3);flex-shrink:0">${c.mensagens_recebidas} msg${c.mensagens_recebidas !== 1 ? 's' : ''}</span>
        </label>
    `).join('');
    atualizarContadorContatos();
}

function contatosPageFiltrados() {
    const termo = (contatosPageBusca?.value || '').trim().toLowerCase();
    // Mesmo motivo do contatosFiltrados() acima: telefone só tem dígitos, a
    // busca digitada pode ter parênteses/traço.
    const termoDigits = termo.replace(/\D/g, '');
    return todosContatos.filter(c => {
        const bateBusca = !termo || c.nome.toLowerCase().includes(termo) || (termoDigits && c.telefone.includes(termoDigits)) || (c.matricula || '').toLowerCase().includes(termo);
        const bateEtiqueta = etiquetasFiltroAtivasPage.size === 0 || c.etiquetas.some(e => etiquetasFiltroAtivasPage.has(e.id));
        const bateSemMatricula = !filtroSemMatriculaAtivo || !c.matricula;
        const bateSemDn = !filtroSemDnAtivo || !c.data_nascimento;
        return bateBusca && bateEtiqueta && bateSemMatricula && bateSemDn;
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
    if (editarContatoTelefone) editarContatoTelefone.value = telefone;
    modalEditarContatoOverlay?.classList.add('open');
    renderEditarContatoEtiquetas();
}

function fecharEditarContato() {
    contatoEditandoTelefone = null;
    modalEditarContatoOverlay?.classList.remove('open');
}

// =====================================
// RELATÓRIO — erros de WhatsApp + cadastro incompleto
// =====================================
const relatorioErrosLista = document.getElementById('relatorio-erros-lista');
const relatorioSemCadastroLista = document.getElementById('relatorio-sem-cadastro-lista');

async function marcarRelatorioDispensa(tipo, telefone, motivo, checked) {
    try {
        await fetch('/api/relatorio/dispensar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tipo, telefone, motivo, checked })
        });
    } catch (e) {
        showToast('Erro', 'Não foi possível salvar a marcação', 'error');
    }
}

// Erros de WhatsApp precisa dos DOIS checkboxes marcados (BotPro + Pacto) pra
// sumir da lista — cada motivo é corrigido em sistema diferente (o cadastro
// aqui no BotPro e o cadastro no CRM Pacto), então só considera resolvido
// quando os dois lados confirmarem.
async function loadRelatorioErrosWhatsapp() {
    if (!relatorioErrosLista) return;
    try {
        const res = await fetch('/api/relatorio/erros-whatsapp');
        const lista = await res.json();
        relatorioErrosLista.innerHTML = lista.length
            ? lista.map(c => `
                <div class="contato-row" data-telefone="${c.telefone}" style="display:flex;align-items:center;gap:.8rem;padding:.6rem .7rem;border-radius:8px">
                    <div style="flex:1;min-width:0">
                        <div style="font-size:.88rem;color:var(--text-1);font-weight:500">${c.nome}</div>
                        <div style="font-size:.75rem;color:var(--text-3)">${c.telefone}${c.matricula ? ` · Matrícula ${c.matricula}` : ''}</div>
                        <div style="font-size:.75rem;color:var(--red);margin-top:.2rem">⚠️ ${c.erro}</div>
                    </div>
                    <label style="display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--text-3);cursor:pointer;white-space:nowrap">
                        <input type="checkbox" class="relatorio-erro-motivo" data-telefone="${c.telefone}" data-motivo="botpro" ${c.corrigido_botpro ? 'checked' : ''} style="accent-color:var(--green);width:16px;height:16px">
                        Corrigido BotPro
                    </label>
                    <label style="display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--text-3);cursor:pointer;white-space:nowrap">
                        <input type="checkbox" class="relatorio-erro-motivo" data-telefone="${c.telefone}" data-motivo="pacto" ${c.corrigido_pacto ? 'checked' : ''} style="accent-color:var(--green);width:16px;height:16px">
                        Corrigido Pacto
                    </label>
                </div>
            `).join('')
            : '<p style="color:var(--text-3);text-align:center;padding:1.5rem">Nenhum erro de envio pendente. 🎉</p>';
    } catch (e) {
        relatorioErrosLista.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:1.5rem">Erro ao carregar.</p>';
    }
}

relatorioErrosLista?.addEventListener('change', async (e) => {
    const chk = e.target.closest('.relatorio-erro-motivo');
    if (!chk) return;
    const linha = chk.closest('.contato-row');
    await marcarRelatorioDispensa('erro_whatsapp', chk.dataset.telefone, chk.dataset.motivo, chk.checked);
    // Só sai da lista quando as DUAS caixinhas dessa linha estiverem marcadas.
    const marcados = linha.querySelectorAll('.relatorio-erro-motivo:checked').length;
    if (marcados === 2) {
        linha.remove();
        showToast('Marcado como corrigido', '', 'success', 2000);
    }
});

// Sem Matrícula/Nascimento: os dois checkboxes são alternativos — marcar
// QUALQUER um dos dois ("Corrigido" ou "Não é aluno") já tira da lista.
async function loadRelatorioSemCadastro() {
    if (!relatorioSemCadastroLista) return;
    try {
        const res = await fetch('/api/relatorio/sem-cadastro');
        const lista = await res.json();
        relatorioSemCadastroLista.innerHTML = lista.length
            ? lista.map(c => {
                const faltando = [c.falta_matricula ? 'matrícula' : null, c.falta_nascimento ? 'data de nascimento' : null].filter(Boolean).join(' e ');
                return `
                    <div class="contato-row" data-telefone="${c.telefone}" style="display:flex;align-items:center;gap:.8rem;padding:.6rem .7rem;border-radius:8px">
                        <div class="relatorio-sem-cadastro-nome" data-telefone="${c.telefone}" style="flex:1;min-width:0;cursor:pointer">
                            <div style="font-size:.88rem;color:var(--text-1);font-weight:500;text-decoration:underline;text-decoration-style:dotted">${c.nome}</div>
                            <div style="font-size:.75rem;color:var(--text-3)">${c.telefone} · falta ${faltando}</div>
                        </div>
                        <label style="display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--text-3);cursor:pointer;white-space:nowrap">
                            <input type="checkbox" class="relatorio-cadastro-motivo" data-telefone="${c.telefone}" data-motivo="corrigido" style="accent-color:var(--green);width:16px;height:16px">
                            Corrigido
                        </label>
                        <label style="display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--text-3);cursor:pointer;white-space:nowrap">
                            <input type="checkbox" class="relatorio-cadastro-motivo" data-telefone="${c.telefone}" data-motivo="nao_aluno" style="accent-color:var(--amber);width:16px;height:16px">
                            Não é aluno
                        </label>
                    </div>
                `;
            }).join('')
            : '<p style="color:var(--text-3);text-align:center;padding:1.5rem">Nenhum cadastro incompleto pendente. 🎉</p>';
    } catch (e) {
        relatorioSemCadastroLista.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:1.5rem">Erro ao carregar.</p>';
    }
}

relatorioSemCadastroLista?.addEventListener('change', async (e) => {
    const chk = e.target.closest('.relatorio-cadastro-motivo');
    if (!chk) return;
    if (!chk.checked) return; // aqui não tem estado intermediário pra desmarcar — a linha já some no primeiro clique
    const linha = chk.closest('.contato-row');
    await marcarRelatorioDispensa('sem_cadastro', chk.dataset.telefone, chk.dataset.motivo, true);
    linha.remove();
    showToast('Marcado', '', 'success', 2000);
});

relatorioSemCadastroLista?.addEventListener('click', async (e) => {
    const nomeEl = e.target.closest('.relatorio-sem-cadastro-nome');
    if (!nomeEl) return;
    if (todosContatos.length === 0) await loadContatos();
    abrirEditarContato(nomeEl.dataset.telefone);
});

// =====================================
// RELATÓRIO — CONTRATOS SEM ASSINAR
// =====================================
// Guarda a última lista carregada de cada consultora — o botão "Exportar pra
// Disparo" usa esse cache em vez de buscar de novo, já que a lista acabou de
// ser exibida na tela de qualquer forma.
const contratosSemAssinarCache = { juliana: [], isadora: [] };

function contratosLinhaHtml(c) {
    return `
        <div class="contato-row" data-id="${c.id}" style="display:flex;align-items:center;gap:.8rem;padding:.6rem .7rem;border-radius:8px">
            <div style="flex:1;min-width:0">
                <div class="contratos-linha-nome" style="font-size:.88rem;color:var(--text-1);font-weight:500">${c.nome}</div>
                <div style="font-size:.75rem;color:var(--text-3)">Matrícula ${c.matricula}${c.telefone ? ` · ${c.telefone}` : ' · sem telefone no relatório'}</div>
            </div>
            <label style="display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--text-3);cursor:pointer;white-space:nowrap">
                <input type="checkbox" class="contratos-assinado-check" data-id="${c.id}" style="accent-color:var(--green);width:16px;height:16px">
                Assinado
            </label>
            <button type="button" class="btn-danger btn-contratos-excluir-linha" data-id="${c.id}" style="padding:.3rem .5rem;font-size:.72rem" title="Tira esse contato da lista sem marcar como assinado">🗑️</button>
        </div>
    `;
}

async function loadContratosSemAssinar(consultora) {
    const lista = document.getElementById(`contratos-lista-${consultora}`);
    const contador = document.getElementById(`contratos-count-${consultora}`);
    if (!lista) return;
    try {
        const res = await fetch(`/api/relatorio/contratos-sem-assinar?consultora=${consultora}`);
        const dados = await res.json();
        contratosSemAssinarCache[consultora] = dados;
        if (contador) contador.textContent = dados.length ? `(${dados.length} pendente${dados.length > 1 ? 's' : ''})` : '';
        lista.innerHTML = dados.length
            ? dados.map(contratosLinhaHtml).join('')
            : '<p style="color:var(--text-3);text-align:center;padding:1.5rem">Nenhum contrato pendente. 🎉</p>';
    } catch (e) {
        lista.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:1.5rem">Erro ao carregar.</p>';
    }
}

document.querySelectorAll('.btn-contratos-importar').forEach(btn => {
    btn.addEventListener('click', async () => {
        const consultora = btn.dataset.consultora;
        const input = document.getElementById(`contratos-url-${consultora}`);
        const url = (input?.value || '').trim();
        if (!url) {
            showToast('Cole o link', 'Cole o link do relatório em PDF antes de importar.', 'error');
            return;
        }
        const textoOriginal = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ Importando...';
        try {
            const res = await fetch('/api/relatorio/contratos-sem-assinar/importar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ consultora, url })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Erro ao importar lista');
            if (input) input.value = '';
            await loadContratosSemAssinar(consultora);
            const avisoSemTelefone = data.sem_telefone > 0 ? ` (${data.sem_telefone} sem telefone legível no PDF)` : '';
            showToast('Lista importada!', `${data.total_no_pdf} contato(s) no relatório${avisoSemTelefone}.`, 'success', 4000);
        } catch (err) {
            showToast('Erro ao importar', err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = textoOriginal;
        }
    });
});

document.querySelectorAll('[id^="contratos-lista-"]').forEach(lista => {
    lista.addEventListener('change', async (e) => {
        const chk = e.target.closest('.contratos-assinado-check');
        if (!chk) return;
        const linha = chk.closest('.contato-row');
        const consultora = lista.id.replace('contratos-lista-', '');
        // Marcar como assinado tira o aluno da lista na hora e não tem
        // "desmarcar" na tela — pedir confirmação evita perder um contato da
        // lista por um clique errado (ex: clicando rápido demais numa lista longa).
        if (!chk.checked) return;
        const nomeAluno = linha.querySelector('.contratos-linha-nome')?.textContent || 'esse aluno';
        if (!confirm(`Marcar "${nomeAluno}" como assinado? Ele sai da lista de pendentes.`)) {
            chk.checked = false;
            return;
        }
        try {
            await fetch(`/api/relatorio/contratos-sem-assinar/${chk.dataset.id}/assinado`, { method: 'POST' });
            linha.remove();
            contratosSemAssinarCache[consultora] = contratosSemAssinarCache[consultora].filter(c => String(c.id) !== chk.dataset.id);
            const contador = document.getElementById(`contratos-count-${consultora}`);
            const restantes = contratosSemAssinarCache[consultora].length;
            if (contador) contador.textContent = restantes ? `(${restantes} pendente${restantes > 1 ? 's' : ''})` : '';
            if (restantes === 0) loadContratosSemAssinar(consultora);
            showToast('Assinado!', '', 'success', 2000);
        } catch (err) {
            chk.checked = false;
            showToast('Erro', 'Não foi possível marcar como assinado.', 'error');
        }
    });

    lista.addEventListener('click', async (e) => {
        const btn = e.target.closest('.btn-contratos-excluir-linha');
        if (!btn) return;
        const linha = btn.closest('.contato-row');
        const consultora = lista.id.replace('contratos-lista-', '');
        const nomeAluno = linha.querySelector('.contratos-linha-nome')?.textContent || 'esse contato';
        if (!confirm(`Tirar "${nomeAluno}" da lista? Isso NÃO marca como assinado — só remove esse contato (ex: entrou errado na importação).`)) return;
        try {
            await fetch(`/api/relatorio/contratos-sem-assinar/${btn.dataset.id}`, { method: 'DELETE' });
            linha.remove();
            contratosSemAssinarCache[consultora] = contratosSemAssinarCache[consultora].filter(c => String(c.id) !== btn.dataset.id);
            const contador = document.getElementById(`contratos-count-${consultora}`);
            const restantes = contratosSemAssinarCache[consultora].length;
            if (contador) contador.textContent = restantes ? `(${restantes} pendente${restantes > 1 ? 's' : ''})` : '';
            if (restantes === 0) loadContratosSemAssinar(consultora);
            showToast('Removido da lista', '', 'success', 2000);
        } catch (err) {
            showToast('Erro', 'Não foi possível remover esse contato.', 'error');
        }
    });
});

document.querySelectorAll('.btn-contratos-limpar').forEach(btn => {
    btn.addEventListener('click', async () => {
        const consultora = btn.dataset.consultora;
        const total = (contratosSemAssinarCache[consultora] || []).length;
        if (!confirm(`Apagar a lista INTEIRA da ${consultora === 'juliana' ? 'Juliana' : 'Isadora'} (${total} pendente${total !== 1 ? 's' : ''})? Isso NÃO marca ninguém como assinado — é só pra recomeçar do zero (ex: lista de teste). Não tem como desfazer.`)) return;
        try {
            await fetch(`/api/relatorio/contratos-sem-assinar?consultora=${consultora}`, { method: 'DELETE' });
            await loadContratosSemAssinar(consultora);
            showToast('Lista limpa!', '', 'success', 2500);
        } catch (err) {
            showToast('Erro', 'Não foi possível limpar a lista.', 'error');
        }
    });
});

document.querySelectorAll('.btn-contratos-exportar').forEach(btn => {
    btn.addEventListener('click', () => {
        const consultora = btn.dataset.consultora;
        const contatos = contratosSemAssinarCache[consultora] || [];
        const telefones = contatos.filter(c => c.telefone).map(c => c.telefone);
        if (telefones.length === 0) {
            showToast('Nada pra exportar', 'Nenhum contato pendente com telefone legível.', 'error');
            return;
        }
        // Muda pra tela de Disparos primeiro — o próprio clique no menu já limpa
        // o formulário (resetarFormularioDisparo), então só preenche o campo de
        // números DEPOIS de disparar esse clique, senão a limpeza apaga o que
        // acabamos de colocar.
        document.querySelector('.nav-btn[data-target="disparos-section"]')?.click();
        const broadcastNumerosEl = document.getElementById('broadcast-numeros');
        if (broadcastNumerosEl) broadcastNumerosEl.value = telefones.join('\n');
        const semTelefone = contatos.length - telefones.length;
        showToast(
            'Números exportados!',
            `${telefones.length} número(s) inserido(s) no Disparo${semTelefone > 0 ? ` (${semTelefone} sem telefone ficaram de fora)` : ''}. Agora escolha a mensagem.`,
            'success', 4500
        );
        document.getElementById('broadcast-mensagem-personalizada')?.focus();
    });
});

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
    const telefoneDigitado = (editarContatoTelefone?.value || '').trim();
    if (!nome) { showToast('Nome obrigatório', 'Digite um nome para o contato.', 'error'); return; }
    if (!telefoneDigitado) { showToast('WhatsApp obrigatório', 'Informe o número com DDD.', 'error'); return; }
    try {
        const res = await fetch(`/api/contatos/${encodeURIComponent(contatoEditandoTelefone)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, matricula, data_nascimento, telefone: telefoneDigitado })
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
const novoContatoMatricula = document.getElementById('novo-contato-matricula');
const novoContatoNascimento = document.getElementById('novo-contato-nascimento');
const novoContatoEtiqueta = document.getElementById('novo-contato-etiqueta');
const btnNovoContatoSalvar = document.getElementById('btn-novo-contato-salvar');

async function abrirModalNovoContato() {
    if (novoContatoNome) novoContatoNome.value = '';
    if (novoContatoTelefone) novoContatoTelefone.value = '';
    if (novoContatoMatricula) novoContatoMatricula.value = '';
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
    const matricula = (novoContatoMatricula?.value || '').trim() || null;
    const data_nascimento = (novoContatoNascimento?.value || '').trim() || null;
    const etiqueta_id = novoContatoEtiqueta?.value;
    if (!nome) { showToast('Nome obrigatório', 'Digite o nome do contato.', 'error'); return; }
    if (!telefone) { showToast('Telefone obrigatório', 'Digite o telefone com DDD.', 'error'); return; }
    btnNovoContatoSalvar.disabled = true;
    try {
        const res = await fetch('/api/contatos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, telefone, matricula, data_nascimento, etiqueta_id: etiqueta_id ? Number(etiqueta_id) : null })
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

// A seleção só limpa sozinha quando um disparo TERMINA (resetarFormularioDisparo,
// ver broadcast_done) — se o disparo anterior ainda está rodando (ex: intervalo
// "Muito Longo" levando horas) e o usuário quer montar uma lista nova, os
// contatos do disparo anterior continuavam marcados, misturados com os novos.
// Esse botão dá um jeito manual de começar do zero a qualquer momento.
document.getElementById('btn-limpar-selecao')?.addEventListener('click', () => {
    if (contatosSelecionados.size === 0) return;
    contatosSelecionados.clear();
    renderContatos();
    showToast('Seleção limpa', '', 'success', 2000);
});

// =====================================
// IMPORTAR LISTA DE TRANSMISSÃO (matrícula/nome -> telefone)
// =====================================
const btnImportarListaTransmissao = document.getElementById('btn-importar-lista-transmissao');
const modalImportarListaTransmissao = document.getElementById('modal-importar-lista-transmissao-overlay');
const importListaValores = document.getElementById('import-lista-valores');
const importListaResultado = document.getElementById('import-lista-resultado');
const btnImportarListaResolver = document.getElementById('btn-importar-lista-transmissao-resolver');

btnImportarListaTransmissao?.addEventListener('click', () => {
    if (importListaValores) importListaValores.value = '';
    if (importListaResultado) { importListaResultado.style.display = 'none'; importListaResultado.innerHTML = ''; }
    modalImportarListaTransmissao?.classList.add('open');
});
document.getElementById('modal-importar-lista-transmissao-fechar')?.addEventListener('click', () => {
    modalImportarListaTransmissao?.classList.remove('open');
});

btnImportarListaResolver?.addEventListener('click', async () => {
    const tipo = document.querySelector('input[name="import-lista-tipo"]:checked')?.value || 'matricula';
    const valores = (importListaValores?.value || '').split('\n').map(v => v.trim()).filter(Boolean);
    if (valores.length === 0) {
        showToast('Lista vazia', 'Cole ao menos uma matrícula ou nome.', 'error');
        return;
    }
    btnImportarListaResolver.disabled = true;
    btnImportarListaResolver.textContent = '⏳ Buscando...';
    try {
        const res = await fetch('/api/contatos/resolver-lista', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tipo, valores })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao resolver lista');

        data.encontrados.forEach(c => contatosSelecionados.add(c.telefone));
        const broadcastNumerosEl = document.getElementById('broadcast-numeros');
        if (broadcastNumerosEl) broadcastNumerosEl.value = Array.from(contatosSelecionados).join('\n');
        renderContatos();
        atualizarContadorContatos();

        if (importListaResultado) {
            const partes = [`✅ ${data.encontrados.length} encontrado(s) e já selecionado(s) pro disparo.`];
            if (data.nao_encontrados.length > 0) {
                partes.push(`⚠️ ${data.nao_encontrados.length} não encontrado(s): ${data.nao_encontrados.join(', ')}`);
            }
            if (data.ambiguos.length > 0) {
                const listaAmbiguos = data.ambiguos.map(a => `"${a.valor}" (${a.opcoes.length} contatos com esse nome — resolva pela busca manual abaixo)`).join('; ');
                partes.push(`🔀 ${data.ambiguos.length} ambíguo(s), não selecionado(s) sozinho(s): ${listaAmbiguos}`);
            }
            importListaResultado.innerHTML = partes.join('<br><br>');
            importListaResultado.style.display = 'block';
        }
        showToast('Lista resolvida!', `${data.encontrados.length} contato(s) adicionado(s) à seleção.`, 'success', 5000);
    } catch (err) {
        showToast('Erro', err.message, 'error');
    } finally {
        btnImportarListaResolver.disabled = false;
        btnImportarListaResolver.textContent = '🔎 Buscar e Selecionar';
    }
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
const disparoDetalheLista = document.getElementById('disparo-detalhe-lista');
const disparoFilaStatus = document.getElementById('disparo-fila-status');
const progressStatClicaveis = document.querySelectorAll('.progress-stat-clickable');
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

// ---- Seletor de Mensagem Personalizada (preenche o campo de texto) ----
const broadcastMensagemSelect = document.getElementById('broadcast-mensagem-personalizada');
const broadcastMensagemAviso = document.getElementById('broadcast-mensagem-personalizada-aviso');
const broadcastMensagem = document.getElementById('broadcast-mensagem');
let mensagensPersonalizadasParaDisparo = [];

async function carregarMensagensPersonalizadasParaDisparo() {
    if (!broadcastMensagemSelect) return;
    try {
        const res = await fetch('/api/mensagens-personalizadas');
        mensagensPersonalizadasParaDisparo = await res.json();
        broadcastMensagemSelect.innerHTML = '<option value="">✏️ Escrever manualmente...</option>' +
            mensagensPersonalizadasParaDisparo.map(m => `<option value="${m.id}">${m.nome}</option>`).join('');
    } catch (e) {
        console.error('Erro ao carregar mensagens personalizadas pra disparo', e);
    }
}

broadcastMensagemSelect?.addEventListener('change', () => {
    const id = Number(broadcastMensagemSelect.value);
    if (broadcastMensagemAviso) broadcastMensagemAviso.style.display = 'none';
    if (!id) return;
    const m = mensagensPersonalizadasParaDisparo.find(x => x.id === id);
    if (!m) return;
    if (broadcastMensagem) broadcastMensagem.value = m.texto || '';
    if (m.media_path && broadcastMensagemAviso) broadcastMensagemAviso.style.display = 'block';
});

// =====================================
// NÚMEROS DE ENVIO (POOL DE DISPARO) + ROTEAMENTO POR CAMPANHA
// =====================================
const disparoNumerosLista = document.getElementById('disparo-numeros-lista');
const disparoNumeroNomeInput = document.getElementById('disparo-numero-nome');
const btnDisparoNumeroAdicionar = document.getElementById('btn-disparo-numero-adicionar');
const disparoRoteamentoLista = document.getElementById('disparo-roteamento-lista');
const modalDisparoNumeroQr = document.getElementById('modal-disparo-numero-qr-overlay');
const disparoNumeroQrTitulo = document.getElementById('modal-disparo-numero-qr-titulo');
const disparoNumeroQrIdInput = document.getElementById('disparo-numero-qr-id');
const disparoNumeroQrImagem = document.getElementById('disparo-numero-qr-imagem');
const disparoNumeroPairingTelefone = document.getElementById('disparo-numero-pairing-telefone');
const btnDisparoNumeroPairing = document.getElementById('btn-disparo-numero-pairing');
const disparoNumeroPairingResultado = document.getElementById('disparo-numero-pairing-resultado');

let disparoNumerosCache = [];
let disparoRoteamentoCache = {};

const DISPARO_NUMERO_STATUS_LABEL = {
    dormant: { texto: 'Não conectado', cor: 'var(--text-3)' },
    initializing: { texto: 'Conectando...', cor: 'var(--amber)' },
    qr: { texto: 'Aguardando QR', cor: 'var(--amber)' },
    connected: { texto: 'Online', cor: 'var(--green)' },
    disconnected: { texto: 'Desconectado', cor: 'var(--red)' },
};

function renderDisparoNumerosLista() {
    if (!disparoNumerosLista) return;
    if (disparoNumerosCache.length === 0) {
        disparoNumerosLista.innerHTML = '<p style="color:var(--text-3);font-size:.82rem;text-align:center;padding:1rem">Nenhum número de envio cadastrado ainda.</p>';
        return;
    }
    disparoNumerosLista.innerHTML = disparoNumerosCache.map(n => {
        const statusInfo = DISPARO_NUMERO_STATUS_LABEL[n.status] || DISPARO_NUMERO_STATUS_LABEL.dormant;
        const podeConectar = n.status === 'dormant' || n.status === 'disconnected';
        const mostrarQr = n.status === 'qr' && n.qrDataUrl;
        const podeDesconectar = n.status === 'connected';
        return `
            <div class="disparo-numero-row" data-id="${n.id}" style="display:flex;align-items:center;gap:.7rem;padding:.6rem;background:rgba(255,255,255,0.03);border-radius:8px;flex-wrap:wrap">
                <div style="flex:1;min-width:140px">
                    <div style="font-size:.88rem;color:var(--text-1);font-weight:500">${n.nome}</div>
                    <div style="font-size:.75rem;color:${statusInfo.cor}">● ${statusInfo.texto}${n.numeroConectado ? ` (${n.numeroConectado})` : ''}</div>
                </div>
                ${podeConectar ? `<button type="button" class="btn-secondary btn-disparo-numero-conectar" data-id="${n.id}" data-nome="${n.nome}" style="padding:.4rem .7rem;font-size:.75rem">📲 Conectar</button>` : ''}
                ${mostrarQr ? `<button type="button" class="btn-secondary btn-disparo-numero-pairing" data-id="${n.id}" data-nome="${n.nome}" style="padding:.4rem .7rem;font-size:.75rem">🔢 Usar código (sem QR)</button>` : ''}
                ${podeDesconectar ? `<button type="button" class="btn-secondary btn-disparo-numero-desconectar" data-id="${n.id}" style="padding:.4rem .7rem;font-size:.75rem">⏸️ Desconectar</button>` : ''}
                <button type="button" class="btn-danger btn-disparo-numero-remover" data-id="${n.id}" data-nome="${n.nome}" style="padding:.4rem .6rem;font-size:.75rem" title="Remover de vez">🗑️</button>
                ${mostrarQr ? `
                <div style="width:100%;display:flex;flex-direction:column;align-items:center;gap:.4rem;padding:.8rem;background:rgba(0,0,0,0.2);border-radius:8px">
                    <div style="font-size:.8rem;color:var(--text-2)">📲 Escaneie com o WhatsApp (Aparelhos conectados)</div>
                    <img src="${n.qrDataUrl}" alt="QR Code" style="max-width:220px;width:100%">
                </div>` : ''}
            </div>
        `;
    }).join('');
}

async function loadDisparoNumeros() {
    if (!disparoNumerosLista) return;
    try {
        const res = await fetch('/api/disparo-numeros');
        disparoNumerosCache = await res.json();
        renderDisparoNumerosLista();
        renderDisparoRoteamentoLista();
    } catch (e) {
        console.error('Erro ao carregar números de envio', e);
    }
}

async function loadDisparoRoteamento() {
    if (!disparoRoteamentoLista) return;
    try {
        const res = await fetch('/api/disparo-roteamento');
        disparoRoteamentoCache = await res.json();
        renderDisparoRoteamentoLista();
    } catch (e) {
        console.error('Erro ao carregar roteamento de disparo', e);
    }
}

function renderDisparoRoteamentoLista() {
    if (!disparoRoteamentoLista) return;
    if (disparoNumerosCache.length === 0) {
        disparoRoteamentoLista.innerHTML = '<p style="color:var(--text-3);font-size:.82rem;text-align:center;padding:1rem">Cadastre pelo menos um número de envio pra configurar o roteamento.</p>';
        return;
    }
    disparoRoteamentoLista.innerHTML = Object.entries(CAMPANHAS_INFO).map(([chave, info]) => {
        const selecionados = disparoRoteamentoCache[chave] || [];
        return `
            <div class="disparo-roteamento-row" data-campanha="${chave}" style="display:flex;align-items:center;gap:.8rem;flex-wrap:wrap;padding:.5rem 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                <span style="min-width:180px;font-size:.85rem;color:var(--text-1)">${info.icon} ${info.label}</span>
                <div style="display:flex;gap:.8rem;flex-wrap:wrap">
                    ${disparoNumerosCache.map(n => `
                        <label style="display:flex;align-items:center;gap:.3rem;cursor:pointer;font-size:.8rem;color:var(--text-2)">
                            <input type="checkbox" class="disparo-roteamento-check" data-campanha="${chave}" data-numero-id="${n.id}" ${selecionados.includes(n.id) ? 'checked' : ''} style="accent-color:var(--green)">
                            ${n.nome}
                        </label>
                    `).join('')}
                </div>
            </div>
        `;
    }).join('');
}

disparoRoteamentoLista?.addEventListener('change', async (e) => {
    const check = e.target.closest('.disparo-roteamento-check');
    if (!check) return;
    const campanha = check.dataset.campanha;
    const row = check.closest('.disparo-roteamento-row');
    const idsMarcados = [...row.querySelectorAll('.disparo-roteamento-check:checked')].map(c => Number(c.dataset.numeroId));
    disparoRoteamentoCache[campanha] = idsMarcados;
    try {
        await fetch(`/api/disparo-roteamento/${campanha}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ numeros_ids: idsMarcados }),
        });
    } catch (err) {
        showToast('Erro', 'Não foi possível salvar o roteamento.', 'error');
    }
});

btnDisparoNumeroAdicionar?.addEventListener('click', async () => {
    const nome = (disparoNumeroNomeInput?.value || '').trim();
    if (!nome) { showToast('Erro', 'Digite um nome pro número.', 'error'); return; }
    try {
        const res = await fetch('/api/disparo-numeros', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao adicionar número');
        if (disparoNumeroNomeInput) disparoNumeroNomeInput.value = '';
        await loadDisparoNumeros();
        showToast('Número adicionado!', 'Clique em "Conectar" pra escanear o QR Code.', 'success');
    } catch (e) {
        showToast('Erro', e.message, 'error');
    }
});

function abrirModalDisparoNumeroQr(id, nome, qrDataUrlExistente = null) {
    if (disparoNumeroQrIdInput) disparoNumeroQrIdInput.value = id;
    if (disparoNumeroQrTitulo) disparoNumeroQrTitulo.textContent = `📲 Conectar — ${nome}`;
    if (disparoNumeroQrImagem) {
        disparoNumeroQrImagem.innerHTML = qrDataUrlExistente
            ? `<img src="${qrDataUrlExistente}" alt="QR Code" style="max-width:220px">`
            : '<span style="color:var(--text-3);font-size:.85rem">⏳ Gerando QR Code...</span>';
    }
    if (disparoNumeroPairingResultado) disparoNumeroPairingResultado.textContent = '';
    if (disparoNumeroPairingTelefone) disparoNumeroPairingTelefone.value = '';
    modalDisparoNumeroQr?.classList.add('open');
}

document.getElementById('modal-disparo-numero-qr-fechar')?.addEventListener('click', () => modalDisparoNumeroQr?.classList.remove('open'));
modalDisparoNumeroQr?.addEventListener('click', (e) => { if (e.target === modalDisparoNumeroQr) modalDisparoNumeroQr.classList.remove('open'); });

disparoNumerosLista?.addEventListener('click', async (e) => {
    const btnConectar = e.target.closest('.btn-disparo-numero-conectar');
    const btnPairing = e.target.closest('.btn-disparo-numero-pairing');
    const btnDesconectar = e.target.closest('.btn-disparo-numero-desconectar');
    const btnRemover = e.target.closest('.btn-disparo-numero-remover');

    if (btnConectar) {
        const id = btnConectar.dataset.id;
        abrirModalDisparoNumeroQr(id, btnConectar.dataset.nome);
        try { await fetch(`/api/disparo-numeros/${id}/conectar`, { method: 'POST' }); }
        catch (err) { showToast('Erro', 'Não foi possível iniciar a conexão.', 'error'); }
        return;
    }
    if (btnPairing) {
        // QR já aparece direto na linha — esse botão é só a alternativa de
        // código manual (sem precisar escanear), pra quem não consegue usar
        // a câmera nesse momento.
        const id = btnPairing.dataset.id;
        const entry = disparoNumerosCache.find(n => n.id == id);
        abrirModalDisparoNumeroQr(id, btnPairing.dataset.nome, entry?.qrDataUrl);
        return;
    }
    if (btnDesconectar) {
        const id = btnDesconectar.dataset.id;
        try {
            await fetch(`/api/disparo-numeros/${id}/desconectar`, { method: 'POST' });
            showToast('Número desconectado', '', 'info', 3000);
            await loadDisparoNumeros();
        } catch (err) {
            showToast('Erro', 'Não foi possível desconectar.', 'error');
        }
        return;
    }
    if (btnRemover) {
        const id = btnRemover.dataset.id;
        const nome = btnRemover.dataset.nome;
        if (!confirm(`Remover o número "${nome}" de vez? Vai precisar escanear o QR de novo se você quiser adicioná-lo outra vez.`)) return;
        try {
            await fetch(`/api/disparo-numeros/${id}`, { method: 'DELETE' });
            await loadDisparoNumeros();
            showToast('Número removido', '', 'info', 3000);
        } catch (err) {
            showToast('Erro', 'Não foi possível remover o número.', 'error');
        }
    }
});

btnDisparoNumeroPairing?.addEventListener('click', async () => {
    const id = disparoNumeroQrIdInput?.value;
    const telefone = (disparoNumeroPairingTelefone?.value || '').trim();
    if (!telefone) { showToast('Erro', 'Informe o número com DDD.', 'error'); return; }
    try {
        const res = await fetch(`/api/disparo-numeros/${id}/pairing-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telefone }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao gerar código');
        if (disparoNumeroPairingResultado) disparoNumeroPairingResultado.textContent = data.code;
    } catch (e) {
        showToast('Erro', e.message, 'error');
    }
});

socket.on('pool_qr', ({ dbId, qrDataUrl }) => {
    const entry = disparoNumerosCache.find(n => n.id === dbId);
    if (entry) { entry.status = 'qr'; entry.qrDataUrl = qrDataUrl; renderDisparoNumerosLista(); }
    if (disparoNumeroQrIdInput?.value == dbId && disparoNumeroQrImagem) {
        disparoNumeroQrImagem.innerHTML = `<img src="${qrDataUrl}" alt="QR Code" style="max-width:220px">`;
    }
});

socket.on('pool_ready', ({ dbId, numero }) => {
    const entry = disparoNumerosCache.find(n => n.id === dbId);
    if (entry) { entry.status = 'connected'; entry.numeroConectado = numero; renderDisparoNumerosLista(); }
    if (disparoNumeroQrIdInput?.value == dbId) {
        modalDisparoNumeroQr?.classList.remove('open');
        showToast('Número conectado!', numero ? `WhatsApp ${numero} pronto pra disparar.` : '', 'success');
    }
});

socket.on('pool_disconnected', ({ dbId }) => {
    const entry = disparoNumerosCache.find(n => n.id === dbId);
    if (entry) { entry.status = 'disconnected'; renderDisparoNumerosLista(); }
});

socket.on('pool_list_updated', () => loadDisparoNumeros());

// Limpa só números/mensagem/mídia — usado tanto depois que um disparo
// termina quanto logo que um novo é enfileirado (ver btnDisparar), pra não
// deixar o campo com o texto de uma lista que já foi capturada.
function limparCamposFormularioDisparo() {
    const broadcastNumerosEl = document.getElementById('broadcast-numeros');
    if (broadcastNumerosEl) broadcastNumerosEl.value = '';
    if (broadcastMensagem) broadcastMensagem.value = '';
    if (broadcastMensagemSelect) broadcastMensagemSelect.value = '';
    if (broadcastMensagemAviso) broadcastMensagemAviso.style.display = 'none';
    if (broadcastFile) broadcastFile.value = '';
    if (broadcastFileName) broadcastFileName.textContent = '';
    broadcastUpload?.classList.remove('has-file');
}

// Limpa números/mensagem/mídia depois de um disparo concluir — sem isso, a
// lista e o texto do disparo anterior ficavam ali, e era fácil clicar
// "Iniciar Disparo" de novo sem querer reenviar pra mesma lista. Intervalo
// entre envios (velocidade) NÃO reseta — é preferência do usuário, não
// conteúdo do disparo em si.
function resetarFormularioDisparo() {
    limparCamposFormularioDisparo();
    // Limpa também a seleção da Lista de Contatos — sem isso, contatos
    // marcados pra um disparo continuavam "selecionados" por baixo dos panos
    // (mesmo já fora da busca atual) e entravam de novo, somados aos novos,
    // na próxima vez que "Usar selecionados no disparo" fosse clicado.
    contatosSelecionados.clear();
    renderContatos();
    filtroDisparoDetalheAtivo = null;
    progressStatClicaveis.forEach(el => el.classList.remove('active'));
    if (disparoDetalheLista) { disparoDetalheLista.classList.add('hidden'); disparoDetalheLista.innerHTML = ''; }
}

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
        // "Iniciar Disparo" continua visível (e vira "Enfileirar") mesmo com
        // um disparo rodando — clicar nele agora entra na fila em vez de
        // travar/recusar, e começa sozinho quando este terminar.
        if (btnDisparar) btnDisparar.textContent = '➕ Enfileirar Novo Disparo';
        if (btnParar)    btnParar.style.display = 'inline-flex';
    }
    // Se o painel de detalhe já está aberto, atualiza a lista junto — assim
    // dá pra acompanhar quem foi entrando em Enviados/Falhas em tempo real,
    // sem precisar clicar de novo a cada mensagem enviada.
    if (filtroDisparoDetalheAtivo) renderDisparoDetalhe(filtroDisparoDetalheAtivo);
}

// Sincroniza os botões/status ao (re)entrar na tela — sem isso, um reload
// no meio de um disparo mostrava "Iniciar Disparo" (estado padrão do HTML)
// mesmo com um disparo de verdade rodando no servidor, só se corrigindo
// sozinho no próximo evento de progresso (que pode demorar minutos com
// velocidade "Muito Longo").
async function sincronizarEstadoDisparo() {
    try {
        const res = await fetch('/api/broadcast/status');
        const p = await res.json();
        if (p.running) {
            updateProgressUI(p);
        } else if (btnDisparar) {
            btnDisparar.textContent = '🚀 Iniciar Disparo';
        }
        if (disparoFilaStatus) {
            if (p.filaTamanho > 0) {
                disparoFilaStatus.textContent = `📋 ${p.filaTamanho} disparo${p.filaTamanho !== 1 ? 's' : ''} na fila — começa${p.filaTamanho !== 1 ? 'm' : ''} automaticamente assim que o atual terminar.`;
                disparoFilaStatus.classList.remove('hidden');
            } else {
                disparoFilaStatus.classList.add('hidden');
            }
        }
    } catch (e) {
        console.error('Erro ao sincronizar estado do disparo', e);
    }
}

// Início de um disparo — o primeiro clicado na hora, ou o próximo da fila
// começando sozinho assim que o anterior termina (ver iniciarBroadcast no
// backend). Reseta o painel de detalhe pra refletir a lista NOVA que
// começou a rodar, não a anterior.
socket.on('broadcast_started', () => {
    filtroDisparoDetalheAtivo = null;
    progressStatClicaveis.forEach(el => el.classList.remove('active'));
    if (disparoDetalheLista) { disparoDetalheLista.classList.add('hidden'); disparoDetalheLista.innerHTML = ''; }
});

socket.on('broadcast_fila_atualizada', ({ tamanho }) => {
    if (!disparoFilaStatus) return;
    if (tamanho > 0) {
        disparoFilaStatus.textContent = `📋 ${tamanho} disparo${tamanho !== 1 ? 's' : ''} na fila — começa${tamanho !== 1 ? 'm' : ''} automaticamente assim que o atual terminar.`;
        disparoFilaStatus.classList.remove('hidden');
    } else {
        disparoFilaStatus.classList.add('hidden');
    }
});

socket.on('broadcast_progress', updateProgressUI);

socket.on('broadcast_done', (p) => {
    broadcastStatusMsg.textContent = `✅ Concluído! ${p.sent} enviados, ${p.failed} falhas.`;
    broadcastStatusMsg.style.color = 'var(--green)';
    if (btnDisparar) { btnDisparar.style.display = 'inline-flex'; btnDisparar.textContent = '🚀 Iniciar Disparo'; }
    if (btnParar)    btnParar.style.display = 'none';
    showToast('Disparo Finalizado!', `${p.sent} enviados com sucesso.`, 'success', 6000);
    addActivity('🚀', `Disparo concluído: ${p.sent} msgs`, new Date().toLocaleString('pt-BR'));
    if (filtroDisparoDetalheAtivo) renderDisparoDetalhe(filtroDisparoDetalheAtivo);
    resetarFormularioDisparo();
});

// ---- Relatório detalhado (nome + telefone) do disparo mais recente —
// clicando em Total/Enviados/Falhas na tela, filtra a lista de acordo. ----
let filtroDisparoDetalheAtivo = null;

async function renderDisparoDetalhe(filtro) {
    if (!disparoDetalheLista) return;
    disparoDetalheLista.classList.remove('hidden');
    disparoDetalheLista.innerHTML = '<p style="color:var(--text-3);font-size:.78rem;text-align:center;padding:.5rem 0">Carregando...</p>';
    try {
        const res = await fetch(`/api/broadcast/detalhe?filtro=${filtro}`);
        const linhas = await res.json();
        disparoDetalheLista.innerHTML = linhas.length
            ? linhas.map(l => `
                <div style="display:flex;justify-content:space-between;gap:.6rem;font-size:.78rem;padding:.3rem 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                    <span style="color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${l.nome || l.telefone}${l.nome ? ` <span style="color:var(--text-3)">· ${l.telefone}</span>` : ''}${l.numeroEnvio ? ` <span style="color:var(--text-3)">· via ${l.numeroEnvio}</span>` : ''}</span>
                    <span style="color:${l.sucesso ? 'var(--green)' : 'var(--red)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;flex-shrink:0;margin-left:.6rem">${l.sucesso ? '✅ Enviado' : `❌ ${l.erro || 'Falhou'}`}</span>
                </div>
            `).join('')
            : '<p style="color:var(--text-3);font-size:.78rem;text-align:center;padding:.5rem 0">Nada por aqui ainda.</p>';
    } catch (e) {
        disparoDetalheLista.innerHTML = '<p style="color:var(--text-3);font-size:.78rem;text-align:center;padding:.5rem 0">Erro ao carregar detalhes.</p>';
    }
}

progressStatClicaveis.forEach(el => {
    el.addEventListener('click', () => {
        const filtro = el.dataset.filtro;
        if (filtroDisparoDetalheAtivo === filtro) {
            filtroDisparoDetalheAtivo = null;
            progressStatClicaveis.forEach(e => e.classList.remove('active'));
            disparoDetalheLista?.classList.add('hidden');
            return;
        }
        filtroDisparoDetalheAtivo = filtro;
        progressStatClicaveis.forEach(e => e.classList.toggle('active', e === el));
        renderDisparoDetalhe(filtro);
    });
});

// ---- Histórico de Disparos por dia — diferente do bloco acima (que só
// mostra a campanha mais recente), aqui consulta /api/broadcast/historico
// pra qualquer data escolhida, inclusive dias anteriores. ----
const disparoHistoricoData    = document.getElementById('disparo-historico-data');
const disparoHistoricoLista   = document.getElementById('disparo-historico-lista');
const disparoHistoricoResumo  = document.getElementById('disparo-historico-resumo');
const disparoHistoricoTotal   = document.getElementById('disparo-historico-total');
const disparoHistoricoSucesso = document.getElementById('disparo-historico-sucesso');
const disparoHistoricoFalhas  = document.getElementById('disparo-historico-falhas');
const btnDisparoHistoricoBuscar = document.getElementById('btn-disparo-historico-buscar');
const btnDisparoHistoricoReenviarTodos = document.getElementById('btn-disparo-historico-reenviar-todos');
const broadcastNumerosTextarea = document.getElementById('broadcast-numeros');

if (disparoHistoricoData && !disparoHistoricoData.value) {
    const hoje = new Date();
    const yyyy = hoje.getFullYear();
    const mm = String(hoje.getMonth() + 1).padStart(2, '0');
    const dd = String(hoje.getDate()).padStart(2, '0');
    disparoHistoricoData.value = `${yyyy}-${mm}-${dd}`;
}

// Guarda a última lista carregada — "Reenviar Todos" e o scroll-to-top usam
// isso, sem precisar buscar de novo no servidor.
let ultimoHistoricoDisparoItens = [];

// "Reenviar" não manda de novo sozinho — a tabela disparo_envios_log não guarda
// o texto/mídia originalmente enviado (só telefone e sucesso/erro), então não
// tem como replicar a mensagem automaticamente. Em vez disso, joga o(s)
// número(s) escolhido(s) no campo de Disparo pra você revisar a mensagem e
// clicar "Iniciar Disparo" normalmente — reaproveita a fila/throttle que já existe.
function reenviarNumerosNoFormulario(telefones) {
    if (!broadcastNumerosTextarea || !telefones.length) return;
    const existentes = broadcastNumerosTextarea.value.split('\n').map(n => n.trim()).filter(Boolean);
    const novos = telefones.filter(t => !existentes.includes(t));
    broadcastNumerosTextarea.value = [...existentes, ...novos].join('\n');
    document.querySelector('.disparo-config-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    broadcastNumerosTextarea.focus();
    showToast('Número(s) prontos pra reenviar', 'Revise a mensagem e clique em "Iniciar Disparo".', 'info', 4000);
}

async function carregarDisparoHistorico() {
    if (!disparoHistoricoLista || !disparoHistoricoData?.value) return;
    disparoHistoricoLista.innerHTML = '<p style="color:var(--text-3);font-size:.78rem;text-align:center;padding:.5rem 0">Carregando...</p>';
    disparoHistoricoResumo?.classList.add('hidden');
    try {
        const res = await fetch(`/api/broadcast/historico?data=${disparoHistoricoData.value}`);
        const dados = await res.json();
        if (!res.ok) throw new Error(dados.error || 'Erro ao buscar histórico.');

        ultimoHistoricoDisparoItens = dados.itens;

        if (disparoHistoricoResumo) {
            disparoHistoricoResumo.classList.remove('hidden');
            disparoHistoricoTotal.textContent = dados.total;
            disparoHistoricoSucesso.textContent = dados.sucesso;
            disparoHistoricoFalhas.textContent = dados.falhas;
        }

        disparoHistoricoLista.innerHTML = dados.itens.length
            ? dados.itens.map(l => `
                <div style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;font-size:.78rem;padding:.3rem 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                    <span style="color:var(--text-3);white-space:nowrap;flex-shrink:0">${new Date(l.enviadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                    <span style="color:var(--text-1);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:.6rem">
                        ${l.nome || l.telefone}${l.nome ? ` <span style="color:var(--text-3)">· ${l.telefone}</span>` : ''}${l.numeroEnvio ? ` <span style="color:var(--text-3)">· via ${l.numeroEnvio}</span>` : ''}
                        ${l.descricao ? `<br><span style="color:var(--text-3);font-style:italic">💬 ${l.descricao}</span>` : ''}
                    </span>
                    <span style="color:${l.sucesso ? 'var(--green)' : 'var(--red)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;flex-shrink:0;margin-left:.6rem">${l.sucesso ? '✅ Enviado' : `❌ ${l.erro || 'Falhou'}`}</span>
                    <button type="button" class="btn-secondary btn-disparo-historico-reenviar" data-telefone="${l.telefone}" style="padding:.2rem .5rem;font-size:.7rem;flex-shrink:0" title="Colocar esse número no campo de Disparo">🔁</button>
                </div>
            `).join('')
            : '<p style="color:var(--text-3);font-size:.78rem;text-align:center;padding:.5rem 0">Nenhum disparo nesse dia.</p>';
    } catch (e) {
        disparoHistoricoLista.innerHTML = '<p style="color:var(--text-3);font-size:.78rem;text-align:center;padding:.5rem 0">Erro ao carregar histórico.</p>';
    }
}

btnDisparoHistoricoBuscar?.addEventListener('click', carregarDisparoHistorico);

disparoHistoricoLista?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-disparo-historico-reenviar');
    if (!btn) return;
    reenviarNumerosNoFormulario([btn.dataset.telefone]);
});

btnDisparoHistoricoReenviarTodos?.addEventListener('click', () => {
    reenviarNumerosNoFormulario(ultimoHistoricoDisparoItens.map(l => l.telefone));
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
    // Categoria da Mensagem Personalizada selecionada (se houver) — decide o
    // roteamento por número de envio configurado em "Roteamento por Campanha".
    const mensagemSelecionadaId = Number(broadcastMensagemSelect?.value);
    const mensagemSelecionada = mensagemSelecionadaId ? mensagensPersonalizadasParaDisparo.find(m => m.id === mensagemSelecionadaId) : null;
    if (mensagemSelecionada?.categoria) formData.append('categoria', mensagemSelecionada.categoria);
    // Nome da Mensagem Personalizada usada (se veio de lá) — vira a "descrição"
    // no Histórico de Disparos, já que o texto/mídia enviado não fica salvo lá.
    if (mensagemSelecionada?.nome) formData.append('descricao', mensagemSelecionada.nome);
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

    // Já tinha um disparo rodando — este entrou na fila em vez de começar na
    // hora. Só limpa os campos (a lista já foi capturada pro backend) sem
    // mexer no painel de progresso/detalhe, que ainda é do disparo atual.
    if (data.queued) {
        limparCamposFormularioDisparo();
        showToast('Disparo enfileirado!', `Vai começar automaticamente assim que o disparo atual terminar (posição ${data.posicaoNaFila} na fila).`, 'success', 6000);
        return;
    }

    broadcastStatusMsg.textContent = `🚀 Iniciando disparo para ${data.total} números...`;
    broadcastStatusMsg.style.color = 'var(--green)';
    showToast('Disparo Iniciado!', `${data.total} números na fila`, 'success');
    filtroDisparoDetalheAtivo = null;
    progressStatClicaveis.forEach(el => el.classList.remove('active'));
    if (disparoDetalheLista) { disparoDetalheLista.classList.add('hidden'); disparoDetalheLista.innerHTML = ''; }
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
    let activeTab = 'aberta'; // 'aberta' | 'fechada'
    let notifMuted = localStorage.getItem('chatNotifMuted') === '1';

    // ---- Corrida entre loadHistory (busca no banco) e mensagem ao vivo ----
    // loadHistory busca o histórico no banco; se uma mensagem nova chegar via
    // socket ENQUANTO essa busca ainda está no ar, a busca não inclui ela
    // (rodou antes dela existir) — quando a resposta chega e substitui
    // chatMessages.innerHTML, a bolha que acabou de ser adicionada ao vivo
    // some da tela, mesmo a mensagem estando salva certinho no banco. Guarda
    // um token pra descartar respostas desatualizadas, e um buffer pra
    // reaplicar por cima qualquer mensagem ao vivo que chegou durante a busca.
    let cargaHistoricoToken = 0;
    let cargaHistoricoTelefone = null;
    let mensagensAoVivoDuranteCarga = [];

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
    const btnChatVoltarMobile = document.getElementById('btn-chat-voltar-mobile');
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

        // Filtra e ordena: por data decrescente. Abertas/Fechadas são
        // mutuamente exclusivas pelo status — assumida por humano ou não,
        // enquanto não estiver finalizada ela é "Abertas".
        const filtered = [...contacts.values()].filter(c => {
            const status = c.status || 'aberta';
            const aba = status === 'fechada' ? 'fechada' : 'aberta';
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
                    <div class="chat-contact-name">${c.canal === 'instagram' ? '📷 ' : ''}${c.nome}${c.matricula ? ` <span class="chat-contact-matricula">#${c.matricula}</span>` : ''}${c.assumida_humano ? ' 🙋' : ''}</div>
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

        // Em tela de celular, a lista e a janela do chat ocupam a tela
        // inteira uma de cada vez — abrir um contato troca pra janela do chat.
        document.querySelector('.chat-layout')?.classList.add('mobile-chat-open');

        // Atualiza header
        if (chatHeader)         chatHeader.style.display = 'flex';
        if (chatPlaceholder)    chatPlaceholder.style.display = 'none';
        if (chatHeaderAvatar)   chatHeaderAvatar.textContent = avatarLetter(nome);
        if (chatHeaderName)     chatHeaderName.innerHTML = `${c?.canal === 'instagram' ? '📷 ' : ''}${escapeHtml(nome)}${c?.matricula ? ` <span class="chat-contact-matricula">#${escapeHtml(c.matricula)}</span>` : ''}`;
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

    btnChatVoltarMobile?.addEventListener('click', () => {
        document.querySelector('.chat-layout')?.classList.remove('mobile-chat-open');
    });

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
            document.querySelector('.chat-layout')?.classList.remove('mobile-chat-open');
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
        const meuToken = ++cargaHistoricoToken;
        cargaHistoricoTelefone = telefone;
        mensagensAoVivoDuranteCarga = [];
        try {
            const res  = await fetch(`/api/conversas/${encodeURIComponent(telefone)}?limit=150`);
            const msgs = await res.json();

            // Se o usuário já trocou de conversa (ou reabriu essa de novo)
            // enquanto esse fetch estava no ar, essa resposta é velha —
            // aplicar ela agora sobrescreveria a conversa certa com dado
            // desatualizado.
            if (meuToken !== cargaHistoricoToken || activePhone !== telefone) return;

            chatMessages.innerHTML = '';
            if (!msgs || msgs.length === 0) {
                chatMessages.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:3rem;font-size:.82rem">Nenhuma mensagem ainda.</div>';
            } else {
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
            }

            // Qualquer mensagem que chegou AO VIVO (via socket) enquanto esse
            // fetch estava em andamento não está em "msgs" (a busca no banco
            // rodou antes dela existir) — reaplica por cima, na ordem que
            // chegaram, senão ela simplesmente some da tela (o dado tá salvo
            // certinho no banco, só não aparece nessa conversa aberta).
            mensagensAoVivoDuranteCarga.forEach(m => {
                const dateSep = formatDataSep(m.ts);
                const seps = chatMessages.querySelectorAll('.chat-date-sep');
                const lastSep = seps[seps.length - 1];
                if (!lastSep || lastSep.textContent !== dateSep) {
                    const sep = document.createElement('div');
                    sep.className = 'chat-date-sep';
                    sep.textContent = dateSep;
                    chatMessages.appendChild(sep);
                }
                appendBubble(m);
            });

            // Scrolla para o fundo
            chatMessages.scrollTop = chatMessages.scrollHeight;
        } catch(err) {
            if (meuToken !== cargaHistoricoToken || activePhone !== telefone) return;
            chatMessages.innerHTML = '<div style="text-align:center;color:var(--red);padding:2rem;font-size:.82rem">Erro ao carregar histórico.</div>';
        } finally {
            if (cargaHistoricoTelefone === telefone) cargaHistoricoTelefone = null;
        }
    }

    // ---- Cria e adiciona uma bolha de mensagem ----
    // ---- Monta o HTML do "corpo" da bolha (texto, mídia ou selo do tipo) ----
    // Extraído do appendBubble pra poder ser reaproveitado quando a mídia
    // termina de baixar DEPOIS da bolha já estar na tela (ver evento
    // 'midia_atualizada') — nesse caso só troca esse pedaço, sem recriar a bolha.
    function buildBubbleBodyHtml(m) {
        const icon = tipoIcon(m.tipo);
        // Áudio transcrito e outras mídias com legenda têm texto real além do
        // tipo — mostra o selo do tipo E o texto, não só o selo (senão a
        // transcrição do áudio nunca aparece na bolha).
        const temTextoReal = m.texto && !/^\[.*\]$/.test(m.texto.trim());
        const legendaHtml = temTextoReal ? `<div class="bubble-text">${escapeHtml(m.texto.replace(/^🎤\s*/, ''))}</div>` : '';

        if (m.media_path && m.tipo === 'image') {
            // Clica na miniatura e abre a imagem em tamanho real numa aba nova.
            return `<a href="${m.media_path}" target="_blank" rel="noopener" class="bubble-media-link" title="Abrir imagem"><img src="${m.media_path}" class="bubble-image" alt="Imagem" loading="lazy"></a>${legendaHtml}`;
        } else if (m.media_path && m.tipo === 'video') {
            return `<video src="${m.media_path}" class="bubble-video" controls preload="metadata"></video>${legendaHtml}`;
        } else if (m.media_path) {
            // Documento, figurinha etc. — abre/baixa numa aba nova.
            const rotulo = m.tipo === 'document' ? 'Abrir documento' : 'Abrir anexo';
            const emojiLink = m.tipo === 'sticker' ? '🎭' : m.tipo === 'document' ? '📄' : '📎';
            return `<a href="${m.media_path}" target="_blank" rel="noopener" class="bubble-doc-link">${emojiLink} ${rotulo}</a>${legendaHtml}`;
        } else if (icon && temTextoReal) {
            return `<span class="bubble-type-badge">${icon}</span>${legendaHtml}`;
        } else if (icon) {
            return `<span class="bubble-type-badge">${icon}</span>`;
        }
        return `<div class="bubble-text">${escapeHtml(m.texto || '')}</div>`;
    }

    function appendBubble(m, scroll = false) {
        if (!chatMessages) return;
        const wrap = document.createElement('div');
        wrap.className = `chat-bubble-wrap ${m.direcao}`;
        if (m.id) wrap.dataset.msgId = m.id;

        const isManual = m.manual === true;
        const bubbleClass = `chat-bubble ${m.direcao}${isManual ? ' manual' : ''}`;

        let senderLabel = '';
        if (m.direcao === 'out') {
            senderLabel = isManual
                ? `<div class="bubble-sender manual">👤 Operador</div>`
                : `<div class="bubble-sender">🤖 Bot</div>`;
        }

        // Editar/excluir só faz sentido pra mensagem que a gente mandou —
        // editar só pra texto puro (mídia não dá pra editar a legenda depois
        // pelo WhatsApp), excluir vale pra qualquer tipo enviado.
        let acoesHtml = '';
        if (m.direcao === 'out' && m.id) {
            const btnEditar = m.tipo === 'text' ? `<button type="button" class="bubble-btn-editar" title="Editar mensagem">✏️</button>` : '';
            acoesHtml = `<div class="bubble-acoes">${btnEditar}<button type="button" class="bubble-btn-excluir" title="Excluir mensagem">🗑️</button></div>`;
        }

        wrap.innerHTML = `
            <div class="${bubbleClass}">
                ${senderLabel}
                ${buildBubbleBodyHtml(m)}
                <div class="bubble-time">${formatHoraCompleta(m.ts)}</div>
                ${acoesHtml}
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
            const filtrados = todos.filter(c => !termo || c.nome.toLowerCase().includes(termo) || c.telefone.includes(termo.replace(/\D/g, '') || termo) || (c.matricula || '').toLowerCase().includes(termo)).slice(0, 50);

            let html = filtrados.map(c => `
                <div class="chat-contact-item nova-conversa-item" data-telefone="${c.telefone}" style="border-radius:8px;cursor:pointer">
                    <div class="chat-contact-avatar">${avatarLetter(c.nome)}</div>
                    <div class="chat-contact-body">
                        <div class="chat-contact-name">${c.nome}</div>
                        <div class="chat-contact-preview">${c.telefone}${c.matricula ? ` · Matrícula ${c.matricula}` : ''}</div>
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

        // Editar/excluir mensagem enviada — botões só aparecem nas bolhas
        // "out" (ver appendBubble), delegado num único listener no container.
        chatMessages?.addEventListener('click', async (e) => {
            const bolha = e.target.closest('.chat-bubble-wrap');
            if (!bolha || !activePhone) return;
            const msgId = bolha.dataset.msgId;
            if (!msgId) return;

            if (e.target.closest('.bubble-btn-excluir')) {
                if (!confirm('Excluir essa mensagem? Se ainda estiver dentro da janela que o WhatsApp permite, ela some pra todo mundo na conversa, não só daqui.')) return;
                try {
                    const res = await fetch(`/api/conversas/${encodeURIComponent(activePhone)}/mensagem/${msgId}`, { method: 'DELETE' });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Erro ao excluir');
                    bolha.remove();
                    showToast(data.excluida_no_whatsapp ? 'Excluída!' : 'Removida daqui', data.excluida_no_whatsapp ? '' : 'Não deu pra excluir no WhatsApp (mensagem antiga), mas saiu do histórico.', 'success', 3000);
                } catch (err) {
                    showToast('Erro ao excluir', err.message, 'error');
                }
                return;
            }

            if (e.target.closest('.bubble-btn-editar')) {
                const corpo = bolha.querySelector('.bubble-text');
                const textoAtual = corpo ? corpo.textContent : '';
                const novoTexto = prompt('Editar mensagem:', textoAtual);
                if (novoTexto === null || !novoTexto.trim() || novoTexto.trim() === textoAtual.trim()) return;
                try {
                    const res = await fetch(`/api/conversas/${encodeURIComponent(activePhone)}/mensagem/${msgId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ texto: novoTexto.trim() })
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Erro ao editar');
                    if (corpo) corpo.textContent = novoTexto.trim();
                    showToast('Mensagem editada!', '', 'success', 2500);
                } catch (err) {
                    showToast('Erro ao editar', err.message, 'error');
                }
            }
        });

        // Abas Abertas / Fechadas
        function selecionarAba(aba) {
            activeTab = aba;
            [tabAbertas, tabFechadas].forEach(btn => btn?.classList.remove('active'));
            ({ aberta: tabAbertas, fechada: tabFechadas }[aba])?.classList.add('active');
            renderContactList();
        }
        tabAbertas?.addEventListener('click', () => selecionarAba('aberta'));
        tabFechadas?.addEventListener('click', () => selecionarAba('fechada'));

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
                document.querySelector('.chat-layout')?.classList.remove('mobile-chat-open');
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

            // Se um loadHistory pra esse mesmo contato ainda está no ar, essa
            // mensagem chegou depois da busca no banco ter rodado — quando a
            // resposta (desatualizada) chegar e limpar chatMessages, ela
            // precisa ser reaplicada por cima, senão some da tela (ver loadHistory).
            if (cargaHistoricoTelefone === data.telefone) mensagensAoVivoDuranteCarga.push(data);

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

        // Mídia (imagem/documento/vídeo) baixa em background depois da
        // mensagem já ter aparecido na tela — quando termina, troca só o
        // corpo da bolha já exibida pelo anexo de verdade (sem recarregar a
        // conversa inteira). Se a conversa não estiver aberta, não tem bolha
        // pra atualizar agora — na próxima vez que abrir, loadHistory já
        // busca o media_path certo do banco.
        socket.on('midia_atualizada', (data) => {
            if (activePhone !== data.telefone) return;
            const bolha = chatMessages?.querySelector(`.chat-bubble-wrap[data-msg-id="${data.id}"]`);
            const corpo = bolha?.querySelector('.chat-bubble');
            if (!corpo) return;
            const tempoHtml = corpo.querySelector('.bubble-time')?.outerHTML || '';
            const senderHtml = corpo.querySelector('.bubble-sender')?.outerHTML || '';
            const acoesHtml = corpo.querySelector('.bubble-acoes')?.outerHTML || '';
            corpo.innerHTML = `${senderHtml}${buildBubbleBodyHtml(data)}${tempoHtml}${acoesHtml}`;
        });

        // Mensagem editada/excluída em OUTRA aba/sessão — reflete aqui também.
        socket.on('mensagem_editada', ({ id, telefone, texto }) => {
            if (activePhone !== telefone) return;
            const bolha = chatMessages?.querySelector(`.chat-bubble-wrap[data-msg-id="${id}"]`);
            const corpo = bolha?.querySelector('.bubble-text');
            if (corpo) corpo.textContent = texto;
        });

        socket.on('mensagem_excluida', ({ id, telefone }) => {
            if (activePhone !== telefone) return;
            chatMessages?.querySelector(`.chat-bubble-wrap[data-msg-id="${id}"]`)?.remove();
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

// Inicializa o ConversationManager — sistema abre direto em "Bate Papo ao
// Vivo" (ver nav-btn "active" e page-section sem "hidden" em index.html),
// então já carrega a lista de conversas na hora, sem esperar um clique.
CM.init();
CM.onEnterSection();


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
// INTEGRAÇÃO — CRM PACTO (ATIVOS x EX-ALUNO)
// =====================================
const btnPactoAtivosImportar = document.getElementById('btn-pacto-ativos-importar');
const btnPactoAtivosAtualizar = document.getElementById('btn-pacto-ativos-atualizar');
const pactoAtivosResultado = document.getElementById('pacto-ativos-resultado');

function renderPactoAtivosProgress(p) {
    if (!pactoAtivosResultado) return;
    const pct = p.total ? Math.round((p.verificadas / p.total) * 100) : 0;
    pactoAtivosResultado.innerHTML = `
        <div style="margin-bottom:.5rem">⏳ Verificando matrículas... ${p.verificadas}/${p.total} (${pct}%)</div>
        <div style="background:rgba(255,255,255,0.08);border-radius:50px;height:8px;overflow:hidden;margin-bottom:.8rem">
            <div style="background:var(--green);height:100%;width:${pct}%;transition:width .3s"></div>
        </div>
        <div>🟢 Ativos encontrados: <strong style="color:var(--text-1)">${p.ativos}</strong></div>
        <div>📵 Sem telefone: <strong style="color:var(--text-1)">${p.sem_telefone}</strong></div>
    `;
}

btnPactoAtivosImportar?.addEventListener('click', async () => {
    btnPactoAtivosImportar.disabled = true;
    btnPactoAtivosImportar.textContent = '⏳ Importando...';
    try {
        const res = await fetch('/api/pacto/ativos/importar', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao iniciar varredura');
        renderPactoAtivosProgress({ total: data.total, verificadas: 0, ativos: 0, sem_telefone: 0 });
    } catch (e) {
        showToast('Erro', e.message, 'error');
        btnPactoAtivosImportar.disabled = false;
        btnPactoAtivosImportar.textContent = '📥 Importar Ativos';
    }
});

socket.on('pacto_ativos_progress', renderPactoAtivosProgress);

socket.on('pacto_ativos_done', (p) => {
    if (btnPactoAtivosImportar) {
        btnPactoAtivosImportar.disabled = false;
        btnPactoAtivosImportar.textContent = '📥 Importar Ativos';
    }
    showToast('Varredura concluída!', `${p.ativos} alunos ativos encontrados. Clique em "Atualizar Contatos" pra aplicar as etiquetas.`, 'success', 7000);
});

btnPactoAtivosAtualizar?.addEventListener('click', async () => {
    btnPactoAtivosAtualizar.disabled = true;
    btnPactoAtivosAtualizar.textContent = '⏳ Atualizando...';
    try {
        const res = await fetch('/api/pacto/ativos/atualizar-contatos', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao atualizar contatos');
        showToast('Contatos atualizados!', `${data.ativos} marcados como Ativo, ${data.exAlunos} como Ex-Aluno.`, 'success', 7000);
        loadContatos();
    } catch (e) {
        showToast('Erro', e.message, 'error');
    } finally {
        btnPactoAtivosAtualizar.disabled = false;
        btnPactoAtivosAtualizar.textContent = '🏷️ Atualizar Contatos';
    }
});

// =====================================
// INTEGRAÇÃO — CRM PACTO (ATIVOS COM PARCELAS ATRASADAS)
// =====================================
const btnPactoInadimplentes = document.getElementById('btn-pacto-inadimplentes');
const btnPactoInadimplentesToggle = document.getElementById('btn-pacto-inadimplentes-toggle');
const pactoInadimplentesDetalhe = document.getElementById('pacto-inadimplentes-detalhe');
const pactoInadimplentesResultado = document.getElementById('pacto-inadimplentes-resultado');
const pactoInadimplentesUltimaAtualizacaoEl = document.getElementById('pacto-inadimplentes-ultima-atualizacao');

// Relatório detalhado (as 3 tabelas) começa recolhido — só o resumo (contagens)
// fica visível de cara, pra não ocupar a tela toda sem precisar.
btnPactoInadimplentesToggle?.addEventListener('click', () => {
    const aberto = pactoInadimplentesDetalhe?.classList.toggle('hidden') === false;
    btnPactoInadimplentesToggle.textContent = aberto ? '▲ Esconder relatório detalhado' : '▼ Ver relatório detalhado';
});

function formatarUltimaAtualizacaoPacto(iso) {
    if (!pactoInadimplentesUltimaAtualizacaoEl) return;
    if (!iso) { pactoInadimplentesUltimaAtualizacaoEl.textContent = ''; return; }
    const d = new Date(iso);
    if (isNaN(d)) { pactoInadimplentesUltimaAtualizacaoEl.textContent = ''; return; }
    const data = d.toLocaleDateString('pt-BR');
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    pactoInadimplentesUltimaAtualizacaoEl.textContent = `Última atualização: ${data} às ${hora}`;
}
// Duas tabelas alimentadas pelo MESMO dado (pacto_inadimplentes já guarda
// dias_atraso_mais_antiga) — só separa na hora de exibir, sem precisar de
// duas varreduras nem duas listas de verdade no banco.
const pactoInadimplentesLongoBody = document.getElementById('pacto-inadimplentes-lista-longo');
const pactoInadimplentesRecenteBody = document.getElementById('pacto-inadimplentes-lista-recente');
const LIMITE_DIAS_ATRASO_LONGO = 30;

function renderPactoInadimplentesProgress(p) {
    if (!pactoInadimplentesResultado) return;
    const pct = p.total ? Math.round((p.verificados / p.total) * 100) : 0;
    pactoInadimplentesResultado.innerHTML = `
        <div style="margin-bottom:.5rem">⏳ Verificando contatos... ${p.verificados}/${p.total} (${pct}%)</div>
        <div style="background:rgba(255,255,255,0.08);border-radius:50px;height:8px;overflow:hidden;margin-bottom:.8rem">
            <div style="background:var(--red);height:100%;width:${pct}%;transition:width .3s"></div>
        </div>
        <div>🔴 Inadimplentes encontrados até agora: <strong style="color:var(--text-1)">${p.inadimplentes || 0}</strong></div>
        <div>🟡 Parcelas atrasadas encontradas até agora: <strong style="color:var(--text-1)">${p.parcelasAtrasadas || 0}</strong></div>
        <div>🔵 Vencendo hoje encontrados até agora: <strong style="color:var(--text-1)">${p.vencemHoje || 0}</strong></div>
    `;
}

function formatarMoeda(valor) {
    return (valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarDataNascimento(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function linhaPactoInadimplente(i) {
    return `
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
    `;
}

async function carregarUltimaAtualizacaoPacto() {
    try {
        const res = await fetch('/api/pacto/inadimplentes/status');
        const status = await res.json();
        if (!status.running) formatarUltimaAtualizacaoPacto(status.ultima_atualizacao);
    } catch (e) { /* silencioso — não é crítico, só o texto informativo */ }
}

async function loadPactoInadimplentes() {
    if (!pactoInadimplentesLongoBody || !pactoInadimplentesRecenteBody) return;
    carregarUltimaAtualizacaoPacto();
    try {
        const res = await fetch('/api/pacto/inadimplentes');
        const lista = await res.json();
        const longos = lista.filter(i => i.dias_atraso_mais_antiga > LIMITE_DIAS_ATRASO_LONGO);
        const recentes = lista.filter(i => i.dias_atraso_mais_antiga <= LIMITE_DIAS_ATRASO_LONGO);

        pactoInadimplentesLongoBody.innerHTML = longos.length
            ? longos.map(linhaPactoInadimplente).join('')
            : '<tr><td colspan="6" style="padding:1.5rem;text-align:center;color:var(--text-3)">Nenhum inadimplente com mais de 30 dias de atraso.</td></tr>';

        pactoInadimplentesRecenteBody.innerHTML = recentes.length
            ? recentes.map(linhaPactoInadimplente).join('')
            : '<tr><td colspan="6" style="padding:1.5rem;text-align:center;color:var(--text-3)">Nenhum inadimplente com até 30 dias de atraso.</td></tr>';
    } catch (e) {
        const erro = '<tr><td colspan="6" style="padding:1.5rem;text-align:center;color:var(--text-3)">Erro ao carregar.</td></tr>';
        pactoInadimplentesLongoBody.innerHTML = erro;
        pactoInadimplentesRecenteBody.innerHTML = erro;
    }
}

async function excluirPactoInadimplente(telefone, nome) {
    if (!confirm(`Excluir "${nome}" da lista de inadimplentes e remover a etiqueta "Inadimplente"?`)) return;
    try {
        const res = await fetch(`/api/pacto/inadimplentes/${encodeURIComponent(telefone)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Falha ao excluir');
        showToast('Removido', '', 'success', 2000);
        loadPactoInadimplentes();
    } catch (err) {
        showToast('Erro', 'Não foi possível remover', 'error');
    }
}

[pactoInadimplentesLongoBody, pactoInadimplentesRecenteBody].forEach(tbody => {
    tbody?.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-excluir-inadimplente');
        if (!btn) return;
        excluirPactoInadimplente(btn.dataset.telefone, btn.dataset.nome);
    });
});

btnPactoInadimplentes?.addEventListener('click', async () => {
    btnPactoInadimplentes.disabled = true;
    btnPactoInadimplentes.textContent = '⏳ Atualizando...';
    try {
        const res = await fetch('/api/pacto/inadimplentes/atualizar', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao iniciar');
        renderPactoInadimplentesProgress({ total: 0, verificados: 0, inadimplentes: 0, parcelasAtrasadas: 0, vencemHoje: 0 });
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
    showToast('Atualização concluída!', `${p.inadimplentes || 0} inadimplente(s), ${p.parcelasAtrasadas || 0} com parcela atrasada, ${p.vencemHoje || 0} vencendo hoje.`, 'success', 6000);
    formatarUltimaAtualizacaoPacto(p.ultima_atualizacao);
    loadPactoInadimplentes();
    loadPactoVencemHoje();
});

// =====================================
// INTEGRAÇÃO — CRM PACTO (PARCELA VENCE HOJE)
// Lista alimentada pela MESMA varredura acima (pacto_inadimplentes_done) —
// não tem botão nem progresso próprios.
// =====================================
const pactoVencemHojeBody = document.getElementById('pacto-vencem-hoje-lista');

async function loadPactoVencemHoje() {
    if (!pactoVencemHojeBody) return;
    try {
        const res = await fetch('/api/pacto/vencem-hoje');
        const lista = await res.json();
        pactoVencemHojeBody.innerHTML = lista.length
            ? lista.map(i => `
                <tr>
                    <td>
                        <div style="font-weight:500;color:var(--text-1)">${i.nome || '-'}</div>
                        <div style="font-size:.75rem;color:var(--text-3)">${i.telefone}</div>
                    </td>
                    <td style="color:var(--text-2);font-size:.85rem">${i.matricula || '-'}</td>
                    <td style="text-align:right;color:var(--text-2)">${i.qtd_parcelas}</td>
                    <td style="text-align:right;color:#3b82f6;font-weight:600">${formatarMoeda(i.valor_total)}</td>
                    <td style="text-align:right">
                        <button type="button" class="btn-danger btn-excluir-vence-hoje" data-telefone="${i.telefone}" data-nome="${i.nome || i.telefone}" style="padding:.35rem .6rem;font-size:.75rem" title="Excluir da lista e remover a etiqueta Vence Hoje">🗑️</button>
                    </td>
                </tr>
            `).join('')
            : '<tr><td colspan="5" style="padding:1.5rem;text-align:center;color:var(--text-3)">Ninguém com parcela vencendo hoje.</td></tr>';
    } catch (e) {
        pactoVencemHojeBody.innerHTML = '<tr><td colspan="5" style="padding:1.5rem;text-align:center;color:var(--text-3)">Erro ao carregar.</td></tr>';
    }
}

pactoVencemHojeBody?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-excluir-vence-hoje');
    if (!btn) return;
    if (!confirm(`Excluir "${btn.dataset.nome}" da lista de "vence hoje" e remover a etiqueta?`)) return;
    try {
        const res = await fetch(`/api/pacto/vencem-hoje/${encodeURIComponent(btn.dataset.telefone)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Falha ao excluir');
        showToast('Removido', '', 'success', 2000);
        loadPactoVencemHoje();
    } catch (err) {
        showToast('Erro', 'Não foi possível remover', 'error');
    }
});

// =====================================
// INTEGRAÇÃO — AGENDA DE AVALIAÇÃO FÍSICA
// =====================================
const btnAgendaAvaliacao = document.getElementById('btn-agenda-avaliacao');
const btnAgendaAvaliacaoToggle = document.getElementById('btn-agenda-avaliacao-toggle');
const agendaAvaliacaoTabela = document.getElementById('agenda-avaliacao-tabela');
const agendaAvaliacaoResultado = document.getElementById('agenda-avaliacao-resultado');
const agendaAvaliacaoUltimaAtualizacaoEl = document.getElementById('agenda-avaliacao-ultima-atualizacao');
const agendaAvaliacaoBody = document.getElementById('agenda-avaliacao-lista');

// Lista de contatos começa recolhida — só o resumo (contagens) fica visível
// de cara, mesmo padrão do "Ver relatório detalhado" da Situação Financeira.
btnAgendaAvaliacaoToggle?.addEventListener('click', () => {
    const aberto = agendaAvaliacaoTabela?.classList.toggle('hidden') === false;
    btnAgendaAvaliacaoToggle.textContent = aberto ? '▲ Esconder contatos' : '▼ Ver contatos';
});
const modalEditarAgendaAvaliacaoOverlay = document.getElementById('modal-editar-agenda-avaliacao-overlay');
const editarAgendaAvaliacaoTelefone = document.getElementById('editar-agenda-avaliacao-telefone');
const editarAgendaAvaliacaoNome = document.getElementById('editar-agenda-avaliacao-nome');
const editarAgendaAvaliacaoMatricula = document.getElementById('editar-agenda-avaliacao-matricula');
const editarAgendaAvaliacaoHorario = document.getElementById('editar-agenda-avaliacao-horario');
const editarAgendaAvaliacaoProfessor = document.getElementById('editar-agenda-avaliacao-professor');
const btnEditarAgendaAvaliacaoSalvar = document.getElementById('btn-editar-agenda-avaliacao-salvar');
let agendaAvaliacaoEditandoId = null;

function fecharEditarAgendaAvaliacao() {
    agendaAvaliacaoEditandoId = null;
    modalEditarAgendaAvaliacaoOverlay?.classList.remove('open');
}
document.getElementById('modal-editar-agenda-avaliacao-fechar')?.addEventListener('click', fecharEditarAgendaAvaliacao);

btnEditarAgendaAvaliacaoSalvar?.addEventListener('click', async () => {
    if (!agendaAvaliacaoEditandoId) return;
    try {
        const res = await fetch(`/api/agenda-avaliacao/${encodeURIComponent(agendaAvaliacaoEditandoId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nome: editarAgendaAvaliacaoNome.value,
                matricula: editarAgendaAvaliacaoMatricula.value,
                horario: editarAgendaAvaliacaoHorario.value,
                professor: editarAgendaAvaliacaoProfessor.value,
                telefone: editarAgendaAvaliacaoTelefone.value,
            })
        });
        if (!res.ok) {
            const corpo = await res.json().catch(() => ({}));
            throw new Error(corpo.error || 'Falha ao salvar');
        }
        showToast('Salvo', '', 'success', 2000);
        fecharEditarAgendaAvaliacao();
        loadAgendaAvaliacao();
    } catch (err) {
        showToast('Erro', err.message || 'Não foi possível salvar', 'error');
    }
});

function formatarUltimaAtualizacaoAgenda(iso) {
    if (!agendaAvaliacaoUltimaAtualizacaoEl) return;
    if (!iso) { agendaAvaliacaoUltimaAtualizacaoEl.textContent = ''; return; }
    const d = new Date(iso);
    if (isNaN(d)) { agendaAvaliacaoUltimaAtualizacaoEl.textContent = ''; return; }
    const data = d.toLocaleDateString('pt-BR');
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    agendaAvaliacaoUltimaAtualizacaoEl.textContent = `Última atualização: ${data} às ${hora}`;
}

function renderAgendaAvaliacaoResultado(p) {
    if (!agendaAvaliacaoResultado) return;
    if (p.erro) {
        agendaAvaliacaoResultado.innerHTML = `<span style="color:var(--red)">❌ ${p.erro}</span>`;
        return;
    }
    agendaAvaliacaoResultado.innerHTML = `
        <div>📋 ${p.total} agendamento(s) hoje · 🏷️ ${p.encontrados} etiquetado(s)${p.sem_whatsapp ? ` · ⚠️ ${p.sem_whatsapp} sem contato correlacionado` : ''}</div>
    `;
}

async function carregarUltimaAtualizacaoAgenda() {
    try {
        const res = await fetch('/api/agenda-avaliacao/status');
        const status = await res.json();
        if (!status.running) {
            formatarUltimaAtualizacaoAgenda(status.ultima_atualizacao);
            if (status.total || status.erro) renderAgendaAvaliacaoResultado(status);
        }
    } catch (e) { /* silencioso — só o texto informativo */ }
}

async function loadAgendaAvaliacao() {
    if (!agendaAvaliacaoBody) return;
    carregarUltimaAtualizacaoAgenda();
    try {
        const res = await fetch('/api/agenda-avaliacao');
        const lista = await res.json();
        agendaAvaliacaoBody.innerHTML = lista.length
            ? lista.map(i => `
                <tr>
                    <td>
                        <div style="font-weight:500;color:var(--text-1)">${i.nome || '-'}</div>
                        <div style="font-size:.75rem;color:${i.telefone ? 'var(--text-3)' : 'var(--red)'}">${i.telefone || '⚠️ Matrícula não encontrada nos Contatos'}</div>
                    </td>
                    <td style="color:var(--text-2);font-size:.85rem">${i.matricula || '-'}</td>
                    <td style="color:var(--text-2);font-size:.85rem">${i.horario || '-'}</td>
                    <td style="color:var(--text-2);font-size:.85rem">${i.professor || '-'}</td>
                    <td style="text-align:right;white-space:nowrap">
                        <button type="button" class="btn-secondary btn-editar-agenda-avaliacao" data-appointment-id="${i.appointment_id}" data-telefone="${i.telefone || ''}" data-nome="${i.nome || ''}" data-matricula="${i.matricula || ''}" data-horario="${i.horario || ''}" data-professor="${i.professor || ''}" style="padding:.35rem .6rem;font-size:.75rem" title="Editar antes de disparar">✏️</button>
                        <button type="button" class="btn-danger btn-excluir-agenda-avaliacao" data-appointment-id="${i.appointment_id}" data-nome="${i.nome || i.telefone || 'esse agendamento'}" style="padding:.35rem .6rem;font-size:.75rem" title="Excluir da lista e remover a etiqueta Agendamento AF">🗑️</button>
                    </td>
                </tr>
            `).join('')
            : '<tr><td colspan="5" style="padding:1.5rem;text-align:center;color:var(--text-3)">Nenhuma avaliação agendada pra hoje.</td></tr>';
    } catch (e) {
        agendaAvaliacaoBody.innerHTML = '<tr><td colspan="5" style="padding:1.5rem;text-align:center;color:var(--text-3)">Erro ao carregar.</td></tr>';
    }
}

agendaAvaliacaoBody?.addEventListener('click', async (e) => {
    const btnEditar = e.target.closest('.btn-editar-agenda-avaliacao');
    if (btnEditar) {
        agendaAvaliacaoEditandoId = btnEditar.dataset.appointmentId;
        if (editarAgendaAvaliacaoTelefone) editarAgendaAvaliacaoTelefone.value = btnEditar.dataset.telefone || '';
        if (editarAgendaAvaliacaoNome) editarAgendaAvaliacaoNome.value = btnEditar.dataset.nome || '';
        if (editarAgendaAvaliacaoMatricula) editarAgendaAvaliacaoMatricula.value = btnEditar.dataset.matricula || '';
        if (editarAgendaAvaliacaoHorario) editarAgendaAvaliacaoHorario.value = btnEditar.dataset.horario || '';
        if (editarAgendaAvaliacaoProfessor) editarAgendaAvaliacaoProfessor.value = btnEditar.dataset.professor || '';
        modalEditarAgendaAvaliacaoOverlay?.classList.add('open');
        return;
    }

    const btn = e.target.closest('.btn-excluir-agenda-avaliacao');
    if (!btn) return;
    if (!confirm(`Excluir "${btn.dataset.nome}" da lista e remover a etiqueta "Agendamento AF"?`)) return;
    try {
        const res = await fetch(`/api/agenda-avaliacao/${encodeURIComponent(btn.dataset.appointmentId)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Falha ao excluir');
        showToast('Removido', '', 'success', 2000);
        loadAgendaAvaliacao();
    } catch (err) {
        showToast('Erro', 'Não foi possível remover', 'error');
    }
});

btnAgendaAvaliacao?.addEventListener('click', async () => {
    btnAgendaAvaliacao.disabled = true;
    btnAgendaAvaliacao.textContent = '⏳ Atualizando...';
    try {
        const res = await fetch('/api/agenda-avaliacao/atualizar', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao iniciar');
        if (agendaAvaliacaoResultado) agendaAvaliacaoResultado.innerHTML = '⏳ Buscando agenda do dia...';
    } catch (e) {
        showToast('Erro', e.message, 'error');
        btnAgendaAvaliacao.disabled = false;
        btnAgendaAvaliacao.textContent = '🔄 Atualizar Lista';
    }
});

socket.on('agenda_avaliacao_progress', (p) => {
    if (!p.running) return;
    if (agendaAvaliacaoResultado) agendaAvaliacaoResultado.innerHTML = '⏳ Buscando agenda do dia...';
});

socket.on('agenda_avaliacao_done', (p) => {
    if (btnAgendaAvaliacao) {
        btnAgendaAvaliacao.disabled = false;
        btnAgendaAvaliacao.textContent = '🔄 Atualizar Lista';
    }
    renderAgendaAvaliacaoResultado(p);
    formatarUltimaAtualizacaoAgenda(p.ultima_atualizacao);
    if (!p.erro) showToast('Agenda atualizada!', `${p.encontrados} aluno(s) etiquetado(s) com "Agendamento AF".`, 'success', 5000);
    loadAgendaAvaliacao();
});

// =====================================
// SORTEIO RESGATE EX-ALUNOS
// =====================================
const btnResgateExAlunosSortear = document.getElementById('btn-resgate-exalunos-sortear');
const btnResgateExAlunosToggle = document.getElementById('btn-resgate-exalunos-toggle');
const resgateExAlunosListaWrap = document.getElementById('resgate-exalunos-lista-wrap');
const resgateExAlunosListaBody = document.getElementById('resgate-exalunos-lista');
const resgateExAlunosResultado = document.getElementById('resgate-exalunos-resultado');
const resgateExAlunosUltimaExecucaoEl = document.getElementById('resgate-exalunos-ultima-execucao');
const resgateExAlunosQuantidadeInput = document.getElementById('resgate-exalunos-quantidade');
const resgateExAlunosDiasSemRepetirInput = document.getElementById('resgate-exalunos-dias-sem-repetir');
const btnResgateExAlunosSalvarConfig = document.getElementById('btn-resgate-exalunos-salvar-config');

btnResgateExAlunosToggle?.addEventListener('click', () => {
    if (!resgateExAlunosListaWrap) return;
    const aberto = resgateExAlunosListaWrap.style.display !== 'none';
    resgateExAlunosListaWrap.style.display = aberto ? 'none' : 'block';
    btnResgateExAlunosToggle.textContent = aberto ? '▼ Ver sorteados de hoje' : '▲ Esconder sorteados de hoje';
});

async function loadResgateExAlunosConfig() {
    try {
        const res = await fetch('/api/resgate-exalunos/config');
        const config = await res.json();
        if (resgateExAlunosQuantidadeInput) resgateExAlunosQuantidadeInput.value = config.quantidade;
        if (resgateExAlunosDiasSemRepetirInput) resgateExAlunosDiasSemRepetirInput.value = config.diasSemRepetir;
    } catch (e) {
        console.error('Erro ao carregar config do sorteio de resgate ex-alunos', e);
    }
}

btnResgateExAlunosSalvarConfig?.addEventListener('click', async () => {
    const quantidade = Number(resgateExAlunosQuantidadeInput?.value);
    const diasSemRepetir = Number(resgateExAlunosDiasSemRepetirInput?.value);
    try {
        const res = await fetch('/api/resgate-exalunos/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantidade, diasSemRepetir }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao salvar configuração');
        showToast('Configuração salva', '', 'success', 3000);
    } catch (e) {
        showToast('Erro', e.message, 'error');
    }
});

function formatarUltimaExecucaoResgateExAlunos(iso) {
    if (!resgateExAlunosUltimaExecucaoEl) return;
    if (!iso) { resgateExAlunosUltimaExecucaoEl.textContent = ''; return; }
    const d = new Date(iso);
    if (isNaN(d)) { resgateExAlunosUltimaExecucaoEl.textContent = ''; return; }
    const data = d.toLocaleDateString('pt-BR');
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    resgateExAlunosUltimaExecucaoEl.textContent = `Último sorteio: ${data} às ${hora}`;
}

function renderResgateExAlunosResultado(p) {
    if (!resgateExAlunosResultado) return;
    if (p.erro) {
        resgateExAlunosResultado.innerHTML = `⚠️ Erro no último sorteio: ${p.erro}`;
        return;
    }
    resgateExAlunosResultado.innerHTML = `<div>🎯 ${p.sorteados} aluno(s) sorteado(s) e etiquetado(s) com "Resgate Ex-Aluno".</div>`;
}

async function carregarStatusResgateExAlunos() {
    try {
        const res = await fetch('/api/resgate-exalunos/status');
        const status = await res.json();
        if (!status.running) {
            formatarUltimaExecucaoResgateExAlunos(status.ultima_execucao);
            if (status.total || status.erro) renderResgateExAlunosResultado(status);
        }
    } catch (e) { /* silencioso — só o texto informativo */ }
}

async function loadResgateExAlunosSorteados() {
    if (!resgateExAlunosListaBody) return;
    try {
        const res = await fetch('/api/resgate-exalunos/sorteados-hoje');
        const lista = await res.json();
        resgateExAlunosListaBody.innerHTML = lista.length
            ? lista.map(i => `
                <tr>
                    <td style="color:var(--text-1)">${i.nome || i.telefone || '-'}</td>
                    <td style="color:var(--text-2);font-size:.85rem">${i.matricula || '-'}</td>
                    <td style="color:var(--text-2);font-size:.85rem">${new Date(i.sorteado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="3" style="padding:1.5rem;text-align:center;color:var(--text-3)">Nenhum sorteio hoje ainda.</td></tr>';
    } catch (e) {
        resgateExAlunosListaBody.innerHTML = '<tr><td colspan="3" style="padding:1.5rem;text-align:center;color:var(--text-3)">Erro ao carregar.</td></tr>';
    }
}

function loadResgateExAlunos() {
    loadResgateExAlunosConfig();
    carregarStatusResgateExAlunos();
    loadResgateExAlunosSorteados();
}

btnResgateExAlunosSortear?.addEventListener('click', async () => {
    btnResgateExAlunosSortear.disabled = true;
    btnResgateExAlunosSortear.textContent = '⏳ Sorteando...';
    try {
        const res = await fetch('/api/resgate-exalunos/sortear', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao iniciar sorteio');
        if (resgateExAlunosResultado) resgateExAlunosResultado.innerHTML = '⏳ Sorteando ex-alunos...';
    } catch (e) {
        showToast('Erro', e.message, 'error');
        btnResgateExAlunosSortear.disabled = false;
        btnResgateExAlunosSortear.textContent = '🎲 Sortear Agora';
    }
});

socket.on('resgate_exalunos_progress', (p) => {
    if (!p.running) return;
    if (resgateExAlunosResultado) resgateExAlunosResultado.innerHTML = '⏳ Sorteando ex-alunos...';
});

socket.on('resgate_exalunos_done', (p) => {
    if (btnResgateExAlunosSortear) {
        btnResgateExAlunosSortear.disabled = false;
        btnResgateExAlunosSortear.textContent = '🎲 Sortear Agora';
    }
    renderResgateExAlunosResultado(p);
    formatarUltimaExecucaoResgateExAlunos(p.ultima_execucao);
    if (!p.erro) showToast('Sorteio concluído!', `${p.sorteados} aluno(s) etiquetado(s) com "Resgate Ex-Aluno".`, 'success', 5000);
    loadResgateExAlunosSorteados();
});

loadResgateExAlunos();

// =====================================
// PROGRAMAÇÃO DAS INTEGRAÇÕES (Importar Contatos, Situação Financeira, Agenda de Avaliação)
// =====================================
const INTEGRACAO_PROGRAMACAO_LABELS = {
    pacto_importar: 'Importar Contatos do Pacto',
    situacao_financeira: 'Situação Financeira',
    agenda_avaliacao: 'Agenda de Avaliação',
    pacto_ativos: 'Alunos Ativos x Ex-Aluno',
    resgate_exalunos: 'Sorteio Resgate Ex-Alunos',
};
let integracaoProgramacoes = {}; // chave -> { dias, horario, ativo }

const modalIntegracaoProgramacao = document.getElementById('modal-integracao-programacao-overlay');
const integracaoProgramacaoTitulo = document.getElementById('modal-integracao-programacao-titulo');
const integracaoProgramacaoChaveInput = document.getElementById('integracao-programacao-chave');
const integracaoProgramacaoDiasDiv = document.getElementById('integracao-programacao-dias');
const integracaoProgramacaoHorarioInput = document.getElementById('integracao-programacao-horario');
const btnIntegracaoProgramacaoSalvar = document.getElementById('btn-integracao-programacao-salvar');
const btnIntegracaoProgramacaoRemover = document.getElementById('btn-integracao-programacao-remover');
const modalIntegracaoProgramacaoFechar = document.getElementById('modal-integracao-programacao-fechar');

let integracaoProgramacaoDiasSelecionados = [1, 2, 3, 4, 5];

function renderIntegracaoProgramacaoDias() {
    if (!integracaoProgramacaoDiasDiv) return;
    integracaoProgramacaoDiasDiv.innerHTML = DIAS_SEMANA.map((label, d) => `
        <label style="display:flex;align-items:center;gap:.3rem;cursor:pointer;font-size:.82rem">
            <input type="checkbox" class="integracao-programacao-dia" data-dia="${d}" ${integracaoProgramacaoDiasSelecionados.includes(d) ? 'checked' : ''} style="accent-color:var(--green)"> ${label}
        </label>
    `).join('');
}

integracaoProgramacaoDiasDiv?.addEventListener('change', (e) => {
    if (!e.target.classList.contains('integracao-programacao-dia')) return;
    const dia = Number(e.target.dataset.dia);
    if (e.target.checked) { if (!integracaoProgramacaoDiasSelecionados.includes(dia)) integracaoProgramacaoDiasSelecionados.push(dia); }
    else integracaoProgramacaoDiasSelecionados = integracaoProgramacaoDiasSelecionados.filter(d => d !== dia);
});

function renderIntegracaoProgramacaoStatus() {
    document.querySelectorAll('.integracao-programacao-status').forEach(span => {
        const prog = integracaoProgramacoes[span.dataset.chave];
        if (!prog) { span.textContent = ''; return; }
        const diasTxt = prog.dias.length === 7 ? 'todos os dias' : [...prog.dias].sort().map(d => DIAS_SEMANA[d]).join(', ');
        span.textContent = `🗓️ Programado: ${diasTxt} às ${prog.horario}`;
    });
}

async function loadIntegracaoProgramacoes() {
    try {
        const res = await fetch('/api/integracoes/programacoes');
        const linhas = await res.json();
        integracaoProgramacoes = {};
        linhas.forEach(l => { integracaoProgramacoes[l.chave] = l; });
        renderIntegracaoProgramacaoStatus();
    } catch (e) {
        console.error('Erro ao carregar programações de integração', e);
    }
}
loadIntegracaoProgramacoes();

document.querySelectorAll('.btn-integracao-programar').forEach(btn => {
    btn.addEventListener('click', () => {
        const chave = btn.dataset.chave;
        const prog = integracaoProgramacoes[chave];
        if (integracaoProgramacaoTitulo) integracaoProgramacaoTitulo.textContent = `🗓️ Programação — ${INTEGRACAO_PROGRAMACAO_LABELS[chave] || chave}`;
        if (integracaoProgramacaoChaveInput) integracaoProgramacaoChaveInput.value = chave;
        if (integracaoProgramacaoHorarioInput) integracaoProgramacaoHorarioInput.value = prog?.horario || '06:00';
        integracaoProgramacaoDiasSelecionados = prog ? [...prog.dias] : [1, 2, 3, 4, 5];
        renderIntegracaoProgramacaoDias();
        if (btnIntegracaoProgramacaoRemover) btnIntegracaoProgramacaoRemover.style.display = prog ? 'inline-flex' : 'none';
        modalIntegracaoProgramacao?.classList.add('open');
    });
});

modalIntegracaoProgramacaoFechar?.addEventListener('click', () => modalIntegracaoProgramacao?.classList.remove('open'));
modalIntegracaoProgramacao?.addEventListener('click', (e) => { if (e.target === modalIntegracaoProgramacao) modalIntegracaoProgramacao.classList.remove('open'); });

btnIntegracaoProgramacaoSalvar?.addEventListener('click', async () => {
    const chave = integracaoProgramacaoChaveInput?.value;
    const horario = integracaoProgramacaoHorarioInput?.value || '';
    if (!chave) return;
    if (integracaoProgramacaoDiasSelecionados.length === 0) { showToast('Erro', 'Escolha pelo menos um dia da semana.', 'error'); return; }
    if (!horario) { showToast('Erro', 'Escolha um horário.', 'error'); return; }
    try {
        const res = await fetch(`/api/integracoes/programacoes/${chave}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dias: integracaoProgramacaoDiasSelecionados, horario }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao salvar programação');
        await loadIntegracaoProgramacoes();
        modalIntegracaoProgramacao?.classList.remove('open');
        showToast('Programação salva', `${INTEGRACAO_PROGRAMACAO_LABELS[chave] || chave} vai rodar sozinha nos dias/horário escolhidos.`, 'success', 4000);
    } catch (e) {
        showToast('Erro', e.message, 'error');
    }
});

btnIntegracaoProgramacaoRemover?.addEventListener('click', async () => {
    const chave = integracaoProgramacaoChaveInput?.value;
    if (!chave) return;
    if (!confirm('Remover a programação dessa integração? Ela só vai rodar quando você clicar manualmente.')) return;
    try {
        await fetch(`/api/integracoes/programacoes/${chave}`, { method: 'DELETE' });
        await loadIntegracaoProgramacoes();
        modalIntegracaoProgramacao?.classList.remove('open');
        showToast('Programação removida', '', 'info', 3000);
    } catch (e) {
        showToast('Erro', 'Não foi possível remover a programação', 'error');
    }
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
                <button type="button" class="btn-secondary btn-ver-contatos-automacao" data-id="${a.id}" data-nome="${a.nome}" style="padding:.5rem .7rem;font-size:.82rem" title="Ver quem tem a etiqueta e o status de cada um (já importado ou aguardando)">👥 Ver Contatos</button>
                <button type="button" class="btn-secondary btn-importar-lista-automacao" data-id="${a.id}" data-nome="${a.nome}" style="padding:.5rem .7rem;font-size:.82rem" title="Sincroniza a fila com quem tem a etiqueta agora — quem perdeu a etiqueta sai, quem ganhou entra">📥 Importar Lista</button>
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

async function importarListaParaAutomacao(automacaoId) {
    const res = await fetch(`/api/automacoes/${automacaoId}/importar-contatos`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao importar');
    return data;
}

async function sincronizarListaAutomacao(btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Importando...';
    try {
        const data = await importarListaParaAutomacao(btn.dataset.id);
        const partes = [];
        if (data.importados > 0) partes.push(`${data.importados} novo(s)`);
        if (data.removidos > 0) partes.push(`${data.removidos} removido(s) (não tem mais a etiqueta)`);
        showToast('Lista sincronizada!', partes.length ? partes.join(' · ') : 'Nenhuma mudança — fila já batia com a etiqueta.', 'success', 4000);
    } catch (err) {
        showToast('Erro', err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '📥 Importar Lista';
    }
}

automacoesLista?.addEventListener('click', async (e) => {
    const btnConfig = e.target.closest('.btn-config-etapas');
    if (btnConfig) { abrirConfigurarEtapas(btnConfig.dataset.id, btnConfig.dataset.nome); return; }

    const btnVerContatos = e.target.closest('.btn-ver-contatos-automacao');
    if (btnVerContatos) { abrirContatosComEtiqueta(btnVerContatos.dataset.id, btnVerContatos.dataset.nome); return; }

    const btnImportarLista = e.target.closest('.btn-importar-lista-automacao');
    if (btnImportarLista) { await sincronizarListaAutomacao(btnImportarLista); return; }

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

socket.on('contratos_sem_assinar_atualizados', ({ consultora }) => {
    if (document.getElementById('relatorio-section') && !document.getElementById('relatorio-section').classList.contains('hidden')) {
        loadContratosSemAssinar(consultora);
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
// Qual "Campanha Rápida" está filtrando a lista agora (null = mostra todas).
// Setado ao clicar num botão de campanha (ex: Aniversariantes) em qualquer tela.
let filtroCategoriaMensagens = null;

const CAMPANHAS_INFO = {
    'aniversariantes':          { label: 'Aniversariantes',           icon: '🎂' },
    'confirmacao-agendamento':  { label: 'Confirmação Agendamento',   icon: '📅' },
    'alunos-novos':             { label: 'Alunos Novos',              icon: '🆕' },
    'inadimplentes':            { label: 'Inadimplentes',             icon: '🔴' },
    'parcelas-atrasadas':       { label: 'Parcelas Atrasadas',        icon: '🟡' },
    'vence-hoje':               { label: 'Vence Hoje',                icon: '🔵' },
    'ex-alunos':                { label: 'Ex-Alunos',                 icon: '👋' },
    'pos-venda-1':              { label: 'Pós Venda 1',               icon: '🎯' },
    'pos-venda-2':              { label: 'Pós Venda 2',               icon: '🔁' },
};

async function loadMensagensPersonalizadas() {
    if (!mensagensPersonalizadasLista) return;
    try {
        const url = filtroCategoriaMensagens
            ? `/api/mensagens-personalizadas?categoria=${encodeURIComponent(filtroCategoriaMensagens)}`
            : '/api/mensagens-personalizadas';
        const res = await fetch(url);
        mensagensPersonalizadasGlobais = await res.json();
        renderMensagensPersonalizadasLista();
    } catch (e) {
        mensagensPersonalizadasLista.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-3)">Erro ao carregar mensagens.</div>';
    }
}

function renderMensagensPersonalizadasLista() {
    if (!mensagensPersonalizadasLista) return;

    const tituloEl = document.getElementById('mensagens-personalizadas-titulo');
    const filtroWrap = document.getElementById('mensagens-personalizadas-filtro-ativo');
    const filtroTexto = document.getElementById('mensagens-personalizadas-filtro-texto');
    const campanha = filtroCategoriaMensagens ? CAMPANHAS_INFO[filtroCategoriaMensagens] : null;
    if (tituloEl) tituloEl.textContent = campanha ? `${campanha.icon} Mensagens — ${campanha.label}` : '💬 Mensagens Personalizadas';
    if (filtroWrap) filtroWrap.style.display = campanha ? 'flex' : 'none';
    if (filtroTexto && campanha) filtroTexto.textContent = `Mostrando só mensagens da campanha "${campanha.label}"`;

    if (mensagensPersonalizadasGlobais.length === 0) {
        mensagensPersonalizadasLista.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--text-3)">${campanha ? `Nenhuma mensagem em "${campanha.label}" ainda.` : 'Nenhuma mensagem criada ainda.'} Crie a primeira!</div>`;
        return;
    }
    mensagensPersonalizadasLista.innerHTML = mensagensPersonalizadasGlobais.map(m => {
        const info = m.categoria ? CAMPANHAS_INFO[m.categoria] : null;
        return `
        <div class="card glass" style="padding:1.1rem 1.3rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap" data-mensagem-id="${m.id}">
            <div style="flex:1;min-width:200px">
                <div style="font-weight:600;color:var(--text-1);font-size:.95rem;margin-bottom:.3rem">${info ? info.icon : '📝'} ${m.nome}</div>
                <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
                    ${info ? `<span style="font-size:.72rem;color:var(--green)">${info.label}</span>` : '<span style="font-size:.72rem;color:var(--text-3)">Sem campanha</span>'}
                    ${m.media_path ? '<span style="font-size:.75rem;color:var(--text-3)">📎 com mídia</span>' : ''}
                </div>
            </div>
            <button type="button" class="btn-secondary btn-editar-mensagem-personalizada" data-id="${m.id}" style="padding:.5rem .8rem;font-size:.82rem">✏️ Editar</button>
            <button type="button" class="btn-danger btn-excluir-mensagem-personalizada" data-id="${m.id}" style="padding:.5rem .7rem;font-size:.82rem">🗑️</button>
        </div>
    `;
    }).join('');
}

document.getElementById('btn-limpar-filtro-mensagens')?.addEventListener('click', () => {
    filtroCategoriaMensagens = null;
    loadMensagensPersonalizadas();
});

mensagensPersonalizadasLista?.addEventListener('click', async (e) => {
    const btnEditar = e.target.closest('.btn-editar-mensagem-personalizada');
    if (btnEditar) { abrirModalMensagemPersonalizada(mensagensPersonalizadasGlobais.find(x => x.id == btnEditar.dataset.id)); return; }

    const btnExcluir = e.target.closest('.btn-excluir-mensagem-personalizada');
    if (btnExcluir) {
        if (!confirm('Excluir esta mensagem? Ela para de ser enviada automaticamente por qualquer automação que a use.')) return;
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
    modalMensagemPersonalizadaTitulo.textContent = m ? '✏️ Editar Mensagem' : '➕ Nova Mensagem';
    mensagemPersonalizadaNome.value = m ? m.nome : '';
    mensagemPersonalizadaTexto.value = m ? m.texto : '';
    mensagemPersonalizadaMediaPath.value = m?.media_path || '';
    mensagemPersonalizadaMediaTipo.value = m?.media_tipo || '';
    // Editando: mantém a campanha que a mensagem já tinha. Criando: já vem
    // pré-selecionada com a campanha que está filtrando a lista agora (se veio
    // de um botão "Campanha Rápida"), senão fica "sem campanha".
    const categoriaSelect = document.getElementById('mensagem-personalizada-categoria');
    if (categoriaSelect) categoriaSelect.value = m ? (m.categoria || '') : (filtroCategoriaMensagens || '');
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
        media_tipo: mensagemPersonalizadaMediaTipo.value || null,
        categoria: document.getElementById('mensagem-personalizada-categoria')?.value || null
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
const acompanhamentoOrdenarAz = document.getElementById('acompanhamento-ordenar-az');
const acompanhamentoFiltroAtivas = document.getElementById('acompanhamento-filtro-ativas');
let ultimasAutomacoesCarregadas = [];
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
        ultimasAutomacoesCarregadas = automacoes;
        renderAcompanhamentoAutomacoes(automacoes);
    } catch (e) {
        acompanhamentoAutomacoesLista.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-3)">Erro ao carregar automações.</div>';
    }
}

acompanhamentoOrdenarAz?.addEventListener('change', () => renderAcompanhamentoAutomacoes(ultimasAutomacoesCarregadas));
acompanhamentoFiltroAtivas?.addEventListener('change', () => renderAcompanhamentoAutomacoes(ultimasAutomacoesCarregadas));

function renderAcompanhamentoAutomacoes(automacoesOriginal) {
    if (!acompanhamentoAutomacoesLista) return;
    let automacoes = automacoesOriginal;
    if (acompanhamentoFiltroAtivas?.checked) automacoes = automacoes.filter(a => a.disparo_ativo);
    if (acompanhamentoOrdenarAz?.checked) automacoes = [...automacoes].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    if (automacoes.length === 0) {
        acompanhamentoAutomacoesLista.innerHTML = `<div style="padding:1.5rem;text-align:center;color:var(--text-3)">${acompanhamentoFiltroAtivas?.checked ? 'Nenhuma automação disparando agora.' : 'Nenhuma automação criada ainda.'}</div>`;
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
                        <div style="font-weight:600;color:var(--text-1);font-size:.9rem;margin-bottom:.25rem">${a.nome}${a.disparo_ativo ? ' <span style="color:var(--red);font-size:.72rem;font-weight:600">🔴 disparando agora</span>' : ''}</div>
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
                    ${a.disparo_ativo ? `<button type="button" class="btn-danger btn-pausar-automacao" data-id="${a.id}" data-nome="${a.nome}" style="padding:.4rem .8rem;font-size:.78rem" title="Para antes do próximo contato — quem ainda não recebeu fica intacto na fila">⏸️ Pausar Disparo</button>` : ''}
                    <button type="button" class="btn-secondary btn-importar-lista-automacao" data-id="${a.id}" data-nome="${a.nome}" style="padding:.4rem .8rem;font-size:.78rem" title="Sincroniza a fila com quem tem a etiqueta agora — quem perdeu a etiqueta sai, quem ganhou entra">📥 Importar Lista</button>
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
                        <th></th>
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
                            <td style="text-align:right">
                                <button type="button" class="btn-danger btn-excluir-contato-automacao" data-automacao-id="${automacaoId}" data-telefone="${c.telefone}" data-nome="${c.nome}" style="padding:.3rem .5rem;font-size:.72rem" title="Tira só esse contato da fila, sem mandar mensagem">🗑️</button>
                            </td>
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
    const btnImportarLista = e.target.closest('.btn-importar-lista-automacao');
    if (btnImportarLista) { await sincronizarListaAutomacao(btnImportarLista); return; }

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

    const btnExcluirContato = e.target.closest('.btn-excluir-contato-automacao');
    if (btnExcluirContato) {
        if (!confirm(`Tirar "${btnExcluirContato.dataset.nome}" da fila dessa automação? Não manda mensagem nenhuma, só sai da lista.`)) return;
        try {
            const res = await fetch(`/api/automacoes/${btnExcluirContato.dataset.automacaoId}/contatos/${encodeURIComponent(btnExcluirContato.dataset.telefone)}`, { method: 'DELETE' });
            if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || 'Erro ao excluir'); }
            showToast('Removido da fila', '', 'success', 2000);
        } catch (err) {
            showToast('Erro', err.message, 'error');
        }
        return;
    }

    const btnPausar = e.target.closest('.btn-pausar-automacao');
    if (btnPausar) {
        if (!confirm(`Pausar o disparo de "${btnPausar.dataset.nome}"? Para antes do próximo contato — quem ainda não recebeu fica intacto na fila pra retomar depois.`)) return;
        btnPausar.disabled = true;
        try {
            const res = await fetch(`/api/automacoes/${btnPausar.dataset.id}/pausar`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Erro ao pausar');
            showToast('Pausa solicitada', 'Para assim que o envio do contato atual terminar.', 'success', 4000);
        } catch (err) {
            showToast('Erro', err.message, 'error');
            btnPausar.disabled = false;
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
