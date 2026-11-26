// Testes de "ataque": o que alguém de fora conseguiria fazer só com o endereço do servidor (e o código-fonte).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const URL_BASE = 'https://exemplo.workers.dev';
const enviar = (caminho, corpo, init = {}) =>
	SELF.fetch(URL_BASE + caminho, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
		...init,
	});
const linhas = async (tabela) => (await env.DB.prepare(`SELECT * FROM ${tabela}`).all()).results;
const PING = { versao: '1.2.1', navegador: 'chrome 142', dados: { tema: 'off' } };

beforeAll(async () => {
	await env.DB.exec('CREATE TABLE IF NOT EXISTS pings (dia TEXT NOT NULL, versao TEXT NOT NULL, navegador TEXT NOT NULL, dados TEXT NOT NULL)');
	await env.DB.exec(
		"CREATE TABLE IF NOT EXISTS semicone (arquivo TEXT NOT NULL, versao_tema TEXT NOT NULL, situacao TEXT NOT NULL, dica TEXT NOT NULL, tela TEXT NOT NULL, relatos INTEGER NOT NULL, primeiro_dia TEXT NOT NULL, ultimo_dia TEXT NOT NULL, PRIMARY KEY (arquivo, versao_tema))"
	);
});
beforeEach(async () => {
	await env.DB.exec('DELETE FROM pings');
	await env.DB.exec('DELETE FROM semicone');
});

describe('nenhum caminho devolve dados gravados', () => {
	for (const [metodo, caminho] of [
		['GET', '/'], ['GET', '/ping'], ['GET', '/semicone'], ['GET', '/pings'], ['GET', '/admin'], ['GET', '/../wrangler.jsonc'],
		['GET', '/privacidade/../ping'], ['PUT', '/ping'], ['DELETE', '/ping'], ['PATCH', '/semicone'], ['HEAD', '/ping'],
	]) {
		it(`${metodo} ${caminho}`, async () => {
			await enviar('/ping', PING);
			const r = await SELF.fetch(URL_BASE + caminho, { method: metodo });
			const texto = await r.text();
			expect([404, 200]).toContain(r.status);
			if (r.status === 200) expect(texto).toContain('política de privacidade');   // só a página pública
			expect(texto).not.toContain('chrome 142');
		});
	}
});

describe('injeção de SQL não passa (consultas com parâmetros)', () => {
	const injecoes = ["'); DROP TABLE pings; --", "1' OR '1'='1", 'x"; DELETE FROM semicone; --', '\u0000\u0007\u001b[31m'];
	it('/ping recusa navegador fora do formato e descarta campos com valores estranhos; as tabelas continuam lá', async () => {
		for (const inj of injecoes) {
			expect((await enviar('/ping', { ...PING, navegador: inj })).status).toBe(400);
			expect((await enviar('/ping', { ...PING, dados: { tema: inj, fonte: inj, sistema: inj } })).status).toBe(204);
		}
		const ps = await linhas('pings');
		expect(ps.length).toBe(injecoes.length);
		for (const p of ps) expect(JSON.parse(p.dados)).toEqual({ uso: {} });
		expect((await linhas('semicone')).length).toBe(0);   // a tabela existe (senão daria erro)
	});
	it('/semicone recusa nomes de arquivo e tela fora do padrão', async () => {
		for (const inj of injecoes) {
			const r = await enviar('/semicone', { versao: '1.2.1', versaoTema: '1.17.6', itens: [[inj, 'dica', 'tela.aspx', 'sem regra']] });
			expect(r.status).toBe(400);
			const r2 = await enviar('/semicone', { versao: '1.2.1', versaoTema: '1.17.6', itens: [['a.png', 'dica', inj, 'sem regra']] });
			expect(r2.status).toBe(400);
		}
		expect((await linhas('semicone')).length).toBe(0);
	});
});

