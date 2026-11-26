/**
 * Dealer/Fluxo: endpoints da telemetria. Nada aqui lê o IP (cabeçalho CF-Connecting-IP) nem request.cf
 * (localização): só o corpo das requisições é gravado, e os logs da Cloudflare estão desligados.
 *
 * POST /ping      ping diário de uso, sem identificador (uma vez por dia por instalação)
 *   {"dia": "2026-11-23", "versao": "3.12.0", "navegador": "chrome 131", "dados": { ... }}
 *   "dia" (opcional) é o dia a que os dados se referem: de hoje até 30 dias atrás (horário de Brasília).
 * POST /semicone  imagens que o tema ainda não troca (opt-in), somadas por imagem e versão do tema
 *   {"versao": "3.12.0", "versaoTema": "1.16.0", "itens": [["arquivo.png", "dica", "tela.aspx", "sem regra"], ...]}
 * GET  /privacidade  política de privacidade (HTML)
 *
 * Respostas: 204 gravado, 400 formato inválido, 413 grande demais, 404 outro caminho ou método,
 * 503 limite de envios do minuto atingido (a extensão tenta de novo na hora seguinte; 4xx ela descarta).
 *
 * Proteções: só os campos e valores que a extensão manda são gravados (o resto é descartado); navegador e versão
 * com formato fixo; tamanho máximo do corpo; limite de gravações por minuto (binding LIMITE, contador geral, sem
 * usar o IP de ninguém); consultas sempre com parâmetros; nenhum caminho devolve dados gravados.
 */
const LIMITE_PING = 4096;
const LIMITE_SEMICONE = 65536;
const MAX_ITENS_SEMICONE = 300;
const DIAS_ATRAS = 30;
const SITUACOES = new Set(['sem regra', 'rótulo deduzido']);
const CORS = {
	'Access-Control-Allow-Origin': '*', // no Firefox a origem da extensão é aleatória por instalação
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Access-Control-Max-Age': '86400',
};
const resposta = (status, texto = null) => new Response(texto, { status, headers: CORS });
const VERSAO = /^\d+\.\d+\.\d+$/;
// Os mesmos valores que a extensão manda (extensao/src/background.js: navegador(), sistema(), dadosPermitidos())
const NAVEGADOR = /^(?:(?:chrome|edge|firefox|opera) \d{1,4}|outro)$/;
const SISTEMAS = new Set(['windows', 'chromeos', 'macos', 'linux', 'outro']);
const TELAS = new Set(['1366', '1600', '1920', 'maior']);
const CONTADORES = new Set(['temaMenu', 'fonteMenu', 'temaConfig', 'fonteConfig']);
const ID_SIMPLES = /^[a-z0-9-]{1,40}$/;
const inteiro = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

// Só os campos combinados, com valores conferidos; o que vier a mais (ou fora do formato) é descartado
export function dadosLimpos(d) {
	const r = {};
	if (SISTEMAS.has(d.sistema)) r.sistema = d.sistema;
	if (TELAS.has(d.tela)) r.tela = d.tela;
	if (d.dominio === 'padrao' || d.dominio === 'outro') r.dominio = d.dominio;
	if (inteiro(d.alturaBarra, 10, 200)) r.alturaBarra = d.alturaBarra;
	if (typeof d.tema === 'string' && ID_SIMPLES.test(d.tema)) r.tema = d.tema;
	if (typeof d.fonte === 'string' && ID_SIMPLES.test(d.fonte)) r.fonte = d.fonte;
	if (inteiro(d.tamanho, 50, 300)) r.tamanho = d.tamanho;
	if (typeof d.imagens === 'boolean') r.imagens = d.imagens;
	if (typeof d.versaoTema === 'string' && VERSAO.test(d.versaoTema)) r.versaoTema = d.versaoTema;
	const uso = {};
	if (d.uso && typeof d.uso === 'object' && !Array.isArray(d.uso)) {
		for (const nome of CONTADORES) if (inteiro(d.uso[nome], 1, 100000)) uso[nome] = d.uso[nome];
	}
	r.uso = uso;
	return r;
}

// Limite geral de gravações por minuto (por local da Cloudflare). A chave é fixa: o IP não é lido.
async function dentroDoLimite(env) {
	if (!env.LIMITE) return true;                   // sem o binding (ex.: testes antigos): sem limite
	try {
		return (await env.LIMITE.limit({ key: 'gravacoes' })).success;
	} catch {
		return true;                                    // o limitador falhou: não perde o envio
	}
}
const ocupado = () => new Response('busy', { status: 503, headers: { ...CORS, 'Retry-After': '3600' } });

