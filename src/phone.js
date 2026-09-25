const areaCodes = new Set('11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(' '));

export function normalizePhone(value, country = '55') {
  let raw = String(value ?? '').trim();
  if (!raw) return { phone: null, error: 'Telefone vazio' };
  if (/^\d+(?:\.\d+)?e\+?\d+$/i.test(raw)) {
    const number = Number(raw);
    if (!Number.isSafeInteger(number)) return { phone: null, error: 'Número sem precisão; corrija a célula como texto' };
    raw = String(number);
  }
  if (!/^\+?[\d\s().-]+$/.test(raw)) return { phone: null, error: 'Use um único telefone por célula, sem texto ou ramal' };
  const international = raw.startsWith('+') || raw.startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) digits = digits.slice(2);
  if (!international) {
    // A national DDD 55 is not a country prefix: (55) 99999-1234 stays national.
    if (country === '55' && (digits.length === 10 || digits.length === 11)) digits = `55${digits}`;
    else if (country !== '55' && !digits.startsWith(country)) digits = country + digits;
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return { phone: null, error: 'Telefone incompleto ou longo demais; informe DDD e número' };
  if (digits.startsWith('55')) {
    const national = digits.slice(2);
    if (![10, 11].includes(national.length) || !areaCodes.has(national.slice(0, 2))) return { phone: null, error: 'DDD ou tamanho do telefone brasileiro inválido' };
    if (national.length === 11 && national[2] !== '9') return { phone: null, error: 'Celular brasileiro com 11 dígitos deve começar com 9 após o DDD' };
    if (national.length === 10 && !/[2-9]/.test(national[2])) return { phone: null, error: 'Número brasileiro inválido' };
  } else if (!international && country === '55') {
    return { phone: null, error: 'Para telefone internacional, use + e código do país' };
  }
  return { phone: digits, error: null };
}

export const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
export const affirmative = value => /^(sim|s|yes|y|true|1|x|autorizado|autorizada|aceito|aceita)$/.test(fold(value));
export function blockedInRow(row) {
  return Object.entries(row).some(([key, value]) => {
    const text = fold(value);
    if (/\b(nao falar|nao contatar|nao contactar|nao enviar|nao ligar|nao entrar em contato|descadastrado|descadastrada|opt[ -]?out)\b/.test(text)) return true;
    return /^(nao[_ ]?(contatar|falar|enviar)|descadastrado|bloqueado|opt[_ ]?out)$/.test(fold(key)) && affirmative(value);
  });
}
