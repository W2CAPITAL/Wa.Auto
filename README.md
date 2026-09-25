# WA.Auto

**Planilha → mensagem personalizada → WhatsApp.** Aplicativo gratuito que roda no seu computador, conecta seu número por QR Code e envia mensagens a clientes, uma por vez, com histórico persistente.

Não exige CNPJ, cadastro de empresa na Meta, API paga, chave de IA ou mensalidade. **O computador precisa ficar ligado e com internet durante os envios.** Não é um serviço hospedado 24 horas.

## Começar no Windows

### Opção recomendada: pacote portátil

A automação do GitHub gera o artefato **WA.Auto-Windows**. Ele já contém o runtime Node e as dependências usadas pelo motor local.

1. Baixe **WA.Auto-Windows** na execução mais recente de **Actions → Verificar WA.Auto**.
2. Extraia todo o ZIP para uma pasta normal. Não execute de dentro do ZIP.
3. Abra **`INICIAR-WA.AUTO.cmd`**.
4. O motor é testado em **http://127.0.0.1:3210** e o painel local abre automaticamente.
5. Conecte pelo **QR Code**. Se preferir ou se o QR falhar, informe seu telefone com DDD e use **Gerar código de pareamento**; no celular, escolha **Aparelhos conectados → Conectar aparelho → Conectar com número de telefone**.
6. Importe sua planilha, escolha a coluna de telefone, escreva a mensagem e clique em **Revisar destinatários**.
7. Use **Enviar um teste para mim** antes da campanha completa.
8. Salve a campanha, confirme a revisão e clique em **Iniciar envios**.

### Opção pelo código-fonte

Baixe este repositório em **Code → Download ZIP**, extraia e execute **`INICIAR-WINDOWS.cmd`**. Se o Node 24 não estiver instalado, o próprio inicializador baixa uma cópia portátil oficial do Node. Em seguida ele instala as dependências e inicia o motor.

O endereço **https://whatsappautomat.vercel.app** é apenas o painel hospedado. O QR Code, a sessão do WhatsApp, o SQLite e os envios continuam no motor do seu PC. Se `127.0.0.1:3210/api/bootstrap` estiver recusando conexão, o motor não está rodando; execute um dos inicializadores acima.

O primeiro teste real depende de conectar a sua conta. Nenhuma mensagem é disparada apenas por importar a planilha, salvar um rascunho, abrir a página ou reiniciar o aplicativo.

## Instalação pelo terminal

```sh
git clone https://github.com/W2CAPITAL/Wa.Auto.git
cd Wa.Auto
npm ci
npm start
```

Abra **http://127.0.0.1:3210** no mesmo computador. Node 24 inclui SQLite; não é necessário instalar Python, banco de dados separado ou serviço em nuvem. No Linux, o Chromium também precisa das bibliotecas de sistema descritas na [documentação do Puppeteer](https://pptr.dev/troubleshooting). Execute com um usuário normal; o aplicativo não desativa a sandbox do navegador.

## O que está implementado

- Excel `.xlsx` e CSV com vírgula, ponto e vírgula ou tabulação, incluindo acentos e campos com quebra de linha.
- Seleção entre as abas e reconhecimento das colunas `Telefone` e `Cliente`.
- Cabeçalho abaixo de um título, nomes de colunas repetidos e datas do Excel.
- Filtro por coluna e valor, além de seleção individual na revisão.
- Código do país, DDD brasileiro e números internacionais com `+`.
- Personalização com **qualquer coluna**, por exemplo `{{Cliente}}`, `{{Protocolo}}` e `{{Escritorio}}`.
- Exclusão de vazios, formatos inválidos, telefones repetidos e dados ausentes exigidos na mensagem.
- Respeito a “NÃO FALAR”, “NÃO CONTATAR” e colunas de bloqueio na planilha, inclusive se outra linha do mesmo telefone contém a indicação.
- Coluna de autorização opcional: quando escolhida, apenas linhas com `sim`, `1`, `true`, `autorizado` ou equivalentes entram.
- Conexão real por QR Code **ou código de pareamento por telefone**, com sessão salva localmente.
- Consulta ao WhatsApp para verificar se o número está registrado, antes do envio.
- Uma campanha ativa por vez, intervalo configurável, pausa, continuação e cancelamento.
- Banco SQLite com mensagens congeladas por campanha e recuperação após reiniciar.
- Confirmações de envio, entrega e leitura, quando fornecidas pelo WhatsApp.
- Lista de não contatar e reconhecimento de SAIR, PARAR, STOP e pedidos equivalentes recebidos enquanto o app está conectado.
- Relatório CSV com resultado por linha. A planilha de origem não é alterada.
- Interface adaptável a telas menores, sem fonte externa ou CDN obrigatório.

## Exemplo de mensagem

```text
Olá, {{Cliente}}! Tudo bem?

Entramos em contato para acompanhar seu atendimento.
Podemos conversar por aqui?

Se preferir não receber mensagens, responda SAIR.
```

Use o botão de cada coluna para inserir o campo. A revisão exibe o texto exato para cada cliente. Se o texto usa uma coluna vazia naquela linha, ela fica fora do envio até ser corrigida na planilha. Não há IA alterando informações ou inventando atualizações de processos.

## Planilhas e telefones

O arquivo pode ter até **15 MB, 60 abas, 10.000 linhas de dados por aba e 150 colunas**. Arquivos `.xls` antigos devem ser salvos como `.xlsx`. Arquivos protegidos por senha não são suportados. Fórmulas não são executadas; o app utiliza o resultado salvo pelo Excel, quando disponível.

