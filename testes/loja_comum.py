"""
Partes comuns das capturas (capturas_loja.py) e do vídeo (video_loja.py) para as lojas: anonimização dos dados
pessoais e as camadas desenhadas por cima do portal (cursor, legendas, teclas, capa).

O que trocar (nome do usuário, da empresa, do servidor...) fica em testes/anonimizar.local.json, fora do
repositório (está no .gitignore), para os próprios dados não irem junto com o código:

    {
      "trocas": [["<expressão regular, sem as barras>", "<substituto>"], ...],
      "procurar": ["<texto que não pode sobrar na tela (conferência e OCR)>", ...]
    }

As expressões são do JavaScript, sempre sem diferenciar maiúsculas (flag "gi").
"""
import json
import os

_LOCAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "anonimizar.local.json")
try:
    with open(_LOCAL, encoding="utf-8") as _f:
        _CONF = json.load(_f)
except FileNotFoundError:
    raise SystemExit(f"Crie {_LOCAL} com os dados a esconder (veja o início de loja_comum.py)")

# [expressão regular JS, substituto]
TROCAS = "[" + ",".join(f"[new RegExp({json.dumps(r)}, 'gi'), {json.dumps(t, ensure_ascii=False)}]"
                        for r, t in _CONF.get("trocas", [])) + "]"

PROCURAR = [str(x).upper() for x in _CONF.get("procurar", [])]

# Troca nos textos, valores de campos, títulos e alts da página e de todas as telas (iframes da mesma origem)
ANONIMIZAR = r"""() => {
    const trocas = %s;
    const trocar = (t) => trocas.reduce((s, [re, por]) => s.replace(re, por), t);
    const varrer = (doc) => {
        const andar = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = andar.nextNode())) { const novo = trocar(n.nodeValue); if (novo !== n.nodeValue) n.nodeValue = novo; }
        doc.querySelectorAll('input:not([type=hidden]), textarea').forEach(i => { if (i.value) i.value = trocar(i.value); });
        doc.querySelectorAll('[title], [alt]').forEach(e => {
            ['title', 'alt'].forEach(a => { const v = e.getAttribute(a); if (v) e.setAttribute(a, trocar(v)); });
        });
        doc.title = trocar(doc.title || '');
        // Logotipo da empresa (imagens com "logo" no endereço, fora as do DealerNet)
        doc.querySelectorAll('img').forEach(img => {
            const src = img.getAttribute('src') || '';
            if (/logo/i.test(src) && !/dealer/i.test(src)) img.style.visibility = 'hidden';
        });
        doc.querySelectorAll('iframe').forEach(f => { try { if (f.contentDocument && f.contentDocument.body) varrer(f.contentDocument); } catch (e) {} });
    };
    varrer(document);
}""" % TROCAS

# Versão contínua, para o vídeo. Roda só na página de cima e cuida de todos os documentos dela: a cada quadro
# (requestAnimationFrame, antes da pintura) procura documentos novos nos iframes, troca o que já houver e liga um
# MutationObserver em cada um; valores de campos visíveis a cada 100 ms. Não dá para contar com script inicial nas
# telas: o iframe reaproveita o window do about:blank ao navegar, e o script do DevTools não roda no documento novo.
ANONIMIZAR_SEMPRE = r"""(() => {
    if (window.top !== window || window.__dbtAnonimo) return;
    window.__dbtAnonimo = true;
    const trocas = %s;
    const trocar = (t) => trocas.reduce((s, [re, por]) => s.replace(re, por), t);
    const texto = (n) => {
        if (n.parentNode && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentNode.nodeName)) return;
        const novo = trocar(n.nodeValue); if (novo !== n.nodeValue) n.nodeValue = novo;
    };
    const atributos = (e) => ['title', 'alt'].forEach(a => { const v = e.getAttribute && e.getAttribute(a); if (v) { const n = trocar(v); if (n !== v) e.setAttribute(a, n); } });
    const logo = (img) => { const src = img.getAttribute('src') || ''; if (/logo/i.test(src) && !/dealer/i.test(src)) img.style.visibility = 'hidden'; };
    const tratar = (doc, raiz) => {
        if (raiz.nodeType === 3) return texto(raiz);
        if (raiz.nodeType !== 1) return;
        const andar = doc.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = andar.nextNode())) texto(n);
        atributos(raiz);
        raiz.querySelectorAll('[title], [alt]').forEach(atributos);
        if (raiz.tagName === 'IMG') logo(raiz);
        raiz.querySelectorAll('img').forEach(logo);
    };
    const docs = new Set();
    const instalar = (doc) => {
        if (doc.__dbtAnonimo || !doc.documentElement) return;
        doc.__dbtAnonimo = true;
        docs.add(doc);
        new MutationObserver((lista) => {
            for (const m of lista) {
                if (m.type === 'characterData') texto(m.target);
                else if (m.type === 'attributes') { atributos(m.target); if (m.target.tagName === 'IMG') logo(m.target); }
                else m.addedNodes.forEach(n => tratar(doc, n));
            }
        }).observe(doc, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'alt', 'src'] });
        tratar(doc, doc.documentElement);
    };
    const procurar = (doc) => {
        instalar(doc);
        doc.querySelectorAll('iframe, frame').forEach(f => { try { if (f.contentDocument) procurar(f.contentDocument); } catch (e) {} });
    };
    // Nunca nos campos escondidos: o GXState leva o usuário e o servidor recusa a tela se ele mudar
    const campos = () => docs.forEach(doc => {
        if (!doc.defaultView) { docs.delete(doc); return; }
        doc.querySelectorAll('input:not([type=hidden]), textarea').forEach(i => { if (i.value) { const v = trocar(i.value); if (v !== i.value) i.value = v; } });
        const t = trocar(doc.title || ''); if (t !== doc.title) doc.title = t;
    });
    let ultimo = 0;
    const quadro = (agora) => {
        procurar(document);
        if (agora - ultimo > 100) { ultimo = agora; campos(); }
        requestAnimationFrame(quadro);
    };
    requestAnimationFrame(quadro);
    procurar(document);
})()""" % TROCAS

