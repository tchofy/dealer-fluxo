/*
    Dealer/Fluxo - parte da extensão que roda fora da página.

    O portal padrão (*.dealernetworkflow.com.br) está no manifest. Portais em outros endereços são
    adicionados pelo usuário no botão da extensão ("Ativar Dealer/Fluxo neste site"): o navegador pede
    permissão só para aquele site e aqui registramos o mesmo script da página para ele.

    chrome.storage.local:
      sites:    [{ id, origem: 'https://portal.exemplo.com.br/*', padrao: 'https://portal.exemplo.com.br/Portal/default.html*' }]
      pendente: { origem, padrao, aba }  -> site que o popup está oferecendo para ativar. No Firefox o popup
                fecha quando aparece o pedido de permissão, então quem termina a ativação é este script,
                no evento permissions.onAdded.
*/
// Por site, dois scripts (como no manifest): o tema em document_start, também na tela de login do site
// (LoginAux.aspx, ao lado da pasta Portal), e o Dealer/Fluxo em document_idle, só no portal
const paginaLogin = (padrao) => padrao.replace(/\/Portal\/default\.html\*$/i, '/LoginAux.aspx*');
// A ponte da telemetria roda no mundo isolado da extensão (a página não acessa as APIs da extensão)
const SCRIPTS = [
    { sufixo: '-tema', js: ['dealer-tema.js'], runAt: 'document_start', world: 'MAIN', matches: (padrao) => [padrao, paginaLogin(padrao)] },
    { sufixo: '-ponte', js: ['telemetria-ponte.js'], runAt: 'document_start', world: 'ISOLATED', matches: (padrao) => [padrao] },
    { sufixo: '', js: ['vendor/Sortable.min.js', 'dealerfluxo.js'], runAt: 'document_idle', world: 'MAIN', matches: (padrao) => [padrao] }
];

async function lerSites() {
    const { sites = [] } = await chrome.storage.local.get('sites');
    return sites;
}

// Deixa os scripts registrados iguais à lista de sites (só os que ainda têm permissão).
// Pode ser chamada quantas vezes for preciso.
async function sincronizar() {
    const sites = await lerSites();
    const comPermissao = [];
    for (const site of sites) {
        if (await chrome.permissions.contains({ origins: [site.origem] })) comPermissao.push(site);
    }
    // Permissão retirada pelo navegador (ex.: nas configurações da extensão): o site sai da lista
    if (comPermissao.length !== sites.length) await chrome.storage.local.set({ sites: comPermissao });

    const desejados = new Map();
    for (const site of comPermissao) {
        for (const sc of SCRIPTS) {
            desejados.set(site.id + sc.sufixo, {
                id: site.id + sc.sufixo,
                matches: [...new Set(sc.matches(site.padrao))],
                js: sc.js,
                runAt: sc.runAt,
                world: sc.world,        // como no manifest: o Dealer/Fluxo e o tema precisam do contexto da página
                persistAcrossSessions: true
            });
        }
    }
    const registrados = await chrome.scripting.getRegisteredContentScripts();
    // O navegador pode devolver os endereços em outra ordem: compara sem a ordem
    const mesmos = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
    const igual = (r, d) => mesmos(r.matches, d.matches) &&
        JSON.stringify(r.js) === JSON.stringify(d.js) && (r.runAt || 'document_idle') === d.runAt &&
        (r.world || 'ISOLATED') === d.world;
    const remover = registrados.filter(r => !desejados.has(r.id) || !igual(r, desejados.get(r.id))).map(r => r.id);
    if (remover.length) await chrome.scripting.unregisterContentScripts({ ids: remover });

    const jaRegistrados = new Set(registrados.map(r => r.id).filter(id => !remover.includes(id)));
    const novos = [...desejados.values()].filter(d => !jaRegistrados.has(d.id));
    if (novos.length) await chrome.scripting.registerContentScripts(novos);
}

// Termina a ativação do site pendente, se a permissão dele já foi dada
async function concluirPendente() {
    const { pendente } = await chrome.storage.local.get('pendente');
    if (!pendente || !(await chrome.permissions.contains({ origins: [pendente.origem] }))) return false;
    const sites = await lerSites();
    if (!sites.some(s => s.padrao === pendente.padrao)) {
        sites.push({ id: `site-${Date.now()}`, origem: pendente.origem, padrao: pendente.padrao });
        await chrome.storage.local.set({ sites });
    }
    await chrome.storage.local.remove('pendente');
    await sincronizar();
    if (pendente.aba != null) {
        try { await chrome.tabs.reload(pendente.aba); } catch (e) { /* aba fechada */ }
    }
    return true;
}

