-- Uma linha por instalação por dia (sem nenhum identificador)
CREATE TABLE IF NOT EXISTS pings (
  dia       TEXT NOT NULL,   -- AAAA-MM-DD (horário de Brasília)
  versao    TEXT NOT NULL,   -- versão da extensão
  navegador TEXT NOT NULL,   -- ex.: "chrome 131", "firefox 140"
  dados     TEXT NOT NULL    -- JSON com os contadores e configurações do dia
);
CREATE INDEX IF NOT EXISTS pings_dia ON pings (dia);

-- Imagens que o tema ainda não troca (opt-in): uma linha por imagem e versão do tema, só com a contagem.
-- Cada instalação reporta cada imagem uma vez por versão do tema.
CREATE TABLE IF NOT EXISTS semicone (
  arquivo       TEXT NOT NULL,   -- nome do arquivo da imagem (ex.: btnParametroGeral.png)
  versao_tema   TEXT NOT NULL,   -- versão do Dealer/Tema que não tinha ícone para ela
  situacao      TEXT NOT NULL,   -- 'sem regra' (falta tudo) ou 'rótulo deduzido' (falta o ícone certo)
  dica          TEXT NOT NULL,   -- texto da dica da imagem (vazio se tinha números ou era longo)
  tela          TEXT NOT NULL,   -- página onde foi vista (ex.: empresa.aspx)
  relatos       INTEGER NOT NULL,
  primeiro_dia  TEXT NOT NULL,
  ultimo_dia    TEXT NOT NULL,
  PRIMARY KEY (arquivo, versao_tema)
);
