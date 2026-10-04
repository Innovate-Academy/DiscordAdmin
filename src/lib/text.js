// Sustituye {clave} por su valor; las claves desconocidas se dejan tal cual.
export function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Agrupa menciones en mensajes que no superen el límite de caracteres de Discord.
export function chunkMentions(userIds, max = 1900) {
  const chunks = [];
  let current = '';
  for (const id of userIds) {
    const mention = `<@${id}> `;
    if (current.length + mention.length > max) {
      chunks.push(current.trim());
      current = '';
    }
    current += mention;
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

// Escapa los comodines de LIKE para buscar texto literal (usar con ESCAPE '\').
export function escapeLike(text) {
  return text.replace(/[\\%_]/g, '\\$&');
}

// true si es una dirección web http(s) válida.
export function isHttpUrl(text) {
  return URL.canParse(text) && /^https?:$/.test(new URL(text).protocol);
}