describe('formatos estranhos não quebram o servidor', () => {
	const casos = [
		['vazio', ''], ['não é JSON', 'olá'], ['array', '[1,2,3]'], ['null', 'null'], ['número', '42'],
		['JSON aninhado fundo', '{"dados":' + '['.repeat(1500) + ']'.repeat(1500) + '}'],
		['versão inválida', JSON.stringify({ ...PING, versao: '1.2' })],
		['dia no futuro', JSON.stringify({ ...PING, dia: '2099-01-01' })],
		['dia muito antigo', JSON.stringify({ ...PING, dia: '2000-01-01' })],
		['dia inexistente', JSON.stringify({ ...PING, dia: '2026-02-30' })],
		['dados como texto', JSON.stringify({ ...PING, dados: 'x' })],
		['__proto__', '{"versao":"1.2.1","navegador":"x","dados":{"__proto__":{"admin":true}}}'],
	];
	for (const [nome, corpo] of casos) {
		it(nome, async () => {
			const r = await enviar('/ping', corpo);
			expect(r.status).toBeLessThan(500);
		});
	}
	it('corpo grande demais é recusado (413) sem gravar', async () => {
		const r = await enviar('/ping', { ...PING, dados: { lixo: 'x'.repeat(5000) } });
		expect(r.status).toBe(413);
		const r2 = await enviar('/semicone', 'x'.repeat(70000));
		expect(r2.status).toBe(413);
		expect((await linhas('pings')).length).toBe(0);
	});
	it('relatório com itens demais é recusado', async () => {
		const itens = Array.from({ length: 301 }, (_, i) => [`a${i}.png`, '', 't.aspx', 'sem regra']);
		const r = await enviar('/semicone', { versao: '1.2.1', versaoTema: '1.17.6', itens });
		expect(r.status).toBe(400);
	});
	it('as respostas não expõem detalhes internos (pilha de erro, versões)', async () => {
		const r = await enviar('/ping', 'olá');
		const texto = await r.text();
		expect(texto.length).toBeLessThan(40);
		expect(texto).not.toMatch(/at |Error|stack|wrangler|D1/i);
	});
});

describe('só o que a extensão manda é gravado', () => {
	it('campos desconhecidos, tipos errados e contadores estranhos são descartados', async () => {
		const dados = {
			sistema: 'windows', tela: '1920', dominio: 'padrao', alturaBarra: 32, tema: 'dracula', fonte: 'inter', tamanho: 110,
			imagens: true, versaoTema: '1.17.6', uso: { temaMenu: 3, hack: 9, fonteMenu: -1, temaConfig: 'x' },
			usuario: 'fulano', senha: '123', html: '<script>alert(1)</script>', lixo: 'x'.repeat(2000),
		};
		expect((await enviar('/ping', { ...PING, dados })).status).toBe(204);
		const [linha] = await linhas('pings');
		expect(JSON.parse(linha.dados)).toEqual({
			sistema: 'windows', tela: '1920', dominio: 'padrao', alturaBarra: 32, tema: 'dracula', fonte: 'inter', tamanho: 110,
			imagens: true, versaoTema: '1.17.6', uso: { temaMenu: 3 },
		});
	});
	it('valores fora da lista também são descartados', async () => {
		const dados = { sistema: 'amiga', tela: '800', dominio: 'empresa.com.br', alturaBarra: 32.5, tema: 'Tema Com Espaço', tamanho: 9999, imagens: 'sim' };
		expect((await enviar('/ping', { ...PING, dados })).status).toBe(204);
		expect(JSON.parse((await linhas('pings'))[0].dados)).toEqual({ uso: {} });
	});
	it('a dica das imagens perde caracteres de controle', async () => {
		const r = await enviar('/semicone', { versao: '1.2.1', versaoTema: '1.17.6', itens: [['a.png', 'Abrir\u001b menu\u0007', 't.aspx', 'sem regra']] });
		expect(r.status).toBe(204);
		expect((await linhas('semicone'))[0].dica).toBe('Abrir menu');
	});
});

describe('limite de gravações por minuto', () => {
	it('passado o limite, responde 503 (a extensão tenta de novo depois) e não grava', async () => {
		let ocupado = 0;
		for (let i = 0; i < 70; i++) {
			const r = await enviar('/ping', PING);
			if (r.status === 503) {
				ocupado++;
				expect(r.headers.get('Retry-After')).toBe('3600');
			} else {
				expect(r.status).toBe(204);
			}
		}
		expect(ocupado).toBeGreaterThan(0);
		expect((await linhas('pings')).length).toBe(70 - ocupado);
	});
});