# Procura o que sobrou (texto visível de tudo)
CONFERIR = r"""() => {
    const textos = [];
    const varrer = (doc) => {
        textos.push(doc.body ? doc.body.innerText : '');
        doc.querySelectorAll('input, textarea').forEach(i => { if (i.type !== 'hidden' && i.offsetParent) textos.push(i.value || ''); });
        doc.querySelectorAll('iframe').forEach(f => { try { if (f.contentDocument && f.contentDocument.body) varrer(f.contentDocument); } catch (e) {} });
    };
    varrer(document);
    const tudo = textos.join('\n').toUpperCase();
    return %s.filter(x => tudo.includes(x));
}""" % PROCURAR


# Camadas do vídeo, num shadow DOM (o Dealer/Tema não entra nele: as cores ficam como estão aqui)
CAMADAS = r"""([icone]) => {
    if (window.__camadas) return;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    document.documentElement.appendChild(host);
    const raiz = host.attachShadow({ mode: 'open' });
    raiz.innerHTML = `<style>
        * { box-sizing: border-box; }
        .cursor { position: fixed; left: 0; top: 0; width: 22px; height: 30px; will-change: transform; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
        .clique { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
                  border: 3px solid rgba(237,28,43,.9); animation: clique .5s ease-out forwards; }
        @keyframes clique { from { transform: scale(.2); opacity: 1; } to { transform: scale(1.3); opacity: 0; } }
        .legenda { position: fixed; left: 50%; bottom: 74px; transform: translate(-50%, 16px); opacity: 0; max-width: 860px;
                   transition: opacity .35s, transform .35s; padding: 12px 22px 13px; border-radius: 10px;
                   background: rgba(3,26,92,.94); border-left: 6px solid #ed1c2b; color: #fff;
                   font-family: "Noto Sans", "Segoe UI", Arial, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.35); text-align: left; }
        .legenda.vis { opacity: 1; transform: translate(-50%, 0); }
        .legenda b { display: block; font-size: 24px; font-weight: 800; letter-spacing: -.2px; }
        .legenda span { display: block; font-size: 15px; margin-top: 3px; color: rgba(255,255,255,.85); }
        .teclas { position: fixed; left: 50%; top: 42%; transform: translate(-50%, -50%) scale(.9); opacity: 0;
                  transition: opacity .2s, transform .2s; display: flex; gap: 8px; align-items: center;
                  font-family: "Noto Sans", "Segoe UI", Arial, sans-serif; }
        .teclas.vis { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        .teclas kbd { font: 700 30px/1 "Noto Sans", "Segoe UI", Arial, sans-serif; color: #031a5c; background: #fff;
                      padding: 12px 18px; border-radius: 10px; border: 2px solid #c9d3e6; box-shadow: 0 5px 0 #9fb0cf, 0 12px 28px rgba(0,0,0,.35); }
        .teclas i { font-style: normal; font-size: 26px; font-weight: 800; color: #fff; text-shadow: 0 2px 6px rgba(0,0,0,.6); }
        .teclas em { font-style: normal; margin-left: 10px; font-size: 18px; font-weight: 700; color: #fff; padding: 8px 14px;
                     border-radius: 8px; background: rgba(3,26,92,.92); }
        .capa { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column;
                background: radial-gradient(120% 140% at 0% 0%, #0b2c86 0%, #031a5c 55%, #020f3a 100%); color: #fff;
                font-family: "Noto Sans", "Segoe UI", Arial, sans-serif; transition: opacity .8s; }
        .capa.oculta { opacity: 0; }
        .capa .titulo { display: flex; align-items: center; gap: 26px; }
        .capa img { width: 120px; height: 120px; border-radius: 18%; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
        .capa .nome { font-size: 76px; font-weight: 800; letter-spacing: -1px; }
        .capa .nome span { color: #6fa0dc; }
        .capa .onda { width: 360px; height: 6px; border-radius: 3px; margin: 26px 0;
                      background: linear-gradient(90deg, #ed1c2b, #ed1c2b 70%, rgba(237,28,43,0)); }
        .capa .lema { font-size: 30px; font-weight: 600; }
        .capa ul { list-style: none; padding: 0; margin: 18px 0 0; display: grid; grid-template-columns: auto auto; gap: 10px 46px; }
        .capa li { font-size: 21px; display: flex; align-items: center; color: rgba(255,255,255,.93); }
        .capa li::before { content: '\\2713'; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
                           margin-right: 12px; border-radius: 50%; background: #ed1c2b; font-size: 15px; font-weight: 800; }
        .capa .lojas { margin-top: 34px; font-size: 22px; font-weight: 700; }
        .capa .oficial { margin-top: 12px; font-size: 15px; color: rgba(255,255,255,.6); }
    </style>
    <div class="capa oculta"></div>
    <div class="legenda"><b></b><span></span></div>
    <div class="teclas"></div>
    <svg class="cursor" viewBox="0 0 22 30"><path d="M2 2 L2 24 L7.5 18.8 L11.4 27.4 L15 25.8 L11.2 17.4 L18.6 17.4 Z"
        fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    const $ = (s) => raiz.querySelector(s);
    const cursor = $('.cursor');
    window.__camadas = {
        cursor(x, y) { cursor.style.transform = `translate(${x - 2}px, ${y - 2}px)`; },
        cursorVisivel(v) { cursor.style.display = v ? '' : 'none'; },
        clique(x, y) {
            const c = document.createElement('div'); c.className = 'clique'; c.style.left = x + 'px'; c.style.top = y + 'px';
            raiz.appendChild(c); setTimeout(() => c.remove(), 600);
        },
        legenda(titulo, sub) {
            const l = $('.legenda');
            if (!titulo) { l.classList.remove('vis'); return; }
            l.querySelector('b').textContent = titulo; l.querySelector('span').textContent = sub || '';
            l.querySelector('span').style.display = sub ? '' : 'none';
            l.classList.add('vis');
        },
        teclas(lista, nota) {
            const t = $('.teclas');
            t.replaceChildren();
            lista.forEach((k, i) => {
                if (i) { const m = document.createElement('i'); m.textContent = '+'; t.append(m); }
                const kb = document.createElement('kbd'); kb.textContent = k; t.append(kb);
            });
            if (nota) { const e = document.createElement('em'); e.textContent = nota; t.append(e); }
            t.classList.add('vis');
            clearTimeout(t._fim); t._fim = setTimeout(() => t.classList.remove('vis'), 1400);
        },
        capa(tipo) {
            const c = $('.capa');
            if (!tipo) { c.classList.add('oculta'); return; }
            const titulo = `<div class="titulo"><img src="${icone}"><div class="nome">Dealer<span>/</span>Fluxo</div></div><div class="onda"></div>`;
            c.innerHTML = tipo === 'abertura'
                ? `${titulo}<div class="lema">Mais agilidade no DealerNet Workflow</div><div class="oficial">Extensão não oficial e gratuita</div>`
                : `${titulo}<ul><li>Barra de tarefas com as janelas</li><li>Atalhos de teclado</li><li>Aviso de novos fluxos</li>
                   <li>Avisos das telas em destaque</li><li>Busca nas listas</li><li>Temas de cores e botões</li></ul>
                   <div class="lojas">Chrome Web Store &nbsp;·&nbsp; Firefox Add-ons</div><div class="oficial">Extensão não oficial e gratuita</div>`;
            c.classList.remove('oculta');
        }
    };
}"""