// Dia no horário de Brasília (UTC-3; sem horário de verão desde 2019)
export const diaBrasilia = (agora = Date.now()) => new Date(agora - 3 * 3600e3).toISOString().slice(0, 10);

// Dia informado pela extensão: AAAA-MM-DD válido, entre DIAS_ATRAS dias atrás e hoje
export function diaValido(dia, agora = Date.now()) {
	if (typeof dia !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) return false;
	const t = Date.parse(dia + 'T00:00:00Z');
	if (isNaN(t) || new Date(t).toISOString().slice(0, 10) !== dia) return false;
	return dia <= diaBrasilia(agora) && dia >= diaBrasilia(agora - DIAS_ATRAS * 864e5);
}

// Dica da imagem: só textos curtos e sem números (números podem ser datas, códigos, documentos)
export const dicaSegura = (dica) => {
	const t = String(dica || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
	return t.length <= 60 && !/\d/.test(t) ? t : '';
};

async function lerJson(request, limite) {
	const texto = await request.text();
	if (texto.length > limite) return { erro: resposta(413, 'too large') };
	try {
		const corpo = JSON.parse(texto);
		return corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? { corpo } : { erro: resposta(400, 'bad json') };
	} catch {
		return { erro: resposta(400, 'bad json') };
	}
}

async function ping(request, env) {
	const { corpo, erro } = await lerJson(request, LIMITE_PING);
	if (erro) return erro;
	const versao = String(corpo.versao || '');
	const navegador = String(corpo.navegador || '');
	const dados = corpo.dados && typeof corpo.dados === 'object' && !Array.isArray(corpo.dados) ? dadosLimpos(corpo.dados) : null;
	const dia = corpo.dia === undefined ? diaBrasilia() : corpo.dia;
	if (!VERSAO.test(versao) || !NAVEGADOR.test(navegador) || !dados || !diaValido(dia)) return resposta(400, 'bad ping');
	if (!(await dentroDoLimite(env))) return ocupado();
	await env.DB.prepare('INSERT INTO pings (dia, versao, navegador, dados) VALUES (?, ?, ?, ?)')
		.bind(dia, versao, navegador, JSON.stringify(dados))
		.run();
	return resposta(204);
}

async function semIcone(request, env) {
	const { corpo, erro } = await lerJson(request, LIMITE_SEMICONE);
	if (erro) return erro;
	const versaoTema = String(corpo.versaoTema || '');
	const itens = Array.isArray(corpo.itens) ? corpo.itens : null;
	if (!VERSAO.test(String(corpo.versao || '')) || !VERSAO.test(versaoTema) || !itens || !itens.length || itens.length > MAX_ITENS_SEMICONE) {
		return resposta(400, 'bad report');
	}
	const hoje = diaBrasilia();
	const vistos = new Set();
	const comandos = [];
	for (const item of itens) {
		if (!Array.isArray(item)) return resposta(400, 'bad item');
		const [arquivo, dica, tela, situacao] = item.slice(0, 4).map((x) => String(x ?? ''));
		if (!/^[\w.\-]{1,100}$/.test(arquivo) || !/^[\w.\-]{0,100}$/.test(tela) || !SITUACOES.has(situacao)) return resposta(400, 'bad item');
		if (vistos.has(arquivo.toLowerCase())) continue; // a mesma imagem duas vezes no mesmo relatório conta uma
		vistos.add(arquivo.toLowerCase());
		comandos.push(
			env.DB.prepare(
				`INSERT INTO semicone (arquivo, versao_tema, situacao, dica, tela, relatos, primeiro_dia, ultimo_dia)
				 VALUES (?, ?, ?, ?, ?, 1, ?, ?)
				 ON CONFLICT (arquivo, versao_tema) DO UPDATE SET
				   relatos = relatos + 1, ultimo_dia = excluded.ultimo_dia, situacao = excluded.situacao, tela = excluded.tela,
				   dica = CASE WHEN semicone.dica = '' THEN excluded.dica ELSE semicone.dica END`
			).bind(arquivo, versaoTema, situacao, dicaSegura(dica), tela, hoje, hoje)
		);
	}
	if (!(await dentroDoLimite(env))) return ocupado();
	await env.DB.batch(comandos);
	return resposta(204);
}

export const PAGINA_PRIVACIDADE = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dealer/Fluxo: privacidade</title>
<style>
body{font:15px/1.55 system-ui,"Segoe UI",Roboto,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#1f2328;background:#fff}
h1{font-size:24px}h2{font-size:18px;margin-top:28px}code{background:#f3f4f6;padding:1px 4px;border-radius:4px}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}code{background:#21262d}}
</style></head><body>
<h1>Dealer/Fluxo: política de privacidade</h1>
<p>O Dealer/Fluxo é uma extensão não oficial para o DealerNet Workflow. Ela pode enviar estatísticas de uso
<b>anônimas</b> para este endereço, para saber quantas pessoas usam a extensão, em quais navegadores, e como o
tema de cores é usado. Nada é vendido nem compartilhado com terceiros.</p>

<h2>O que é enviado (no máximo uma vez por dia)</h2>
<ul>
<li>Versão da extensão, navegador e versão principal dele (ex.: "chrome 131"), sistema operacional (Windows, Linux, macOS).</li>
<li>Largura da tela em faixas (até 1366, cerca de 1600, cerca de 1920, maior).</li>
<li>Se o DealerNet está no endereço padrão (<code>dealernetworkflow.com.br</code>) ou em outro (só isso, nunca o endereço).</li>
<li>Algumas configurações: altura da barra, tema de cores, fonte e tamanho do texto escolhidos, e quantas vezes
o tema e a fonte foram trocados pelos menus da engrenagem.</li>
<li>O dia a que os dados se referem.</li>
</ul>

<h2>Opcional: imagens sem ícone</h2>
<p>Só se você marcar a opção na aba Tema: a lista das imagens do DealerNet que o tema ainda não sabe trocar
(nome do arquivo da imagem, o texto da dica dela quando é curto e sem números, o nome da página onde apareceu,
e a versão do tema). Serve para completar os ícones do tema. Os relatos são somados por imagem.</p>

<h2>Fontes do tema (opcional)</h2>
<p>Se você escolher uma fonte "da internet" na aba Tema, o navegador a baixa uma vez do Bunny Fonts
(<code>fonts.bunny.net</code>) ou, se ele falhar, do Google Fonts (<code>fonts.googleapis.com</code>), e a guarda
para as próximas vezes. Esses serviços recebem só o pedido da fonte (e, como qualquer site, o endereço IP de quem
pede); nenhum dado do DealerNet ou do Dealer/Fluxo vai junto. Com a fonte "Original do site" ou uma fonte do
sistema, nada é baixado.</p>

<h2>O que nunca é enviado</h2>
<ul>
<li>Nenhum identificador: não há como saber que dois envios vieram da mesma pessoa.</li>
<li>Usuário, senha, nome, empresa, endereço do DealerNet, conteúdo das telas, mensagens, buscas, números de registros.</li>
<li>Endereço IP: o servidor não grava o IP nem a localização, e os registros de acesso estão desligados.</li>
</ul>

<h2>Como desligar</h2>
<p>Na engrenagem do Dealer/Fluxo, em <b>Configurações &gt; Privacidade</b>. Desligado, nada mais é enviado e os
dados ainda não enviados são apagados. No Firefox, também dá para desligar em <code>about:addons</code>, nas
permissões da extensão. Empresas podem desligar para todos por política do navegador
(<code>telemetria: false</code> nas configurações gerenciadas da extensão).</p>

<h2>Onde fica e por quanto tempo</h2>
<p>Os dados ficam num banco de dados da Cloudflare (Cloudflare Workers e D1), acessível só ao desenvolvedor, e são
guardados por até 2 anos. Dúvidas: pelo contato do desenvolvedor na página da extensão na loja.</p>
</body></html>`;

export default {
	async fetch(request, env) {
		if (request.method === 'OPTIONS') return resposta(204);
		const caminho = new URL(request.url).pathname;
		if (request.method === 'GET' && caminho === '/privacidade') {
			return new Response(PAGINA_PRIVACIDADE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
		}
		if (request.method === 'POST' && caminho === '/ping') return ping(request, env);
		if (request.method === 'POST' && caminho === '/semicone') return semIcone(request, env);
		return resposta(404, 'not found');
	},
};
