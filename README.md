# WA.Auto Cloud

**Excel/CSV → revisão → WhatsApp → fila de envio · DataJud/DJEN → atualização processual → WhatsApp.**

O WA.Auto foi refatorado para operar como serviço **100% hospedado**. O navegador do usuário não chama `127.0.0.1`, não depende de aplicativo Windows e não precisa deixar um PC ligado.

## Arquitetura

```text
Navegador
   │ HTTPS
   ▼
WA.Auto Cloud (Node.js / Render)
   ├─ painel web + API
   ├─ fila de campanhas
   ├─ monitor DataJud + DJEN
   ├─ conexão WhatsApp WebSocket (Baileys)
   └─ cache SQLite da instância
          │ snapshot seguro
          ▼
      Supabase
      ├─ histórico/importações/fila
      └─ credenciais de sessão do WhatsApp
```

A conexão com o WhatsApp usa QR Code ou código de pareamento e roda no backend cloud. Não existe Chromium, Puppeteer ou `whatsapp-web.js` na produção.

## Fluxo

1. Abra o WA.Auto pelo navegador.
2. Clique em **Conectar WhatsApp** e escaneie o QR Code, ou use o código de pareamento.
3. Importe uma planilha `.xlsx` ou `.csv`.
4. Escolha a aba e a coluna de telefone.
5. Escreva a mensagem e use campos como `{{Cliente}}`, `{{Protocolo}}` e qualquer outra coluna.
6. Revise os destinatários válidos, duplicados, bloqueados e linhas incompletas.
7. Envie primeiro uma mensagem de teste.
8. Salve a campanha e confirme a revisão.
9. Inicie, pause, continue ou cancele a fila pelo navegador.

Nenhuma mensagem é disparada apenas por importar a planilha ou salvar um rascunho.

## Funcionalidades

- Excel `.xlsx` e CSV com vírgula, ponto e vírgula ou tabulação.
- Até 15 MB por arquivo, 60 abas, 10.000 linhas por aba e 150 colunas.
- Detecção de colunas como `Telefone`, `Celular`, `WhatsApp`, `Cliente` e `Nome`.
- Telefones brasileiros e internacionais.
- Personalização por qualquer coluna da planilha.
- Filtro por coluna/valor e seleção individual.
- Remoção de duplicados na campanha.
- Exclusão automática de linhas marcadas como “NÃO FALAR”, “NÃO CONTATAR”, opt-out e equivalentes.
- Coluna opcional de consentimento.
- Verificação do número no WhatsApp antes do envio.
- Intervalo configurável entre mensagens.
- Uma campanha em execução por vez.
- Pausa, continuação e cancelamento.
- Estado de envio: pendente, enviada, entregue, lida, inválida, duplicada, bloqueada ou incerta.
- Lista de não contatar.
- Reconhecimento de respostas como `SAIR`, `PARAR`, `STOP` e equivalentes.
- Relatório CSV por campanha.
- Recuperação segura após reinício do serviço.

## Monitoramento processual — DataJud + DJEN

O menu **Processos** permite cadastrar manualmente ou importar da planilha uma carteira com:

- número CNJ do processo;
- nome do cliente;
- telefone/WhatsApp;
- fonte: DataJud, DJEN ou ambas;
- autorização para aviso automático.

### Regra de atualização

1. O primeiro scan cria uma **linha de base** e não envia movimentações antigas.
2. Nas consultas seguintes, eventos inéditos são deduplicados por identidade/hash.
3. Cada nova movimentação confirmada pela fonte gera um registro no histórico.
4. Se o WhatsApp estiver conectado, o contato não estiver bloqueado e não houver campanha comum em execução, o aviso entra no envio.
5. Se o WhatsApp estiver desconectado, o evento permanece pendente.
6. Respostas de opt-out como `SAIR`, `PARAR` e `STOP` impedem novos avisos para o telefone.

O importador jurídico **não remove um telefone apenas por aparecer em mais de um processo**. A duplicidade jurídica é o mesmo par `processo + telefone`.

Linhas com indicação de **NÃO FALAR / NÃO CONTATAR / opt-out** são ignoradas. Se uma coluna de autorização for selecionada, somente valores afirmativos entram no monitoramento.

### Agendamento gratuito

O workflow `.github/workflows/process-monitor.yml` chama o WA.Auto a cada 30 minutos. Para carteiras grandes, o monitor trabalha em lotes com cursor persistente, evitando tentar milhares de consultas numa única requisição.

A consulta individual de um processo continua disponível pelo botão **Consultar**.

