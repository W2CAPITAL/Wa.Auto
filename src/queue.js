import { EventEmitter } from 'node:events';
import { requireValue } from './errors.js';

export class Queue extends EventEmitter {
  constructor(store, transport, { now = () => Date.now(), autoTick = true, resourceGuard = null, criticalIntent = null } = {}) {
    super();
    this.store = store;
    this.transport = transport;
    this.now = now;
    this.resourceGuard = resourceGuard;
    this.criticalIntent = criticalIntent;
    this.busy = false;
    this.closed = false;
    transport.on('state', state => {
      if (state.status !== 'ready') this.pauseActive('WhatsApp desconectado. Reconecte e clique em Continuar.');
    });
    transport.on('ack', ({ id, ack }) => { store.recordAck(id, ack); this.emit('change'); });
    transport.on('optout', ({ identities }) => {
      for (const identity of identities) store.suppress(identity, 'Cliente pediu para sair pelo WhatsApp');
      this.emit('change');
    });
    if (autoTick) { this.timer = setInterval(() => void this.tick().catch(() => this.pauseActive('Falha ao registrar a fila. Verifique o espaço em disco.')), 500); this.timer.unref(); }
  }
  start(id) {
    requireValue(!this.closed, 'O aplicativo está encerrando.', 409);
    requireValue(this.transport.isReady(), 'Conecte seu WhatsApp antes de iniciar.', 409);
    requireValue(!this.busy, 'Aguarde o envio em andamento terminar.', 409);
    requireValue(!this.resourceGuard || this.resourceGuard.canWork(), 'O servidor está sob pressão de memória. Aguarde alguns instantes e tente novamente.', 503);
    requireValue(!this.store.active() || this.store.active() === id, 'Já existe uma campanha em execução. Pause-a primeiro.', 409);
    const campaign = this.store.campaign(id);
    requireValue(['draft', 'paused', 'running'].includes(campaign.status), 'Esta campanha já foi encerrada.', 409);
    requireValue(this.store.nextEntry(id), 'Esta campanha não tem mensagens pendentes.', 409);
    this.store.setCampaign(id, 'running');
    this.emit('change');
  }
  pause(id) {
    const campaign = this.store.campaign(id);
    requireValue(['draft', 'paused', 'running'].includes(campaign.status), 'Esta campanha já foi encerrada.', 409);
    this.store.setCampaign(id, 'paused', 'Pausada por você. Um envio já iniciado pode concluir.');
    this.emit('change');
  }
  pauseActive(reason) { const active = this.store.active(); if (active) { this.store.setCampaign(active, 'paused', reason); this.emit('change'); } }
  cancel(id) {
    const campaign = this.store.campaign(id);
    requireValue(!['completed', 'cancelled'].includes(campaign.status), 'Esta campanha já foi encerrada.', 409);
    this.store.transaction(() => {
      this.store.setCampaign(id, 'cancelled', 'Cancelada por você. Um envio já iniciado pode concluir.');
      this.store.cancelPending(id);
    });
    this.emit('change');
  }
  async tick() {
    if (this.busy || this.closed || !this.transport.isReady()) return;
    if (this.resourceGuard && !this.resourceGuard.canWork()) {
      this.pauseActive('Pausa automática de segurança: o servidor atingiu o limite de memória configurado.');
      return;
    }
    const id = this.store.active();
    if (!id) return;
    const entry = this.store.nextEntry(id);
    if (!entry) { this.store.setCampaign(id, 'completed'); this.emit('change'); return; }
    if (this.now() < Number(this.store.getMeta('nextSendAt') || 0)) return;
    this.busy = true;
    let attempted = false;
    try {
      this.store.updateEntry(entry.id, { status: 'resolving' });
      if (this.store.isBlocked(entry.phone, `${entry.phone}@s.whatsapp.net`, `${entry.phone}@c.us`)) {
        this.store.updateEntry(entry.id, { status: 'skipped', reason: 'Contato bloqueado' }); return;
      }
      const jid = await this.transport.resolve(entry.phone);
      // The user may have paused/cancelled or an opt-out may have arrived while resolving.
      if (this.store.entry(entry.id).status !== 'resolving') return;
      if (this.store.campaign(id).status !== 'running' || !this.transport.isReady() || this.closed) {
        this.store.updateEntry(entry.id, { status: 'pending' }); return;
      }
      if (!jid) { this.store.updateEntry(entry.id, { status: 'invalid', reason: 'Número não encontrado no WhatsApp' }); return; }
      if (this.store.isBlocked(jid, entry.phone)) { this.store.updateEntry(entry.id, { status: 'skipped', reason: 'Contato pediu para não receber mensagens', jid }); return; }
      if (this.store.hasSentJid(id, jid, entry.id)) { this.store.updateEntry(entry.id, { status: 'duplicate', reason: 'WhatsApp identificou o mesmo destinatário de outra linha', jid }); return; }
      // Register a tiny durable journal before the external side effect. If Render
      // restarts in the critical window, recovery marks the line as uncertain instead
      // of risking a duplicate WhatsApp message.
      if (this.criticalIntent) {
        await this.criticalIntent.begin('campaign', { campaignId:id, entryId:entry.id, phone:entry.phone, jid });
      }
      this.store.updateEntry(entry.id, { status: 'sending', jid });
      attempted = true;
      this.criticalIntent?.arm();
      this.emit('change');
      const sent = await this.transport.send(jid, entry.message);
      requireValue(sent?.id, 'WhatsApp não retornou um identificador da mensagem.');
      const ack = sent.ack ?? 0;
      this.store.updateEntry(entry.id, { status: ack === -1 ? 'failed_delivery' : ack >= 3 ? 'read' : ack === 2 ? 'delivered' : 'sent', message_id: sent.id, ack, reason: ack === -1 ? 'O WhatsApp informou falha de entrega. Confira a conversa.' : '' });
    } catch (error) {
      const current = this.store.entry(entry.id);
      if (attempted) this.store.updateEntry(entry.id, { status: 'uncertain', reason: 'Envio sem confirmação. Confira a conversa antes de qualquer novo contato.' });
      else if (current.status === 'resolving') this.store.updateEntry(entry.id, { status: 'pending', reason: 'A consulta ao WhatsApp falhou; tente continuar após reconectar.' });
      this.pauseActive(attempted ? 'Um envio ficou sem confirmação. Confira o histórico antes de continuar.' : 'A conexão não respondeu. Reconecte o WhatsApp antes de continuar.');
      this.emit('queueError', { campaignId: id, attempted, error: error.message });
    } finally {
      if (attempted) this.store.setMeta('nextSendAt', this.now() + this.store.campaign(id).config.intervalSeconds * 1000);
      this.busy = false;
      this.emit('change');
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.pauseActive('Aplicativo encerrado. Clique em Continuar ao abrir novamente.');
    await this.transport.close();
  }
}
