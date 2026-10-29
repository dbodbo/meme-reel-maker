# Meme Reel Maker

Interface web local para transformar um vídeo em **Reel (9:16, 1080×1920)** com um template por cima, textos e barras. Tudo roda no seu computador: o vídeo não é enviado para nenhum serviço.

## O que faz

- **Baixa o vídeo pelo link** (Instagram, TikTok, YouTube, Facebook e X) usando o `yt-dlp`.
- **Enquadra** o vídeo no formato Reel: arrastar, zoom, ajustar largura, preencher, centralizar e cor de fundo.
- **Corta o tempo** (início e fim).
- **Camadas de texto** com fontes de meme (Anton, Bebas Neue, Montserrat ExtraBold, Inter Bold), contorno e posição livre.
- **Barras** para tampar partes do vídeo (legendas antigas, marcas d'água), por cima do vídeo e por baixo do template.
- **Template** (cabeçalho com foto, nome, @usuário e selo de verificado) por cima do vídeo.
- **Criar template**: aba para montar o seu cabeçalho e baixar o PNG.
- **Exporta** um MP4 H.264 + AAC, 1080×1920, 30 fps.
- Salva sozinho suas posições, textos, barras e enquadramento.

## Requisitos

- [Node.js](https://nodejs.org) 20 ou mais novo
- [ffmpeg](https://ffmpeg.org) no `PATH`
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (só para baixar vídeos por link)

No Ubuntu/Debian:

```bash
sudo apt install ffmpeg pipx
pipx install yt-dlp
```

## Instalação e uso

```bash
git clone https://github.com/dbodbo/meme-reel-maker.git
cd meme-reel-maker
npm install
npm start
```

Abra `http://localhost:3000`. Para usar outra porta: `PORT=4000 npm start`.

Depois de atualizar o código, pare o programa com `Ctrl+C` e rode `npm start` de novo.

## Fazendo um Reel

1. Na aba **Editor**, cole o link e clique em **Baixar**, ou use **Escolher vídeo** / arraste um arquivo.
2. Arraste o vídeo no preview e use o zoom para enquadrar.
3. (Opcional) Corte o tempo com **Início = atual** e **Fim = atual**.
4. (Opcional) **+ Texto** e **+ Barra**.
5. **Exportar Reel (MP4)**. O arquivo baixa no navegador e uma cópia fica em `output/`.

Há um tutorial dentro do programa, na aba **Tutorial**.

## Template

O programa já vem com um template padrão (círculo cinza, "Seu Nome", "@seuusuario"). Para o seu:

1. Abra a aba **Criar template**.
2. Escolha a foto, edite nome e usuário e marque ou desmarque o selo de verificado.
3. **Usar no editor** salva como `Template_Reel.png` na pasta do projeto, e o editor passa a usar esse arquivo. O anterior fica em `data/backups/`. **Baixar PNG** só baixa o arquivo.

Se você tiver um `Template_Reel.psd` na pasta do projeto, a aba usa as posições, o tamanho e a cor dos textos dele (camadas `name`, `user`, `Verificado` e `Profile`; PSD RGB de 8 bits). Sem o PSD, vale o layout de `assets/layout.json`.

`Template_Reel.png` e `Template_Reel.psd` estão no `.gitignore`, então o seu template pessoal não vai para o GitHub.

Você também pode usar um PNG 1080×1920 transparente feito em qualquer editor: salve como `Template_Reel.png` na pasta do projeto.

## Baixando do Instagram (login)

TikTok, YouTube e outros costumam baixar sem login. **O Instagram quase sempre exige**. Escolha em **Login (Instagram)** o navegador em que você está logado (Chrome, Firefox, Brave, Edge, Chromium). O `yt-dlp` lê os cookies dele só no seu computador.

Se der erro:

| Problema | Solução |
| --- | --- |
| Mensagem sobre `secretstorage` | `pipx inject yt-dlp secretstorage` |
| "Failed to parse JSON" ou resposta vazia | Atualize: `pipx install --force --pip-args="--pre" yt-dlp` e tente depois de alguns minutos |
| O chaveiro do Linux não é encontrado (comum no Chrome/Brave) | Use o `cookies.txt` (abaixo) |

**Usando o `cookies.txt`:** no navegador, com o Instagram aberto e logado, exporte os cookies com uma extensão como "Get cookies.txt LOCALLY" e salve como `cookies.txt` na pasta do projeto. Se o arquivo existir, ele tem prioridade sobre o seletor de login.

> ⚠️ **O `cookies.txt` dá acesso à sua conta.** Nunca compartilhe, nunca faça commit (ele já está no `.gitignore`) e, se possível, use uma conta secundária. Se vazar, saia da conta no Instagram para invalidar a sessão.

Baixe só conteúdo que você tem direito de usar e respeite os termos de cada plataforma.

## Variáveis de ambiente

| Variável | Para quê |
| --- | --- |
| `PORT` | Porta do servidor (padrão `3000`) |
| `HOST` | Endereço em que escuta (padrão `127.0.0.1`, só a sua máquina) |
| `YTDLP` | Caminho do `yt-dlp`, se não estiver no `PATH` |
| `YTDLP_COOKIES_BROWSER` | Navegador padrão para o login (ex.: `chrome`) |

## Estrutura

```
server.js        servidor (Express): configurações, download, render com ffmpeg, template
psd.js           leitor mínimo de PSD usado pela aba "Criar template"
public/          interface (index.html, app.js, template.js, tabs.js, style.css)
assets/          template e layout padrão
data/            suas configurações, foto do template e backups (não vai para o Git)
downloads/       vídeos baixados por link (não vai para o Git)
output/          Reels exportados (não vai para o Git)
```

## Segurança

O servidor foi feito para uso **local**. Não o exponha na internet: ele não tem login e executa `ffmpeg` e `yt-dlp` no seu computador.
