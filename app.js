/* ==========================================================================
   PRESTO · Controle de consumo · Festa de final de ano 2026
   Funciona 100% offline: dados no IndexedDB do celular, sincronização opcional
   com o Google Sheets (via Apps Script) quando houver internet.
   Este arquivo NÃO contém nomes, dados pessoais, endereço do script nem chave.
   ========================================================================== */
'use strict';

const VERSAO_APP = '1.2.0';

// Limites padrão (usados só até a primeira sincronização; depois valem os da aba CONFIGURACOES)
const PRODUTOS_PADRAO = [
  { nome: 'Cerveja', limite: 5, ativo: true },
  { nome: 'Refrigerante', limite: 2, ativo: true },
  { nome: 'Água', limite: 2, ativo: true },
  { nome: 'Cone de batata frita', limite: 2, ativo: true },
  { nome: 'Choripan', limite: 3, ativo: true },
  { nome: 'Espetinho', limite: 4, ativo: true }
];

const STATUS_NOME = { ATIVO: 'Ativo', DISPONIVEL: 'Disponível', CANCELADO: 'Cancelado' };
const TIPO_NOME = { COLABORADOR: 'Colaborador', CONVIDADO: 'Convidado' };

/* ---------- Utilidades ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase().replace(/\s+/g, ' ');
const pad3 = (n) => String(n).padStart(3, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const numDe = (id) => parseInt(String(id).replace(/\D/g, ''), 10) || 0;
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dataHora = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'nunca';

/** Converte o que foi lido/digitado em um código PST-000. Retorna null se inválido. */
function idDe(texto) {
  const t = norm(texto).replace(/\s/g, '');
  const m = t.match(/^PST-?(\d{1,4})$/) || t.match(/^(\d{1,4})$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 ? 'PST-' + pad3(n) : null;
}
function normStatus(s) {
  const t = norm(s);
  if (t.startsWith('ATIV') || t.startsWith('PRESENT')) return 'ATIVO';
  if (t.startsWith('CANCEL')) return 'CANCELADO';
  return 'DISPONIVEL';
}
function normTipo(s) {
  const t = norm(s);
  return (t.includes('CONVID') || t.includes('ACOMP')) ? 'CONVIDADO' : 'COLABORADOR';
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function vibrar(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* sem vibração */ } }

/* ---------- IndexedDB ---------- */
let db;
function abrirBanco() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('presto-consumo-2026', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('participantes')) d.createObjectStore('participantes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('consumos')) d.createObjectStore('consumos', { keyPath: 'idRegistro' });
      if (!d.objectStoreNames.contains('config')) d.createObjectStore('config');
    };
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
}
function lerTudo(store) {
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function lerChave(store, chave) {
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).get(chave);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
/** Grava e só resolve quando a gravação estiver confirmada em disco. */
function gravar(store, valores, chave) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    if (chave !== undefined) s.put(valores, chave); else if (Array.isArray(valores)) valores.forEach((v) => s.put(v)); else s.put(valores);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
function limparStore(store) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite'); t.objectStore(store).clear();
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
}
const salvarCfg = (chave, valor) => { S.cfg[chave] = valor; return gravar('config', valor, chave); };

/* ---------- Estado em memória (rápido) ---------- */
const S = {
  participantes: new Map(), // id -> participante
  consumos: [],             // todos os registros
  totais: new Map(),        // id -> { PRODUTO_NORMALIZADO: quantidade }
  estornados: new Set(),    // idRegistro que já foram desfeitos
  produtos: PRODUTOS_PADRAO,
  cfg: {},
  atual: null,              // participante aberto
  sincronizando: false,
  travaToque: false
};

function somarTotal(c) {
  let m = S.totais.get(c.id);
  if (!m) { m = {}; S.totais.set(c.id, m); }
  const k = norm(c.produto);
  m[k] = (m[k] || 0) + Number(c.qtd || 0);
  if (c.ref) S.estornados.add(c.ref);
}
const consumido = (id, prod) => (S.totais.get(id) || {})[norm(prod.nome)] || 0;
const produtosAtivos = () => S.produtos.filter((p) => p.ativo !== false);
const pendentesConsumo = () => S.consumos.filter((c) => !c.sincronizado);
const pendentesCadastro = () => Array.from(S.participantes.values()).filter((p) => p.pendente);

async function carregarDados() {
  const [parts, cons, cfgs] = await Promise.all([lerTudo('participantes'), lerTudo('consumos'), lerTudoConfig()]);
  S.participantes = new Map(parts.map((p) => [p.id, p]));
  S.consumos = cons.sort((a, b) => a.dataHora.localeCompare(b.dataHora));
  S.totais = new Map(); S.estornados = new Set();
  S.consumos.forEach(somarTotal);
  S.cfg = cfgs;
  if (Array.isArray(S.cfg.produtos) && S.cfg.produtos.length) S.produtos = S.cfg.produtos;
}
function lerTudoConfig() {
  return new Promise((res, rej) => {
    const out = {};
    const r = db.transaction('config').objectStore('config').openCursor();
    r.onsuccess = () => { const c = r.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
    r.onerror = () => rej(r.error);
  });
}

/* ---------- Navegação (o botão voltar do Android funciona) ---------- */
const TELAS = ['inicio', 'leitor', 'participante', 'cadastro', 'lista', 'relatorio', 'sync'];
function ir(tela) {
  if (('#' + tela) === location.hash) { mostrar(tela); return; }
  // participante -> leitor substitui a página, para o botão voltar não acumular leituras
  if (tela === 'leitor' && location.hash === '#participante') { location.replace('#leitor'); return; }
  location.hash = tela;
}
function mostrar(tela) {
  if (!TELAS.includes(tela)) tela = 'inicio';
  if (tela === 'participante' && !S.participantes.get(S.atual)) tela = 'inicio';
  TELAS.forEach((t) => { $('#tela-' + t).hidden = t !== tela; });
  $('#btnVoltar').hidden = tela === 'inicio';
  if (tela !== 'leitor') pararDeteccao();
  if (tela === 'inicio' || tela === 'cadastro' || tela === 'lista' || tela === 'relatorio' || tela === 'sync') pararCamera();
  window.scrollTo(0, 0);
  ({
    inicio: renderInicio, leitor: abrirLeitor, participante: renderParticipante,
    cadastro: abrirCadastro, lista: renderLista, relatorio: renderRelatorio, sync: renderSync
  })[tela]();
}
window.addEventListener('hashchange', () => mostrar(location.hash.slice(1)));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ir]');
  if (b) { e.preventDefault(); ir(b.dataset.ir); }
});
$('#btnVoltar').addEventListener('click', () => history.length > 1 ? history.back() : ir('inicio'));
$('#topoStatus').addEventListener('click', () => ir('sync'));