async function removerSite(id) {
    const sites = await lerSites();
    const site = sites.find(s => s.id === id);
    if (!site) return;
    const restantes = sites.filter(s => s.id !== id);
    await chrome.storage.local.set({ sites: restantes });
    await sincronizar();
    // Devolve a permissão do site, se nenhum outro endereço da lista usa a mesma origem
    if (!restantes.some(s => s.origem === site.origem)) {
        try { await chrome.permissions.remove({ origins: [site.origem] }); } catch (e) { /* ignora */ }
    }
}

chrome.permissions.onAdded.addListener(() => { concluirPendente().catch(console.error); });
chrome.permissions.onRemoved.addListener(() => { sincronizar().catch(console.error); });
chrome.runtime.onInstalled.addListener(() => { sincronizar().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { sincronizar().catch(console.error); });

chrome.runtime.onMessage.addListener((msg, remetente, responder) => {
    const acoes = {
        concluirPendente: () => concluirPendente(),
        remover: () => removerSite(msg.id),
        sincronizar: () => sincronizar(),
        telemetria: () => tratarTelemetria(msg.msg || {})
    };
    const acao = acoes[msg && msg.tipo];
    if (!acao) return false;
    acao().then(r => responder({ ok: true, resultado: r }), e => responder({ ok: false, erro: String(e) }));
    return true;  // resposta assíncrona
});


/* ------------------------------------------------------------------------------------------------------------
    Telemetria: estatísticas de uso anônimas, no máximo um envio por dia (ver /privacidade no servidor).

    A página (via telemetria-ponte.js) manda:
      estado   { ativo, semIcone, dados: {...}, versaoTema, semIconeItens: [[arquivo, dica, tela, situacao]] }
               ao carregar, ao salvar as configurações, ao trocar o tema e a cada 10 minutos
      contar   { nome }  trocas de tema/fonte (pelos menus da engrenagem ou pelas configurações)
      previa   -> o que seria enviado agora (botão "Ver o que será enviado")
      situacao -> consentimentos (empresa, Firefox)
    Aqui os dados de cada dia ficam em chrome.storage.local e só os dias que já terminaram são enviados.
    Tudo o que sai passa por uma lista fixa de campos (montarPing / itensSemIcone): nada além disso vai junto.
------------------------------------------------------------------------------------------------------------ */
const ENDERECO_TELEMETRIA = 'https://dealer-fluxo-ping.igorslime.workers.dev';   // a build de teste troca por um servidor local
const DIAS_GUARDADOS = 14;
const CONTADORES = new Set(['temaMenu', 'fonteMenu', 'temaConfig', 'fonteConfig']);
const TELAS = new Set(['1366', '1600', '1920', 'maior']);
const ID_SIMPLES = /^[a-z0-9-]{1,40}$/;

// Dia no horário de Brasília (o mesmo do servidor)
const diaHoje = (agora = Date.now()) => new Date(agora - 3 * 3600e3).toISOString().slice(0, 10);

// Uma fila: cada operação lê e grava o armazenamento inteira, sem se misturar com outra
let filaTelemetria = Promise.resolve();
const emFila = (fn) => (filaTelemetria = filaTelemetria.then(fn, fn));

async function lerTelemetria() {
    const { telemetria = {} } = await chrome.storage.local.get('telemetria');
    return { ativo: true, semIcone: false, dias: {}, semIconeEnviados: {}, semIconePendentes: null, ...telemetria };
}
const gravarTelemetria = (t) => chrome.storage.local.set({ telemetria: t });

// Empresa (política do navegador: telemetria=false) e Firefox (permissões de dados da extensão)
async function consentimento() {
    let empresa = {};
    try { empresa = (await chrome.storage.managed.get('telemetria')) || {}; } catch (e) { /* sem política */ }
    let firefox = null;
    try {
        const p = await chrome.permissions.getAll();
        if (Array.isArray(p.data_collection)) firefox = p.data_collection;
    } catch (e) { /* navegador sem permissões de dados */ }
    const bloqueadoEmpresa = empresa.telemetria === false;
    return {
        bloqueadoEmpresa,
        firefox: !!firefox,
        uso: !bloqueadoEmpresa && (!firefox || firefox.includes('technicalAndInteraction')),
        semIcone: !bloqueadoEmpresa && (!firefox || firefox.includes('websiteContent'))
    };
}

function navegador() {
    const ua = navigator.userAgent;
    let m;
    if ((m = ua.match(/Firefox\/(\d+)/))) return `firefox ${m[1]}`;
    if ((m = ua.match(/Edg\/(\d+)/))) return `edge ${m[1]}`;
    if ((m = ua.match(/OPR\/(\d+)/))) return `opera ${m[1]}`;
    if ((m = ua.match(/Chrome\/(\d+)/))) return `chrome ${m[1]}`;
    return 'outro';
}

function sistema() {
    const ua = navigator.userAgent;
    if (/Windows/.test(ua)) return 'windows';
    if (/CrOS/.test(ua)) return 'chromeos';
    if (/Mac OS X|Macintosh/.test(ua)) return 'macos';
    if (/Linux|X11/.test(ua)) return 'linux';
    return 'outro';
}

// Só os campos combinados, com valores conferidos (o que vier a mais da página é descartado)
function dadosPermitidos(d) {
    d = d || {};
    const r = {};
    if (TELAS.has(d.tela)) r.tela = d.tela;
    if (d.dominio === 'padrao' || d.dominio === 'outro') r.dominio = d.dominio;
    if (Number.isFinite(d.alturaBarra)) r.alturaBarra = Math.round(d.alturaBarra);
    if (typeof d.tema === 'string' && ID_SIMPLES.test(d.tema)) r.tema = d.tema;
    if (typeof d.fonte === 'string' && ID_SIMPLES.test(d.fonte)) r.fonte = d.fonte;
    if (Number.isFinite(d.tamanho)) r.tamanho = Math.round(d.tamanho);
    if (typeof d.imagens === 'boolean') r.imagens = d.imagens;
    if (typeof d.versaoTema === 'string' && /^\d+\.\d+\.\d+$/.test(d.versaoTema)) r.versaoTema = d.versaoTema;
    return r;
}

function montarPing(dia, registro) {
    const uso = {};
    for (const [nome, n] of Object.entries(registro.contadores || {})) {
        if (CONTADORES.has(nome) && Number.isFinite(n) && n > 0) uso[nome] = Math.round(n);
    }
    return {
        dia,
        versao: chrome.runtime.getManifest().version,
        navegador: navegador(),
        dados: { sistema: sistema(), ...dadosPermitidos(registro.dados), uso }
    };
}

// Dica só curta e sem números (números podem ser datas, códigos, documentos); o servidor confere de novo
const dicaSegura = (dica) => {
    const t = String(dica || '').replace(/\s+/g, ' ').trim();
    return t.length <= 60 && !/\d/.test(t) ? t : '';
};
function itensSemIcone(itens) {
    const r = [];
    for (const item of Array.isArray(itens) ? itens : []) {
        if (!Array.isArray(item)) continue;
        const [arquivo, dica, tela, situacao] = item.map(x => String(x == null ? '' : x));
        if (!/^[\w.\-]{1,100}$/.test(arquivo) || !/^[\w.\-]{0,100}$/.test(tela)) continue;
        if (situacao !== 'sem regra' && situacao !== 'rótulo deduzido') continue;
        r.push([arquivo, dicaSegura(dica), tela, situacao]);
    }
    return r;
}

async function registrarEstado(msg) {
    const t = await lerTelemetria();
    t.ativo = msg.ativo !== false;
    t.semIcone = msg.semIcone === true;
    if (!t.ativo) {
        t.dias = {};                                    // desligado: apaga o que não foi enviado
    } else {
        const dia = diaHoje();
        const atual = t.dias[dia] || { contadores: {} };
        t.dias[dia] = { dados: dadosPermitidos({ ...(msg.dados || {}), versaoTema: msg.versaoTema }), contadores: atual.contadores || {} };
    }
    const versaoTema = typeof msg.versaoTema === 'string' && /^\d+\.\d+\.\d+$/.test(msg.versaoTema) ? msg.versaoTema : null;
    if (!t.ativo || !t.semIcone || !versaoTema) {
        t.semIconePendentes = null;
    } else {
        // Cada imagem vai uma vez por versão do tema (a lista da biblioteca já vem só com o que ainda falta)
        const enviados = new Set(t.semIconeEnviados[versaoTema] || []);
        t.semIconeEnviados = { [versaoTema]: [...enviados] };   // versões antigas do tema não interessam mais
        const pendentes = new Map();
        if (t.semIconePendentes && t.semIconePendentes.versaoTema === versaoTema) {
            t.semIconePendentes.itens.forEach(i => pendentes.set(i[0].toLowerCase(), i));
        }
        itensSemIcone(msg.semIconeItens).forEach(i => {
            const chave = i[0].toLowerCase();
            if (!enviados.has(chave)) pendentes.set(chave, i);
        });
        // Só o que a biblioteca ainda lista: o que ganhou ícone nesse meio tempo sai da fila
        if (Array.isArray(msg.semIconeItens)) {
            const atuais = new Set(msg.semIconeItens.map(i => String(i && i[0] || '').toLowerCase()));
            for (const chave of [...pendentes.keys()]) if (!atuais.has(chave)) pendentes.delete(chave);
        }
        t.semIconePendentes = { versaoTema, itens: [...pendentes.values()] };
    }
    await gravarTelemetria(t);
}

async function contar(nome) {
    if (!CONTADORES.has(nome)) return;
    const t = await lerTelemetria();
    if (!t.ativo) return;
    const dia = diaHoje();
    const registro = t.dias[dia] || (t.dias[dia] = { dados: {}, contadores: {} });
    registro.contadores[nome] = (registro.contadores[nome] || 0) + 1;
    await gravarTelemetria(t);
}

async function postar(caminho, corpo) {
    try {
        const r = await fetch(ENDERECO_TELEMETRIA + caminho, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(corpo),
            credentials: 'omit',
            cache: 'no-store'
        });
        // 4xx: o servidor recusou o formato; tentar de novo não adiantaria
        return r.ok || (r.status >= 400 && r.status < 500) ? 'feito' : 'depois';
    } catch (e) {
        return 'depois';                                // sem rede, bloqueado: tenta na próxima vez
    }
}