> DataJud e DJEN são fontes externas. Timeout, 429, WAF ou atraso de sincronização são registrados como indisponibilidade parcial; o WA.Auto não transforma falha de consulta ou resultado vazio em afirmação de que o processo não existe.
## Persistência cloud

O filesystem de hospedagens gratuitas pode ser descartado. Por isso o WA.Auto usa o SQLite apenas como cache operacional da instância e mantém snapshots comprimidos no Supabase.

A tabela `wa_auto_snapshots` possui RLS. O snapshot só pode ser lido/escrito quando o backend envia um segredo adicional no cabeçalho `x-wa-secret`; o banco armazena apenas o SHA-256 desse segredo.

Variáveis necessárias no backend:

```dotenv
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_ANON_KEY=...
WA_DB_SECRET=...
```

Nunca exponha `WA_DB_SECRET` no frontend ou no GitHub.

O schema está em `supabase/wa-auto-cloud.sql`.

## Deploy

O repositório contém `render.yaml` para um Web Service Node.js.

- Build: `npm install --no-fund`
- Start: `npm start`
- Health check: `/api/health`
- Node: 22
- Plano alvo: gratuito

O frontend e a API são servidos pela **mesma origem**, então não há ponte Vercel → localhost, CORS para `127.0.0.1` ou Private Network Access.

### Limite importante do gratuito

O plano gratuito da hospedagem pode hibernar quando não recebe tráfego. Enquanto o painel está aberto, a consulta periódica de estado mantém atividade HTTP. Se o serviço hibernar depois que ninguém estiver usando o painel, ele restaura o snapshot na próxima inicialização.

Isso é diferente de prometer um worker 24/7: para campanha que precise continuar durante horas com **nenhum navegador aberto**, uma hospedagem que não hiberne é necessária.

## Segurança de envio

A fila registra o estado **antes** do efeito externo. Se a conexão cair depois do início de uma tentativa e não houver confirmação, a linha vira **Conferir no WhatsApp** e não é reenviada automaticamente.

| Estado | Significado |
| --- | --- |
| Pronta para enviar | Aguardando a fila. |
| Conferindo número | Consultando registro no WhatsApp. |
| Enviando | Tentativa registrada antes do envio externo. |
| Enviada | O WhatsApp retornou ID da mensagem. |
| Entregue / Lida | Confirmação recebida quando disponível. |
| Conferir no WhatsApp | Resultado ambíguo; exige conferência humana. |
| Falha de entrega | O WhatsApp informou falha. |

## Planilhas e telefones

Use um telefone por célula. Para Brasil, informe DDD + número ou `+55` + DDD + número. Para outros países, prefira `+` seguido do código do país.

O WA.Auto não inventa DDD e não corrige automaticamente números ambíguos.

Exemplo:

```text
Olá, {{Cliente}}! Tudo bem?

Entramos em contato para acompanhar seu atendimento.
Podemos conversar por aqui?

Se preferir não receber mensagens, responda SAIR.
```

## Custos e natureza da integração

O projeto não exige CNPJ, Meta Business Manager ou cobrança por mensagem de uma API comercial.

A conexão usa **Baileys**, uma implementação não oficial do protocolo Web do WhatsApp. Isso significa que mudanças no WhatsApp podem exigir atualização e o uso inadequado pode levar a restrições da conta. Nenhum intervalo ou biblioteca garante “antiban”.

Use apenas com pessoas que esperam o contato e respeite imediatamente pedidos de saída.

## Desenvolvimento e verificação

```sh
npm install
npm run verify
npm run test:browser
npm run test:baileys-live
```

Os testes normais não enviam mensagens externas. O smoke test `test:baileys-live` abre uma conexão real apenas até o estágio de QR Code e encerra sem autenticar ou enviar.

| Caminho | Responsabilidade |
| --- | --- |
| `src/importer.js`, `phone.js`, `template.js` | Importação e validação. |
| `src/store.js`, `campaigns.js`, `queue.js` | Campanhas, fila e idempotência. |
| `src/whatsapp.js` | QR, pareamento e WhatsApp via Baileys. |
| `src/remote-snapshot.js` | Persistência da instância no Supabase. |
| `src/legal-monitor.js` | DataJud, DJEN, linha de base, deduplicação e alertas processuais. |
| `src/app.js`, `server.js` | API, frontend e runtime cloud. |
| `.github/workflows/process-monitor.yml` | Agendamento gratuito dos lotes processuais. |
| `public/` | Interface web. |
| `supabase/` | Schema de persistência. |
| `tests/` | Testes automatizados. |