/* ---------- Aviso (toast) ---------- */
let toastTimer;
function toast(texto, tipo = 'ok', acao) {
  const t = $('#toast');
  $('#toastTexto').textContent = texto;
  t.className = 'toast ' + (tipo === 'erro' ? 'erro' : '');
  const b = $('#toastAcao');
  if (acao) { b.hidden = false; b.textContent = acao.rotulo; b.onclick = () => { esconderToast(); acao.fn(); }; } else b.hidden = true;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(esconderToast, acao ? 6000 : 3500);
}
function esconderToast() { $('#toast').hidden = true; }

/* ---------- Modal ---------- */
function modal(html) {
  const d = $('#dlg');
  d.innerHTML = html;
  if (!d.open) d.showModal();
  return d;
}
function confirmar(titulo, texto, rotuloOk = 'Confirmar') {
  return new Promise((res) => {
    const d = modal(`<h2>${esc(titulo)}</h2><p>${esc(texto)}</p>
      <div class="botoes-linha"><button class="btn" data-r="0">Cancelar</button><button class="btn primario" data-r="1">${esc(rotuloOk)}</button></div>`);
    d.onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) { d.close(); res(b.dataset.r === '1'); } };
    d.oncancel = () => res(false);
  });
}

/* ---------- Status no topo e na tela inicial ---------- */
function atualizarStatus() {
  const online = navigator.onLine;
  const pend = pendentesConsumo().length + pendentesCadastro().length;
  $('#pontoConexao').className = 'ponto' + (online ? ' on' : '');
  $('#textoPendentes').textContent = pend ? `${pend} a enviar` : (online ? 'Online' : 'Offline');
  const stC = $('#stConexao'), stS = $('#stSync');
  if (stC) {
    stC.textContent = online ? 'Online' : 'Sem internet';
    stC.className = online ? 'st-ok' : 'st-alerta';
    if (S.sincronizando) { stS.textContent = 'Enviando…'; stS.className = ''; }
    else if (S.cfg.erroSync && pend) { stS.textContent = `${pend} a enviar`; stS.className = 'st-erro'; }
    else if (pend) { stS.textContent = `${pend} aguardando`; stS.className = 'st-alerta'; }
    else { stS.textContent = S.cfg.ultimoEnvio || S.cfg.ultimaBaixa ? 'Tudo enviado' : 'Não configurada'; stS.className = S.cfg.ultimoEnvio || S.cfg.ultimaBaixa ? 'st-ok' : 'st-alerta'; }
  }
}
window.addEventListener('online', () => { atualizarStatus(); sincronizar({ silencioso: true }); });
window.addEventListener('offline', atualizarStatus);

/* ==========================================================================
   TELA INICIAL
   ========================================================================== */
function renderInicio() {
  const parts = Array.from(S.participantes.values()).filter((p) => p.status !== 'CANCELADO');
  $('#kpiCadastrados').textContent = parts.length;
  $('#kpiPresentes').textContent = parts.filter((p) => p.status === 'ATIVO').length;
  $('#kpiItens').textContent = S.consumos.reduce((s, c) => s + Number(c.qtd || 0), 0);
  $('#versaoApp').textContent = 'v' + VERSAO_APP;
  atualizarStatus();
}

/* ==========================================================================
   LEITOR DE QR CODE (BarcodeDetector nativo do Chrome; jsQR como reserva)
   ========================================================================== */
const scan = { stream: null, raf: 0, detector: null, ocupado: false, ultimo: 0, canvas: null, ctx: null, wake: null, timerOcioso: 0 };

async function abrirLeitor() {
  $('#leitorErro').hidden = true;
  $('#codigoManual').value = '';
  $('.camera').classList.remove('lido');
  $('#cameraMsg').textContent = 'Abrindo a câmera…';
  clearTimeout(scan.timerOcioso);
  try {
    if (!window.isSecureContext) throw Object.assign(new Error('inseguro'), { name: 'Inseguro' });
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('sem-api'), { name: 'SemApi' });
    if (!scan.stream) {
      // tenta do pedido mais completo ao mais simples (alguns aparelhos recusam resolução/câmera específica)
      const tentativas = [
        { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        { audio: false, video: { facingMode: 'environment' } },
        { audio: false, video: true }
      ];
      let ultimoErro;
      for (const t of tentativas) {
        try { scan.stream = await navigator.mediaDevices.getUserMedia(t); break; }
        catch (e) { ultimoErro = e; if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break; }
      }
      if (!scan.stream) throw ultimoErro || new Error('camera');
      const v = $('#video');
      v.setAttribute('playsinline', ''); v.muted = true;
      v.srcObject = scan.stream;
      try { await v.play(); } catch (e) { /* alguns aparelhos tocam sozinhos depois */ }
      pedirTelaAcesa();
    }
    $('#cameraMsg').textContent = 'Aponte para o QR Code da pulseira';
    if (!scan.detector && 'BarcodeDetector' in window) {
      try {
        const formatos = await BarcodeDetector.getSupportedFormats();
        if (formatos.includes('qr_code')) scan.detector = new BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) { scan.detector = null; }
    }
    if (location.hash === '#leitor') { cancelAnimationFrame(scan.raf); scan.raf = requestAnimationFrame(loopLeitura); }
  } catch (e) {
    pararCamera();
    $('#cameraMsg').textContent = 'Câmera indisponível';
    const msgs = {
      NotAllowedError: 'A câmera está bloqueada para este app. Veja como liberar nas instruções e toque em "Abrir a câmera de novo". Enquanto isso, use "Ler por foto" ou digite o número.',
      SecurityError: 'A câmera está bloqueada para este app. Libere a permissão e toque em "Abrir a câmera de novo".',
      NotReadableError: 'A câmera está ocupada por outro aplicativo. Feche os outros apps (câmera, WhatsApp) e toque em "Abrir a câmera de novo".',
      NotFoundError: 'Nenhuma câmera encontrada. Use "Ler por foto" ou digite o número.',
      OverconstrainedError: 'A câmera não aceitou a configuração. Toque em "Abrir a câmera de novo" ou use "Ler por foto".',
      Inseguro: 'O app precisa ser aberto pelo endereço https://genteestaopresto.github.io/presto-controle-consumo/ para usar a câmera.',
      SemApi: 'Este navegador não libera a câmera. Abra o app pelo Google Chrome (não pelo link do WhatsApp) ou use "Ler por foto".'
    };
    erroLeitor((msgs[e && e.name] || 'Não foi possível abrir a câmera.') + (e && e.name && !msgs[e.name] ? ' (' + e.name + ')' : ''));
  }
}
$('#btnTentarCamera').addEventListener('click', () => { pararCamera(); abrirLeitor(); });