// Envia os dias que já terminaram (incluirHoje só para os testes) e as imagens sem ícone pendentes
async function enviarPendentes(incluirHoje = false) {
    const t = await lerTelemetria();
    const c = await consentimento();
    const hoje = diaHoje();
    const limite = diaHoje(Date.now() - DIAS_GUARDADOS * 864e5);
    if (!t.ativo || !c.uso) {
        t.dias = {};
    } else {
        for (const dia of Object.keys(t.dias).sort()) {
            if (dia < limite) { delete t.dias[dia]; continue; }
            if (dia >= hoje && !incluirHoje) continue;
            if (await postar('/ping', montarPing(dia, t.dias[dia])) !== 'feito') break;
            delete t.dias[dia];
        }
    }
    if (!t.ativo || !t.semIcone || !c.semIcone) {
        t.semIconePendentes = null;
    } else if (t.semIconePendentes && t.semIconePendentes.itens.length) {
        const { versaoTema, itens } = t.semIconePendentes;
        const enviados = new Set(t.semIconeEnviados[versaoTema] || []);
        for (let i = 0; i < itens.length; i += 200) {
            const lote = itens.slice(i, i + 200);
            if (await postar('/semicone', { versao: chrome.runtime.getManifest().version, versaoTema, itens: lote }) !== 'feito') break;
            lote.forEach(item => enviados.add(item[0].toLowerCase()));
        }
        t.semIconeEnviados = { [versaoTema]: [...enviados] };
        t.semIconePendentes.itens = itens.filter(item => !enviados.has(item[0].toLowerCase()));
    }
    await gravarTelemetria(t);
}

