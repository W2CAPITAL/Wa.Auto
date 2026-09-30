const norm=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,' ').replace(/\s+/g,' ').trim();
export function isBankRevisionalIntent(input){
  const q=norm(input);
  const bank=/(contrato banc|emprest|credito pessoal|consign|financ|cet|bacen|taxa de juros|capitaliza|parcela|mora|indebito)/.test(q);
  const review=/(revis|juros abus|juros alt|reduz.*parcela|taxa media|cobranca indevida|reequilibr)/.test(q);
  return bank&&review;
}
export const REVISIONAL_DOSSIER_CONTRACT='Em dossiê revisional bancário, separar dados do contrato, taxa nominal e CET, normalidade e mora; identificar modalidade/data/garantia antes da série BACEN; registrar série/unidade/data-base; mostrar cálculo reproduzível; tratar média BACEN como referencial e não teto; distinguir fatos, cálculos, inferências e lacunas; verificar jurisprudência oficial atual.';
export function revisionalDossierAudit(markdown){
  const text=String(markdown||''),active=isBankRevisionalIntent(text);
  if(!active)return{active:false,missing:[],checks:{}};
  const checks={
    contract:/(contrato|cl[aá]usula|valor liberado|valor financiado)/i.test(text),
    nominalVsCet:/(taxa nominal|juros remunerat[oó]rios)/i.test(text)&&/\bCET\b|custo efetivo total/i.test(text),
    bacen:/\bBACEN\b|Banco Central|\bSGS\b/i.test(text),
    rateMethod:/(diferen[cç]a|raz[aã]o|excesso|% a\.[ma]\.|taxa m[eé]dia)/i.test(text),
    normalityMora:/(normalidade|encargos? remunerat[oó]rios)/i.test(text)&&/(mora|inadimpl[eê]ncia|morat[oó]ri)/i.test(text),
    evidence:/(prova|documento|extrato|comprovante|fonte)/i.test(text),
    legalFreshness:/(STJ|jurisprud[eê]ncia|fonte oficial|Tema 27|1\.061\.530)/i.test(text)
  };
  const labels={contract:'dados/cláusulas do contrato',nominalVsCet:'taxa nominal x CET',bacen:'série/fonte BACEN',rateMethod:'metodologia de comparação',normalityMora:'normalidade x mora',evidence:'provas/documentos',legalFreshness:'jurisprudência/fonte oficial atual'};
  return{active:true,checks,missing:Object.entries(checks).filter(([,ok])=>!ok).map(([k])=>labels[k])};
}