// Plano B: tira uma foto com a câmera do celular e lê o QR Code da foto
$('#fotoQR').addEventListener('change', async (e) => {
  const arq = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!arq) return;
  try {
    const img = await createImageBitmap(arq);
    const max = 1200, f = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * f); c.height = Math.round(img.height * f);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    let texto = null;
    if ('BarcodeDetector' in window) {
      try { const r = await new BarcodeDetector({ formats: ['qr_code'] }).detect(c); if (r.length) texto = r[0].rawValue; } catch (er) { /* usa jsQR */ }
    }
    if (!texto && typeof jsQR === 'function') {
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const r = jsQR(d.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
      if (r) texto = r.data;
    }
    if (texto) aoLer(texto);
    else { vibrar([90, 60, 90]); erroLeitor('Não encontrei QR Code na foto. Tire outra mais de perto, com o QR Code inteiro e nítido.'); }
  } catch (er) { erroLeitor('Não foi possível ler a foto. Tente de novo.'); }
});
function erroLeitor(msg) { const el = $('#leitorErro'); el.textContent = msg; el.hidden = false; }

async function loopLeitura() {
  if (!scan.stream || location.hash !== '#leitor') return;
  const agora = performance.now();
  const v = $('#video');
  if (!scan.ocupado && agora - scan.ultimo > 110 && v.readyState >= 2) {
    scan.ocupado = true; scan.ultimo = agora;
    try {
      const texto = await detectar(v);
      if (texto) { scan.ocupado = false; aoLer(texto); return; }
    } catch (e) { scan.detector = null; } // se o detector nativo falhar, usa o jsQR
    scan.ocupado = false;
  }
  scan.raf = requestAnimationFrame(loopLeitura);
}
async function detectar(v) {
  if (scan.detector) {
    const r = await scan.detector.detect(v);
    return r.length ? r[0].rawValue : null;
  }
  if (typeof jsQR !== 'function') return null;
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return null;
  const lado = Math.min(vw, vh) * 0.8, alvo = 480;
  if (!scan.canvas) { scan.canvas = document.createElement('canvas'); scan.canvas.width = scan.canvas.height = alvo; scan.ctx = scan.canvas.getContext('2d', { willReadFrequently: true }); }
  scan.ctx.drawImage(v, (vw - lado) / 2, (vh - lado) / 2, lado, lado, 0, 0, alvo, alvo);
  const img = scan.ctx.getImageData(0, 0, alvo, alvo);
  const r = jsQR(img.data, alvo, alvo, { inversionAttempts: 'attemptBoth' });
  return r ? r.data : null;
}
function aoLer(texto) {
  const id = idDe(texto);
  if (!id || !S.participantes.has(id)) {
    vibrar([90, 60, 90]);
    erroLeitor(id ? `Identificação não encontrada: ${id} não está cadastrado.` : 'Identificação não encontrada. Este QR Code não é de uma pulseira Presto.');
    // continua lendo após uma pausa curta para não repetir o mesmo erro
    setTimeout(() => { if (location.hash === '#leitor') { scan.raf = requestAnimationFrame(loopLeitura); } }, 1500);
    return;
  }
  vibrar(40);
  $('.camera').classList.add('lido');
  abrirParticipante(id);
}
$('#formManual').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#codigoManual').value.trim();
  if (!v) return;
  const id = idDe(v);
  if (!id || !S.participantes.has(id)) { erroLeitor(`Identificação não encontrada: PST-${esc(v)}.`); vibrar([90, 60, 90]); return; }
  abrirParticipante(id);
});
function pararDeteccao() {
  cancelAnimationFrame(scan.raf);
  // libera a câmera se ficar 2 minutos sem uso (economia de bateria)
  clearTimeout(scan.timerOcioso);
  if (scan.stream) scan.timerOcioso = setTimeout(pararCamera, 120000);
}
function pararCamera() {
  cancelAnimationFrame(scan.raf);
  clearTimeout(scan.timerOcioso);
  if (scan.stream) { scan.stream.getTracks().forEach((t) => t.stop()); scan.stream = null; }
  const v = $('#video'); if (v) v.srcObject = null;
  if (scan.wake) { scan.wake.release().catch(() => {}); scan.wake = null; }
}
async function pedirTelaAcesa() {
  try { if ('wakeLock' in navigator && !scan.wake) scan.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* opcional */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pararCamera();
  else if (location.hash === '#leitor') abrirLeitor();
});

/* ==========================================================================
   PARTICIPANTE E REGISTRO DE CONSUMO
   ========================================================================== */
function abrirParticipante(id) {
  S.atual = id;
  if (location.hash === '#participante') renderParticipante();
  else if (location.hash === '#leitor') location.replace('#participante'); // não empilha o leitor no histórico
  else ir('participante');
}

