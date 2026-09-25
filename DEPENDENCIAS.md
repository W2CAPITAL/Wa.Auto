# Dependências e referências

O WA.Auto Cloud usa uma arquitetura sem navegador automatizado no backend.

| Dependência | Uso |
| --- | --- |
| `@whiskeysockets/baileys 6.7.24` | WhatsApp Web via WebSocket, QR Code, pareamento, consulta de número e envio |
| `ExcelJS 4.4.0` | Leitura de arquivos .xlsx |
| `csv-parse 7.0.2` | Leitura de CSV |
| `Express 5.2.1` | API HTTP e frontend |
| `Multer 2.4.0` | Upload da planilha em memória |
| `qrcode 1.5.4` | Conversão do QR recebido em imagem |
| Node.js 22 | Runtime do serviço e SQLite nativo |
| Supabase | Persistência remota do estado/sessão |
| Render | Runtime cloud de longa duração |

## O que foi removido

A versão cloud não usa:

- `whatsapp-web.js`;
- Puppeteer em produção;
- Chrome/Chromium em produção;
- LocalAuth;
- servidor em `127.0.0.1`;
- executável/inicializador Windows;
- comunicação do Vercel com localhost.

Puppeteer é instalado apenas temporariamente pelo GitHub Actions para screenshots e testes visuais da interface; não integra o runtime de produção.

## WhatsApp

Baileys é uma implementação **não oficial** do protocolo Web do WhatsApp. Ela permite uma sessão multi-device sem abrir um navegador completo, o que reduz fortemente memória e CPU para hospedagem cloud.

A sessão é mantida em arquivos de autenticação na instância e incluída no snapshot protegido armazenado no Supabase. Se a sessão for revogada pelo próprio WhatsApp, o WA.Auto exige novo QR Code.

Nenhuma biblioteca não oficial garante estabilidade futura ou proteção contra bloqueios. O sistema não implementa técnicas de evasão de limites.

## Persistência

A instância usa SQLite como cache transacional e salva snapshots comprimidos no Supabase. O acesso ao snapshot exige:

1. chave publishable/anon do projeto; e
2. segredo adicional `WA_DB_SECRET`.

O banco guarda somente o hash SHA-256 desse segundo segredo e aplica RLS para impedir acesso ao payload quando o cabeçalho correto não está presente.

## Referências principais

- Baileys: https://github.com/WhiskeySockets/Baileys
- ExcelJS: https://github.com/exceljs/exceljs
- csv-parse: https://csv.js.org/parse/
- Render: https://render.com/docs
- Supabase: https://supabase.com/docs

Os links de projetos de automação fornecidos como referência serviram para comparação de fluxos. O WA.Auto não incorpora servidores comerciais ou credenciais de terceiros desses projetos.
