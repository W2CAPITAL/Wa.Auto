# Dependências e referências

O WA.Auto foi implementado neste repositório. A integração de envio usa a biblioteca abaixo; não combina servidores de múltiplos projetos nem inclui APIs comerciais dos links de referência.

| Dependência | Uso | Licença informada pelo pacote |
| --- | --- | --- |
| whatsapp-web.js 1.34.7 | Conexão com WhatsApp Web, QR Code, LocalAuth e envio | Apache-2.0 |
| ExcelJS 4.4.0 | Leitura de .xlsx | MIT |
| csv-parse 7.0.2 | Leitura de CSV | MIT |
| Express 5.2.1 | Servidor HTTP local | MIT |
| Multer 2.4.0 | Upload da planilha em memória | MIT |
| qrcode 1.5.4 | Exibição do QR Code recebido | MIT |

As licenças e avisos originais são distribuídos nos respectivos pacotes instalados. O lockfile fixa a árvore de instalação.

Referências primárias utilizadas:

- https://github.com/wwebjs/whatsapp-web.js
- https://docs.wwebjs.dev/Client.html
- https://wwebjs.dev/guide/creating-your-bot/authentication.html
- https://github.com/exceljs/exceljs
- https://github.com/VianaArthur/whatsapp-automation — referência do fluxo planilha → mensagem; código não incorporado.

## Auditoria das dependências

Em 25/09/2026, `npm audit --omit=dev` apontou avisos transitivos em `extract-zip` (cadeia Puppeteer/whatsapp-web.js) e `uuid` (ExcelJS). Não se deve aplicar o downgrade sugerido pelo audit sem conferir a compatibilidade da conexão.

`extract-zip` é usado para instalar o navegador obtido pelo Puppeteer, não para interpretar os uploads de planilha do aplicativo. A versão publicada consultada foi 2.0.1 e ainda continha os avisos GHSA-jmr9-qjv8-65gv e GHSA-7pqw-9j4j-h8q3. Não forneça arquivos de navegador de terceiros. Revise atualizações upstream antes de expor ou empacotar o sistema para outras pessoas.

A leitura de planilha é feita pelo ExcelJS. O aplicativo não expõe acesso pela rede e não executa fórmulas. Isso limita a exposição, sem significar ausência de vulnerabilidades nas dependências.