function renderParticipante() {
  const p = S.participantes.get(S.atual);
  if (!p) return;
  const resp = p.tipo === 'CONVIDADO' && p.responsavel ? ` · responsável: ${esc(p.responsavel)}` : '';
  $('#partCabecalho').innerHTML = `
    <div class="part-cab">
      <div>
        <h1>${esc(p.nome || 'Sem nome')}</h1>
        <div class="part-meta">${esc(TIPO_NOME[p.tipo] || '')}${resp}</div>
      </div>
      <div style="text-align:right">
        <div class="part-codigo">${esc(p.id)}</div>
        <span class="tag ${p.status}">${STATUS_NOME[p.status]}</span>
      </div>
    </div>`;

  let banner = '';
  if (p.status === 'DISPONIVEL') {
    banner = `<div class="banner alerta">
      <p>Entrada ainda não confirmada</p>
      ${p.nome ? '' : '<label class="rotulo">Nome do participante<input id="nomeEntrada" autocapitalize="words"></label>'}
      <button class="btn primario grande" id="btnEntrada">Confirmar entrada</button></div>`;
  } else if (p.status === 'CANCELADO') {
    banner = `<div class="banner erro">Cadastro cancelado. Retiradas bloqueadas. Para liberar, toque em Editar cadastro.</div>`;
  }
  $('#partBanner').innerHTML = banner;
  const be = $('#btnEntrada'); if (be) be.onclick = confirmarEntrada;

  const bloqueado = p.status !== 'ATIVO';
  $('#grade').innerHTML = produtosAtivos().map((prod) => {
    const usado = consumido(p.id, prod);
    const disp = Math.max(0, prod.limite - usado);
    const esgotado = disp === 0;
    const pips = Array.from({ length: prod.limite }, (_, i) => `<i class="${i < usado ? 'usado' : ''}"></i>`).join('');
    const acao = bloqueado ? 'Bloqueado' : esgotado ? 'Limite atingido' : '+1 Registrar';
    return `<button class="item ${esgotado ? 'esgotado' : ''} ${bloqueado ? 'bloq' : ''}" data-prod="${esc(prod.nome)}" ${bloqueado ? 'aria-disabled="true"' : ''}>
      <span class="nome">${esc(prod.nome)}</span>
      <span class="disp"><b>${disp}</b><span>${disp === 1 ? 'disponível' : 'disponíveis'}</span></span>
      <span class="usado">Retirados: ${usado} de ${prod.limite}</span>
      <span class="pips" aria-hidden="true">${pips}</span>
      <span class="acao">${acao}</span>
    </button>`;
  }).join('');

  renderHistorico(p);
}

function renderHistorico(p) {
  const regs = S.consumos.filter((c) => c.id === p.id).slice().reverse();
  const ul = $('#hist');
  if (!regs.length) { ul.innerHTML = '<li class="vazio">Nenhuma retirada ainda.</li>'; return; }
  ul.innerHTML = regs.map((c) => {
    if (c.qtd < 0) return `<li class="desfeito"><span class="hora">${hora(c.dataHora)}</span><span class="prod">${esc(c.produto)}</span><span class="apoio">desfeito</span></li>`;
    const desfeito = S.estornados.has(c.idRegistro);
    return `<li class="${desfeito ? 'desfeito' : ''}"><span class="hora">${hora(c.dataHora)}</span><span class="prod">${esc(c.produto)} +1</span>
      ${desfeito ? '' : `<button class="btn" data-desfazer="${esc(c.idRegistro)}">Desfazer</button>`}</li>`;
  }).join('');
}
$('#hist').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-desfazer]');
  if (!b) return;
  const reg = S.consumos.find((c) => c.idRegistro === b.dataset.desfazer);
  if (reg && await confirmar('Desfazer retirada?', `${reg.produto} às ${hora(reg.dataHora)} volta para o saldo.`, 'Desfazer')) desfazer(reg);
});

$('#grade').addEventListener('click', (e) => {
  const tile = e.target.closest('[data-prod]');
  if (tile) registrar(tile.dataset.prod);
});

async function registrar(nomeProduto) {
  const p = S.participantes.get(S.atual);
  if (!p) return;
  if (p.status === 'DISPONIVEL') { toast('Confirme a entrada antes de registrar.', 'erro'); return; }
  if (p.status !== 'ATIVO') { toast('Cadastro cancelado. Retirada bloqueada.', 'erro'); vibrar([90, 60, 90]); return; }
  if (S.travaToque) return; // evita toque duplo acidental
  S.travaToque = true; setTimeout(() => { S.travaToque = false; }, 400);

  const prod = S.produtos.find((x) => x.nome === nomeProduto);
  if (!prod) return;
  if (consumido(p.id, prod) >= prod.limite) {
    vibrar([90, 60, 90]);
    toast(`Limite de ${prod.nome} atingido (${prod.limite}).`, 'erro');
    return;
  }
  const reg = { idRegistro: uuid(), id: p.id, produto: prod.nome, qtd: 1, dataHora: new Date().toISOString(), sincronizado: 0 };
  try { await gravar('consumos', reg); }
  catch (err) { toast('Não foi possível salvar. Tente de novo.', 'erro'); return; }
  S.consumos.push(reg); somarTotal(reg);
  renderParticipante();
  const tile = $(`#grade [data-prod="${CSS.escape(prod.nome)}"]`);
  if (tile) { tile.classList.remove('flash'); void tile.offsetWidth; tile.classList.add('flash'); }
  vibrar(35);
  toast(`Pronto! +1 ${prod.nome} para ${p.id}.`, 'ok', { rotulo: 'Desfazer', fn: () => desfazer(reg) });
  atualizarStatus();
}

async function desfazer(reg) {
  if (S.estornados.has(reg.idRegistro)) return;
  const est = { idRegistro: 'EST-' + reg.idRegistro, ref: reg.idRegistro, id: reg.id, produto: reg.produto, qtd: -1, dataHora: new Date().toISOString(), sincronizado: 0 };
  try { await gravar('consumos', est); } catch (e) { toast('Não foi possível desfazer.', 'erro'); return; }
  S.consumos.push(est); somarTotal(est);
  if (S.atual === reg.id && location.hash === '#participante') renderParticipante();
  toast(`Retirada de ${reg.produto} desfeita.`);
  atualizarStatus();
}

async function confirmarEntrada() {
  const p = S.participantes.get(S.atual);
  const campo = $('#nomeEntrada');
  if (campo) {
    const nome = campo.value.trim().replace(/\s+/g, ' ');
    if (nome.length < 3) { toast('Informe o nome do participante.', 'erro'); campo.focus(); return; }
    p.nome = nome;
  }
  p.status = 'ATIVO'; p.pendente = 1; p.atualizadoEm = new Date().toISOString();
  await gravar('participantes', p);
  vibrar(35);
  renderParticipante();
  toast('Pronto! Entrada confirmada.');
  atualizarStatus();
}