async function previaTelemetria() {
    const t = await lerTelemetria();
    const c = await consentimento();
    return {
        consentimento: c,
        ativo: t.ativo,
        endereco: ENDERECO_TELEMETRIA,
        ping: Object.keys(t.dias).sort().map(dia => montarPing(dia, t.dias[dia])),
        semIcone: t.semIcone && t.semIconePendentes && t.semIconePendentes.itens.length ?
            { versao: chrome.runtime.getManifest().version, versaoTema: t.semIconePendentes.versaoTema, itens: t.semIconePendentes.itens } : null
    };
}

function tratarTelemetria(msg) {
    switch (msg.tipo) {
        case 'estado':
            return emFila(() => registrarEstado(msg)).then(() => emFila(() => enviarPendentes()));
        case 'contar':
            return emFila(() => contar(String(msg.nome || '')));
        case 'previa':
            return emFila(() => previaTelemetria());
        case 'situacao':
            return consentimento();
        case 'abrirOpcoes':
            return chrome.runtime.openOptionsPage();
        default:
            return Promise.resolve(null);
    }
}

// Confere os dias pendentes de hora em hora (e ao abrir o navegador)
const ALARME_TELEMETRIA = 'telemetria';
chrome.alarms.onAlarm.addListener((alarme) => {
    if (alarme.name === ALARME_TELEMETRIA) emFila(() => enviarPendentes()).catch(console.error);
});
chrome.alarms.get(ALARME_TELEMETRIA).then(a => { if (!a) chrome.alarms.create(ALARME_TELEMETRIA, { periodInMinutes: 60, delayInMinutes: 1 }); });
chrome.runtime.onStartup.addListener(() => { emFila(() => enviarPendentes()).catch(console.error); });

// Para os testes automáticos (e para conferir pelo console do fundo da extensão)
globalThis.__telemetria = {
    ler: lerTelemetria,
    enviar: (incluirHoje = false) => emFila(() => enviarPendentes(incluirHoje)),
    previa: () => emFila(() => previaTelemetria())
};
