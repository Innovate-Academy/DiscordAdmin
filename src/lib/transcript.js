const isoDate = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

// Transcripción en texto plano de un ticket a partir de sus mensajes registrados.
export function buildTranscript(ticket, messages, formatDate = isoDate) {
  const lines = [
    `Ticket #${ticket.id}: ${ticket.title}`,
    `Autor: ${ticket.user_id}`,
    `Abierto: ${formatDate(ticket.created_at)} UTC`,
    '',
    'Descripción:',
    ticket.description,
  ];
  if (ticket.steps) lines.push('', 'Pasos para reproducir:', ticket.steps);
  lines.push('', '--- Mensajes ---');
  for (const message of messages) {
    let line = `[${formatDate(message.created_at)}] ${message.author_name ?? message.author_id}: ${message.content}`;
    if (message.attachments) line += ` [adjuntos: ${message.attachments}]`;
    if (message.deleted_at) line += ' (borrado)';
    lines.push(line);
  }
  return lines.join('\n');
}