/* ---------- Editar cadastro ---------- */
$('#btnEditar').addEventListener('click', () => {
  const p = S.participantes.get(S.atual);
  if (!p) return;
  const opt = (obj, atual) => Object.entries(obj).map(([v, t]) => `<option value="${v}" ${v === atual ? 'selected' : ''}>${t}</option>`).join('');
  const d = modal(`<h2>Editar ${esc(p.id)}</h2>
    <form class="form" id="formEditar">
      <label>Nome completo<input name="nome" value="${esc(p.nome)}" required minlength="3" autocapitalize="words"></label>
      <label>Tipo<select name="tipo">${opt(TIPO_NOME, p.tipo)}</select></label>
      <label>Colaborador responsável<input name="responsavel" list="listaColab" value="${esc(p.responsavel)}"></label>
      <label>Situação<select name="status">${opt(STATUS_NOME, p.status)}</select></label>
      <div class="botoes-linha"><button type="button" class="btn" id="edCancelar">Cancelar</button><button class="btn primario">Salvar</button></div>
    </form>`);
  preencherColaboradores();
  $('#edCancelar').onclick = () => d.close();
  d.onclick = null;
  $('#formEditar').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const nome = String(f.get('nome')).trim().replace(/\s+/g, ' ');
    const dup = duplicadoPorNome(nome, p.id);
    if (dup && !(await confirmar('Nome repetido', `Já existe ${dup.nome} (${dup.id}). Salvar mesmo assim?`, 'Salvar'))) return;
    Object.assign(p, { nome, tipo: f.get('tipo'), responsavel: String(f.get('responsavel')).trim(), status: f.get('status'), pendente: 1, atualizadoEm: new Date().toISOString() });
    await gravar('participantes', p);
    if (d.open) d.close();
    renderParticipante();
    toast('Pronto! Cadastro atualizado.');
    atualizarStatus();
  };
});

/* ==========================================================================
   CADASTRO DE PARTICIPANTE EXTRA
   ========================================================================== */
const proximoCodigo = () => 'PST-' + pad3(Math.max(0, ...Array.from(S.participantes.keys()).map(numDe)) + 1);
function duplicadoPorNome(nome, ignorarId) {
  const n = norm(nome);
  if (!n) return null;
  return Array.from(S.participantes.values()).find((p) => p.id !== ignorarId && norm(p.nome) === n) || null;
}
function preencherColaboradores() {
  $('#listaColab').innerHTML = Array.from(S.participantes.values())
    .filter((p) => p.tipo === 'COLABORADOR' && p.nome && p.status !== 'CANCELADO')
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .map((p) => `<option value="${esc(p.nome)} (${p.id})"></option>`).join('');
}
function segValor(sel) { const b = $(sel + ' [aria-pressed="true"]'); return b ? b.dataset.v : ''; }
function ligarSeg(sel, aoMudar) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$(sel + ' button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    if (aoMudar) aoMudar(b.dataset.v);
  });
}
ligarSeg('#cadTipo', (v) => { $('#cadRespWrap').hidden = v !== 'CONVIDADO'; });
ligarSeg('#cadStatus');

function abrirCadastro() {
  $('#formCadastro').hidden = false;
  $('#cadResultado').hidden = true;
  $('#formCadastro').reset();
  $('#cadCodigo').value = proximoCodigo();
  $('#cadCodigoDica').textContent = 'Próximo código livre. Entregue a pulseira com este número.';
  $$('#cadTipo button').forEach((b, i) => b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false'));
  $$('#cadStatus button').forEach((b, i) => b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false'));
  $('#cadRespWrap').hidden = true;
  preencherColaboradores();
}

$('#formCadastro').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = $('#cadNome').value.trim().replace(/\s+/g, ' ');
  if (nome.length < 3) { toast('Informe o nome completo.', 'erro'); return; }
  const id = idDe($('#cadCodigo').value);
  if (!id) { toast('Código inválido. Use o formato PST-121.', 'erro'); return; }
  if (S.participantes.has(id)) {
    const outro = S.participantes.get(id);
    toast(`${id} já pertence a ${outro.nome || 'outro participante'}.`, 'erro');
    return;
  }
  const dup = duplicadoPorNome(nome);
  if (dup && !(await confirmar('Pessoa já cadastrada?', `Já existe ${dup.nome} com a pulseira ${dup.id} (${STATUS_NOME[dup.status]}). Cadastrar outra pulseira mesmo assim?`, 'Cadastrar mesmo assim'))) {
    return;
  }
  const tipo = segValor('#cadTipo');
  const p = {
    id, codigo: pad3(numDe(id)), nome, tipo,
    responsavel: tipo === 'CONVIDADO' ? $('#cadResp').value.trim() : '',
    status: segValor('#cadStatus'),
    dataCadastro: new Date().toISOString(), atualizadoEm: new Date().toISOString(),
    pendente: 1, novo: 1
  };
  await gravar('participantes', p);
  S.participantes.set(id, p);
  atualizarStatus();
  vibrar(35);
  mostrarResultadoCadastro(p);
});

function svgQR(texto) {
  const qr = qrcode(0, 'M'); qr.addData(texto); qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}
function mostrarResultadoCadastro(p) {
  $('#formCadastro').hidden = true;
  const r = $('#cadResultado');
  r.hidden = false;
  r.innerHTML = `<h2>Pronto! Cadastro salvo</h2>
    <div class="qr-box">${svgQR(p.id)}</div>
    <div class="codigo-grande">${esc(p.id)}</div>
    <div>${esc(p.nome)}</div>
    <p class="apoio">Entregue a pulseira ${esc(p.id)}. Sem pulseira impressa, a pessoa pode fotografar este QR Code.</p>
    <button class="btn primario grande" id="cadAbrir">Abrir participante</button>
    <button class="btn grande" id="cadOutro">Cadastrar outro</button>`;
  $('#cadAbrir').onclick = () => abrirParticipante(p.id);
  $('#cadOutro').onclick = abrirCadastro;
}

/* ==========================================================================
   LISTA
   ========================================================================== */
