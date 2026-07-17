# Renomeação automática de contatos e erros de sessão do WhatsApp

Contexto: painel mostrava erros `advSignedDeviceIdentity is null or undefined`
e `Lid is missing in chat table` em "⚠️ Erros de Número de WhatsApp" e ao
enviar mensagem manual pelo Bate Papo ao Vivo. As duas strings são internas do
próprio WhatsApp Web (vêm de `static.whatsapp.net/.../*.js`) — não existem em
lugar nenhum do nosso código, só são logadas cruas quando um envio falha.

## 1. Renomeação automática de contato no WhatsApp

**O que faz:** quando a varredura Pacto "Alunos Ativos" encontra um aluno
ativo que ainda não era contato (lead novo) e tem nome, o bot salva esse nome
no WhatsApp e sincroniza com a agenda do(s) celular(es) pareado(s), via
`client.saveOrEditAddressbookContact(telefone, primeiroNome, sobrenome, true)`
— API real do `whatsapp-web.js` (`node_modules/whatsapp-web.js/src/Client.js:3320`).

**Onde no código** (`chatbot.js`):
- Fila + processamento: `filaRenomeioContatoWhatsApp` / `enfileirarRenomeioContatoWhatsApp` /
  `processarFilaRenomeioContatoWhatsApp`, logo antes da seção "Pacto — Alunos Ativos x Ex-Alunos".
- Gatilho: dentro de `processarVarreduraAlunosAtivosPacto()`, só quando o
  telefone **não existia antes** em `leads` (checagem `jaEraLead`) — sem isso,
  toda rodada da varredura (que roda do zero sempre) reenfileiraria todo mundo de novo.
- Escopo: roda no número principal (`client`) **e** em todos os números do
  pool de disparo que estiverem `status === 'connected'` (`poolClients`) — em
  paralelo entre contas diferentes (sem risco cruzado, são WhatsApps distintos).
- Throttle: 10-30s (`FAIXAS_VELOCIDADE.medio`) entre um contato e o próximo,
  sequencial — porque é uma escrita na agenda (ação que o WhatsApp nunca viu em
  massa nessa conta), mais sensível a rajada do que só mandar mensagem.
- Falha silenciosa por contato: erro ao renomear um número específico só loga
  no console, não interrompe a fila nem a varredura.

**Não cobre:** criação manual de contato, edição manual, nem importação CSV —
só o gatilho da varredura Pacto "Alunos Ativos", por decisão explícita ao
implementar. Também não faz backfill retroativo dos contatos que já existiam
antes dessa mudança.

**Importante — isso NÃO tem relação com os erros de sessão abaixo.** Nome
salvo na agenda é só organização visual; não cria, atualiza nem repara sessão
criptografada nem mapeamento LID de ninguém.

## 2. Erros de sessão (`Lid is missing` / `advSignedDeviceIdentity`)

São dois problemas diferentes, de origens diferentes dentro do protocolo do
WhatsApp Web:

### `Lid is missing in chat table`
Acontece quando o chat id já foi resolvido corretamente (`resolverChatId` →
`getNumberId`), mas a tabela interna de chats da sessão (dentro do Puppeteer)
ainda não tem o mapeamento LID↔telefone daquele contato carregado.

**Tentativa de correção implementada:** `sendMessageComRetryLid()`
(`chatbot.js`, perto de `resolverChatId`) — se o `sendMessage` falhar com essa
mensagem específica, chama `client.getContactLidAndPhone([chatId])` (mesma
API que o projeto já usava só pra mensagem *recebida*, em `resolveJid`, mas
que por baixo força o WhatsApp a resolver/repovoar esse mapeamento via
`enforceLidAndPnRetrieval`) e tenta reenviar **uma vez**. Hoje só está ligado
no envio manual do Bate Papo ao Vivo (`POST /api/conversas/:telefone/enviar`).
Se isso se mostrar eficaz, dá pra estender pros outros pontos que chamam
`client.sendMessage` (automação, disparo, mensagem personalizada).

### `advSignedDeviceIdentity is null or undefined`
Problema de sessão/identidade de dispositivo (protocolo Signal), não de
mapeamento LID — o retry acima **não corrige esse caso**. Continua exigindo
reconectar a sessão daquele número especificamente:
- Se for um número do pool de disparo: botão 🗑️ "Remover" naquele número
  específico (apaga só a sessão dele, força QR novo) — não afeta o principal
  nem os outros números.
- Se for o número principal: botão "Desconectar" no topo do painel — isso
  derruba o bot inteiro até re-escanear o QR, então só fazer isso com o
  problema confirmado e sabendo do impacto.