Um telefone por célula. Para Brasil, use DDD + número ou +55 + DDD + número. Para outros países, prefira sempre `+` seguido do país e número. O aplicativo **não inventa DDD nem acrescenta automaticamente o nono dígito**. Células com múltiplos números, textos, ramais ou valores incompletos precisam de correção.

Telefones repetidos são excluídos dentro da mesma campanha; a primeira linha válida selecionada é usada. O identificador devolvido pelo WhatsApp também é conferido para não repetir a mesma conta em formatos diferentes. **Uma nova campanha pode enviar novamente para o mesmo cliente.** Confira o histórico antes de começar outra campanha.

A pasta `public/modelo.csv` contém somente uma linha de exemplo com telefone vazio. Não há lista de clientes ou contatos reais neste repositório.

## Entrega, pausa e recuperação

| Estado | Significado |
| --- | --- |
| Pronta para enviar | Aguardando início da campanha ou próximo intervalo. |
| Conferindo número | Consultando o número no WhatsApp. |
| Enviando | A tentativa foi registrada; o WhatsApp ainda não respondeu. |
| Enviada | O cliente WhatsApp retornou o identificador da mensagem. Não comprova entrega ao destinatário. |
| Entregue / Lida | Confirmação recebida do WhatsApp. A leitura pode estar desativada pelo cliente. |
| Conferir no WhatsApp | A conexão ou o programa falhou durante a tentativa. Pode ter chegado: confira a conversa. Não há reenvio automático. |
| Falha de entrega | O WhatsApp informou erro após registrar a mensagem. Não há repetição automática. |

Pausar ou cancelar impede as próximas mensagens. Uma operação que já começou pode concluir. Se a conexão cair, a campanha pausa e exige **Continuar envios** depois de reconectar. Se o processo fechar durante um envio, essa linha volta como **Conferir no WhatsApp**. As linhas já enviadas são preservadas.

Fechar só a aba do navegador não para o programa. Fechar a janela de terminal, desligar ou suspender o computador interrompe a execução. Ao reabrir, confirme a conexão e retome a campanha. O app não recupera automaticamente todos os pedidos de saída que possam ter ocorrido enquanto estava desconectado; mantenha a lista atualizada.

## Dados e acesso

O aplicativo atende apenas em `127.0.0.1`, no seu computador. A pasta `data/` contém o banco, histórico, últimas cinco importações, preferências de não contatar, sessão do WhatsApp e cache. Faça backup dessa pasta com o programa fechado. Não compartilhe os arquivos de sessão. A pasta é ignorada pelo Git.

O banco não é criptografado pelo aplicativo; proteja sua conta de usuário no computador. A interface inclui verificação de origem, token para operações, bloqueio de hosts externos e proteção contra executar conteúdo da planilha como HTML ou fórmulas no relatório.

## Configuração opcional

Crie um `.env` na raiz somente se precisar alterar os padrões:

```dotenv
PORT=3210
# WA_DATA_DIR=C:/WA-Auto/dados
# CHROME_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe\n# WA_AUTO_CONNECT=1
```

No Windows, o app tenta encontrar Chrome ou Edge instalados. Se não encontrar, utiliza o navegador baixado pelo Puppeteer. `CHROME_PATH` e `PUPPETEER_EXECUTABLE_PATH` podem indicar um executável específico.

## Custos e limites da integração

O código usa [whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js), com [LocalAuth](https://wwebjs.dev/guide/creating-your-bot/authentication.html). Não há cobrança por mensagem pelo WA.Auto nem dependência de uma API comercial. Internet, energia e o próprio computador continuam necessários.

**Esta conexão não é uma API oficial da Meta.** Pode parar após mudanças do WhatsApp, exigir novo QR Code ou resultar em bloqueio da conta. Nenhum intervalo ou biblioteca “antiban” garante proteção. Envie somente a clientes que esperam o contato e respeite pedidos de saída. O intervalo organiza a fila; não é uma técnica para burlar limites.

Esta versão envia texto. Não inclui anexos, respostas por IA, disparo para grupos ou hospedagem contínua. Não funciona apenas publicando o frontend no Vercel: o navegador conectado e o banco precisam permanecer em execução na mesma máquina.

## Verificação e desenvolvimento

```sh
npm run verify
```

Os testes cobrem XLSX/CSV, telefones, variáveis, seleção, duplicados, bloqueios, API, pausa, cancelamento, concorrência, retomada, queda de conexão e confirmações de entrega. Utilizam um transporte isolado em `tests/`; nunca conectam uma conta nem enviam mensagens reais. A produção utiliza exclusivamente `src/whatsapp.js`.

| Diretório | Responsabilidade |
| --- | --- |
| `src/importer.js`, `phone.js`, `template.js` | Importação, validação e mensagem personalizada. |
| `src/store.js`, `campaigns.js`, `queue.js` | Persistência, campanhas e controle dos envios. |
| `src/whatsapp.js` | Sessão, QR Code, envio real e eventos do WhatsApp. |
| `src/app.js`, `server.js` | API local e inicialização. |
| `public/` | Interface, estilos e modelo CSV. |
| `tests/` | Testes automatizados sem comunicação externa. |

Veja [DEPENDENCIAS.md](DEPENDENCIAS.md) para referências e limitações das dependências.