$('#busca').addEventListener('input', renderLista);
ligarSeg('#filtroStatus', renderLista);
function renderLista() {
  const q = norm($('#busca').value);
  const f = segValor('#filtroStatus');
  const todos = Array.from(S.participantes.values()).sort((a, b) => numDe(a.id) - numDe(b.id));
  const lista = todos.filter((p) => (!f || p.status === f) && (!q || norm(p.nome).includes(q) || p.id.includes(q) || pad3(numDe(p.id)) === q.padStart(3, '0')));
  $('#listaContagem').textContent = `${lista.length} de ${todos.length} participantes`;
  $('#lista').innerHTML = lista.length ? lista.map((p) => `
    <li data-id="${p.id}">
      <span class="cod">${p.id}</span>
      <span class="nm"><div>${esc(p.nome || 'Sem nome')}</div><div>${TIPO_NOME[p.tipo]}${p.responsavel ? ' · ' + esc(p.responsavel) : ''}</div></span>
      <span class="tag ${p.status}">${STATUS_NOME[p.status]}</span>
    </li>`).join('') : '<li class="vazio">Nenhum participante encontrado. Baixe a lista em Sincronização.</li>';
}
$('#lista').addEventListener('click', (e) => { const li = e.target.closest('[data-id]'); if (li) abrirParticipante(li.dataset.id); });

/* ==========================================================================
   RELATÓRIO E EXPORTAÇÃO CSV
   ========================================================================== */
function totaisPorProduto() {
  const t = {};
  produtosAtivos().forEach((p) => { t[norm(p.nome)] = 0; });
  S.consumos.forEach((c) => { const k = norm(c.produto); t[k] = (t[k] || 0) + Number(c.qtd || 0); });
  return t;
}
function renderRelatorio() {
  const parts = Array.from(S.participantes.values()).sort((a, b) => numDe(a.id) - numDe(b.id));
  const presentes = parts.filter((p) => p.status === 'ATIVO').length;
  $('#relSub').textContent = `${parts.filter((p) => p.status !== 'CANCELADO').length} participantes, ${presentes} presentes`;
  const t = totaisPorProduto();
  $('#relTotais').innerHTML = produtosAtivos().map((p) => `<div><div class="l">${esc(p.nome)}</div><div class="v">${t[norm(p.nome)] || 0}</div></div>`).join('');

  const prods = produtosAtivos();
  const comConsumo = parts.filter((p) => S.totais.has(p.id) || p.status === 'ATIVO');
  const cab = `<thead><tr><th>Código</th><th>Nome</th>${prods.map((p) => `<th>${esc(p.nome)}</th>`).join('')}</tr></thead>`;
  const linhas = comConsumo.map((p) => `<tr data-id="${p.id}"><td>${p.id}</td><td>${esc(p.nome)}</td>${prods.map((pr) => `<td>${consumido(p.id, pr)}</td>`).join('')}</tr>`).join('');
  const total = `<tr class="total"><td>Total</td><td></td>${prods.map((p) => `<td>${t[norm(p.nome)] || 0}</td>`).join('')}</tr>`;
  $('#relTabela').innerHTML = cab + `<tbody>${linhas || `<tr><td colspan="${prods.length + 2}">Nenhum consumo registrado.</td></tr>`}${linhas ? total : ''}</tbody>`;
}
$('#relTabela').addEventListener('click', (e) => { const tr = e.target.closest('[data-id]'); if (tr) abrirParticipante(tr.dataset.id); });

function baixarCSV(nome, linhas) {
  const csv = '\ufeff' + linhas.map((l) => l.map((v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = nome; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  toast('Pronto! Arquivo salvo em Downloads.');
}
const carimbo = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
$('#btnCsvResumo').addEventListener('click', () => {
  const prods = produtosAtivos();
  const linhas = [['CODIGO', 'NOME', 'TIPO', 'RESPONSAVEL', 'STATUS', ...prods.flatMap((p) => [p.nome.toUpperCase() + ' RETIRADOS', p.nome.toUpperCase() + ' SALDO'])]];
  Array.from(S.participantes.values()).sort((a, b) => numDe(a.id) - numDe(b.id)).forEach((p) => {
    linhas.push([p.id, p.nome, TIPO_NOME[p.tipo], p.responsavel, STATUS_NOME[p.status], ...prods.flatMap((pr) => { const u = consumido(p.id, pr); return [u, pr.limite - u]; })]);
  });
  baixarCSV(`presto-resumo-${carimbo()}.csv`, linhas);
});
$('#btnCsvRegistros').addEventListener('click', () => {
  const linhas = [['ID_REGISTRO', 'CODIGO', 'NOME', 'PRODUTO', 'QUANTIDADE', 'DATA_HORA']];
  S.consumos.forEach((c) => linhas.push([c.idRegistro, c.id, (S.participantes.get(c.id) || {}).nome || '', c.produto, c.qtd, new Date(c.dataHora).toLocaleString('pt-BR')]));
  baixarCSV(`presto-registros-${carimbo()}.csv`, linhas);
});

/* ==========================================================================
   SINCRONIZAÇÃO COM O GOOGLE SHEETS (Apps Script)
   ========================================================================== */
async function chamarApi(acao, dados = {}) {
  if (!S.cfg.url || !S.cfg.token) throw new Error('Configure o endereço do Apps Script e a chave de acesso.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(S.cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita bloqueio de CORS
      body: JSON.stringify({ token: S.cfg.token, acao, ...dados }),
      redirect: 'follow', signal: ctrl.signal
    });
    const texto = await r.text();
    let j;
    try { j = JSON.parse(texto); } catch (e) { throw new Error('O Apps Script não respondeu como esperado. Confira o endereço (termina em /exec) e se a implantação está com acesso "Qualquer pessoa".'); }
    if (!j.ok) throw new Error(j.erro || 'Erro no Apps Script.');
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Sem resposta da internet. Os registros continuam salvos no celular.');
    if (e instanceof TypeError) throw new Error('Sem conexão com a planilha. Os registros continuam salvos no celular.');
    throw e;
  } finally { clearTimeout(timer); }
}

/** Envia pendências (em lotes) e depois baixa a lista atualizada. */
async function sincronizar({ silencioso = false, soBaixar = false } = {}) {
  if (S.sincronizando) return;
  if (!S.cfg.url || !S.cfg.token) { if (!silencioso) toast('Configure a conexão com a planilha primeiro.', 'erro'); return; }
  if (!navigator.onLine) { if (!silencioso) toast('Sem internet. Tudo continua salvo no celular.', 'erro'); return; }
  S.sincronizando = true; atualizarStatus(); renderSyncSeAberta();
  try {
    if (!soBaixar) await enviarPendencias();
    await baixarDados();
    await salvarCfg('erroSync', '');
    if (!silencioso) toast('Pronto! Planilha e celular sincronizados.');
  } catch (e) {
    await salvarCfg('erroSync', e.message);
    if (!silencioso) toast(e.message, 'erro');
  } finally {
    S.sincronizando = false; atualizarStatus(); renderSyncSeAberta();
    if (location.hash === '#inicio' || !location.hash) renderInicio();
  }
}

async function enviarPendencias() {
  const cadastros = pendentesCadastro();
  const consumos = pendentesConsumo();
  if (!cadastros.length && !consumos.length) return;
  const LOTE = 250;
  for (let i = 0; i < Math.max(consumos.length, 1); i += LOTE) {
    const lote = consumos.slice(i, i + LOTE);
    const r = await chamarApi('enviar', {
      participantes: i === 0 ? cadastros.map((p) => ({ id: p.id, codigo: p.codigo || pad3(numDe(p.id)), nome: p.nome, tipo: p.tipo, responsavel: p.responsavel, status: p.status, dataCadastro: p.dataCadastro, novo: !!p.novo })) : [],
      consumos: lote.map((c) => ({ idRegistro: c.idRegistro, id: c.id, produto: c.produto, qtd: c.qtd, dataHora: c.dataHora }))
    });
    // marca como enviados somente os que a planilha confirmou
    const confirmados = new Set(r.idsConfirmados || []);
    const marcados = lote.filter((c) => confirmados.has(c.idRegistro));
    marcados.forEach((c) => { c.sincronizado = 1; });
    if (marcados.length) await gravar('consumos', marcados);
    if (i === 0 && cadastros.length) {
      const okP = new Set(r.participantesConfirmados || []);
      const atualizados = cadastros.filter((p) => okP.has(p.id));
      atualizados.forEach((p) => { p.pendente = 0; p.novo = 0; });
      if (atualizados.length) await gravar('participantes', atualizados);
    }
  }
  await salvarCfg('ultimoEnvio', new Date().toISOString());
}

async function baixarDados() {
  const r = await chamarApi('baixar');
  // Participantes: o que tem alteração local ainda não enviada é preservado
  const novos = [];
  (r.participantes || []).forEach((rp) => {
    const id = idDe(rp.id);
    if (!id) return;
    const local = S.participantes.get(id);
    if (local && local.pendente) return;
    const p = {
      id, codigo: pad3(numDe(id)), nome: String(rp.nome || '').trim(), tipo: normTipo(rp.tipo),
      responsavel: String(rp.responsavel || '').trim(), status: normStatus(rp.status),
      dataCadastro: rp.dataCadastro || '', pendente: 0
    };
    S.participantes.set(id, p); novos.push(p);
  });
  if (novos.length) await gravar('participantes', novos);

  // Consumos que já estão na planilha e não existem no celular (ex.: celular reinstalado)
  const existentes = new Set(S.consumos.map((c) => c.idRegistro));
  const vindos = [];
  (r.consumos || []).forEach((rc) => {
    if (!rc.idRegistro || existentes.has(rc.idRegistro)) return;
    const id = idDe(rc.id); if (!id) return;
    const ref = String(rc.idRegistro).startsWith('EST-') ? String(rc.idRegistro).slice(4) : undefined;
    vindos.push({ idRegistro: String(rc.idRegistro), id, produto: rc.produto, qtd: Number(rc.qtd) || 0, dataHora: rc.dataHora || new Date().toISOString(), sincronizado: 1, ref });
  });
  if (vindos.length) {
    await gravar('consumos', vindos);
    vindos.forEach((c) => { S.consumos.push(c); somarTotal(c); });
    S.consumos.sort((a, b) => a.dataHora.localeCompare(b.dataHora));
  }

  if (Array.isArray(r.produtos) && r.produtos.length) {
    S.produtos = r.produtos.map((p) => ({ nome: String(p.nome).trim(), limite: Math.max(0, parseInt(p.limite, 10) || 0), ativo: p.ativo !== false }));
    await salvarCfg('produtos', S.produtos);
  }
  await salvarCfg('ultimaBaixa', new Date().toISOString());
}

function renderSyncSeAberta() { if (location.hash === '#sync') renderSync(); }

async function renderSync() {
  const pc = pendentesConsumo().length, pp = pendentesCadastro().length;
  $('#syncDados').innerHTML = `
    <dt>Conexão</dt><dd class="${navigator.onLine ? 'st-ok' : 'st-alerta'}">${navigator.onLine ? 'Online' : 'Sem internet'}</dd>
    <dt>Retiradas a enviar</dt><dd>${pc}</dd>
    <dt>Cadastros a enviar</dt><dd>${pp}</dd>
    <dt>Último envio</dt><dd>${dataHora(S.cfg.ultimoEnvio)}</dd>
    <dt>Lista baixada em</dt><dd>${dataHora(S.cfg.ultimaBaixa)}</dd>
    ${S.cfg.erroSync ? `<dt>Último erro</dt><dd class="st-erro" style="text-align:left">${esc(S.cfg.erroSync)}</dd>` : ''}`;
  $('#btnSincronizar').disabled = $('#btnBaixar').disabled = S.sincronizando;
  $('#btnSincronizar').textContent = S.sincronizando ? 'Sincronizando…' : 'Sincronizar agora';
  if (document.activeElement !== $('#cfgUrl')) $('#cfgUrl').value = S.cfg.url || '';
  if (document.activeElement !== $('#cfgToken')) $('#cfgToken').value = S.cfg.token || '';
  $('#limites').innerHTML = S.produtos.map((p) => `<li><span>${esc(p.nome)}${p.ativo === false ? ' (inativo)' : ''}</span><span>${p.limite}</span></li>`).join('');
  $$('#segTema button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === (S.cfg.tema || 'light') ? 'true' : 'false'));
  renderChecklist();
}

async function renderChecklist() {
  const itens = [];
  itens.push([S.participantes.size > 0, S.participantes.size ? `${S.participantes.size} participantes salvos no celular` : 'Baixe a lista de participantes']);
  itens.push([!!(S.cfg.url && S.cfg.token), 'Conexão com a planilha configurada']);
  let offline = false;
  try { offline = !!navigator.serviceWorker?.controller && !!(await caches.match('index.html', { ignoreSearch: true })); } catch (e) { /* */ }
  itens.push([offline, offline ? 'App salvo para funcionar sem internet' : 'Feche e abra o app uma vez com internet']);
  let camera = false;
  try { camera = (await navigator.permissions.query({ name: 'camera' })).state === 'granted'; } catch (e) { /* */ }
  itens.push([camera, camera ? 'Câmera liberada' : 'Abra o leitor uma vez e permita a câmera']);
  // Espaço: o que realmente importa para não perder registros
  let espacoOk = true, espacoTxt = 'Espaço de armazenamento suficiente';
  try {
    const est = await navigator.storage.estimate();
    const livreMB = Math.round(((est.quota || 0) - (est.usage || 0)) / 1048576);
    espacoOk = livreMB > 200;
    espacoTxt = espacoOk ? 'Espaço de armazenamento suficiente' : 'Pouco espaço livre no celular. Apague fotos ou vídeos antes do evento';
  } catch (e) { /* navegador sem estimativa */ }
  itens.push([espacoOk, espacoTxt]);
  itens.push([pendentesConsumo().length + pendentesCadastro().length === 0, 'Nada pendente de envio']);
  let protegido = false;
  try { protegido = await navigator.storage?.persisted?.(); } catch (e) { /* */ }
  $('#checklist').innerHTML = itens.map(([ok, t]) => `<li class="${ok ? 'ok' : ''}"><span class="ic">${ok ? '✓' : '!'}</span><span>${esc(t)}</span></li>`).join('') +
    `<li class="${protegido ? 'ok' : 'info'}"><span class="ic">${protegido ? '✓' : 'i'}</span><span>${protegido
      ? 'Proteção extra do Chrome ativada'
      : 'Proteção extra do Chrome: opcional, o Chrome decide quando ativar. <button class="btn fantasma" id="btnPersistir" type="button">Pedir agora</button>'}</span></li>`;
  const bp = $('#btnPersistir');
  if (bp) bp.onclick = async () => {
    let ok = false;
    try { ok = await navigator.storage.persist(); } catch (e) { /* */ }
    toast(ok ? 'Pronto! Proteção extra ativada.' : 'O Chrome ainda não liberou. Os dados continuam salvos normalmente.', ok ? 'ok' : 'erro');
    renderChecklist();
  };
}

$('#btnSincronizar').addEventListener('click', () => sincronizar());
$('#btnBaixar').addEventListener('click', () => sincronizar({ soBaixar: true }));
$('#formConfig').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#cfgUrl').value.trim();
  const token = $('#cfgToken').value.trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) { toast('O endereço precisa começar com https://script.google.com/macros/s/ e terminar em /exec.', 'erro'); return; }
  if (token.length < 16) { toast('Chave de acesso inválida.', 'erro'); return; }
  await salvarCfg('url', url); await salvarCfg('token', token);
  try {
    const r = await chamarApi('ping');
    toast(`Pronto! Conectado à planilha ${r.planilha || ''}.`);
    sincronizar({ silencioso: false, soBaixar: S.participantes.size === 0 });
  } catch (err) { toast(err.message, 'erro'); }
});
ligarSeg('#segTema', async (v) => { await salvarCfg('tema', v); aplicarTema(); });
function aplicarTema() { document.documentElement.dataset.theme = S.cfg.tema === 'dark' ? 'dark' : 'light'; }

$('#btnApagar').addEventListener('click', async () => {
  const pend = pendentesConsumo().length + pendentesCadastro().length;
  if (pend) { toast(`Há ${pend} itens não enviados. Sincronize antes de apagar.`, 'erro'); return; }
  const d = modal(`<h2>Apagar dados deste celular</h2>
    <p>Remove participantes e registros salvos aqui. A planilha não é alterada. Digite APAGAR para confirmar.</p>
    <form class="form" id="formApagar"><input name="c" autocomplete="off"><div class="botoes-linha"><button type="button" class="btn" id="apCancelar">Cancelar</button><button class="btn perigo">Apagar</button></div></form>`);
  d.onclick = null;
  $('#apCancelar').onclick = () => d.close();
  $('#formApagar').onsubmit = async (e) => {
    e.preventDefault();
    if (new FormData(e.target).get('c') !== 'APAGAR') { toast('Digite APAGAR em maiúsculas.', 'erro'); return; }
    await limparStore('participantes'); await limparStore('consumos');
    await salvarCfg('ultimaBaixa', ''); await salvarCfg('ultimoEnvio', '');
    await carregarDados();
    d.close(); toast('Dados do celular apagados.'); renderSync();
  };
});

/* ==========================================================================
   INICIALIZAÇÃO
   ========================================================================== */
async function iniciar() {
  try {
    await abrirBanco();
    await carregarDados();
  } catch (e) {
    document.body.innerHTML = '<p style="padding:20px;font-size:17px">Não foi possível abrir o banco de dados do celular. Saia do modo anônimo do Chrome e tente de novo.</p>';
    return;
  }
  aplicarTema();
  // Pede ao Chrome para não apagar os dados automaticamente
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* opcional */ }

  if ('serviceWorker' in navigator) {
    const tinhaControlador = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (tinhaControlador) toast('Nova versão instalada.', 'ok', { rotulo: 'Atualizar', fn: () => location.reload() });
    });
  }

  mostrar(location.hash.slice(1) || 'inicio');
  atualizarStatus();
  if (!location.hash) history.replaceState(null, '', '#inicio');

  // Tenta enviar pendências sozinho quando houver internet
  setInterval(() => {
    if (navigator.onLine && !S.sincronizando && (pendentesConsumo().length || pendentesCadastro().length)) sincronizar({ silencioso: true });
  }, 90000);
  if (navigator.onLine) setTimeout(() => sincronizar({ silencioso: true }), 3000);
}
iniciar();
