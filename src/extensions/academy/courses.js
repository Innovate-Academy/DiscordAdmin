import { randomInt } from 'node:crypto';

export const COURSES_URL = 'https://innovateacademy.site/cursos';

// Cursos de innovateacademy.site (precios en USD, tomados de la web el 03/10/2026).
// Si la academia cambia un precio o añade un curso, hay que actualizar esta lista.
// `lang` es la etiqueta para colorear el código en Discord; `next`, el curso que se recomienda al terminar.
export const COURSES = [
  { id: 'fundamentos', name: 'Fundamentos de Programación', months: 2, price: 31.52, lang: '', next: 'python' },
  { id: 'lua', name: 'Lua', months: 2, price: 42.39, lang: 'lua', next: 'csharp' },
  { id: 'html-css', name: 'HTML / CSS', months: 2, price: 53.26, lang: 'html', next: 'javascript' },
  { id: 'sql', name: 'SQL', months: 2, price: 53.26, lang: 'sql' },
  { id: 'javascript', name: 'JavaScript', months: 3, price: 85.87, lang: 'js' },
  { id: 'java', name: 'Java', months: 3, price: 85.87, lang: 'java' },
  { id: 'csharp', name: 'C#', months: 3, price: 85.87, lang: 'cs' },
  { id: 'python', name: 'Python', months: 4, price: 107.61, lang: 'py', next: 'sql' },
  { id: 'cpp', name: 'C++', months: 3, price: 107.61, lang: 'cpp' },
];

export const PACKS = [
  { id: 'web', name: 'Web Starter', courses: ['html-css', 'javascript'], price: 118.26 },
  { id: 'backend', name: 'Backend Starter', courses: ['fundamentos', 'python', 'sql'], price: 163.53 },
  { id: 'juegos', name: 'Creador de Juegos', courses: ['fundamentos', 'lua', 'csharp'], price: 135.82 },
];

// Lo que alguien puede querer aprender al llegar. `start` es el curso por el que se le recomienda empezar.
export const INTERESTS = [
  { id: 'web', label: 'Crear páginas web', emoji: '🌐', courses: ['html-css', 'javascript'], start: 'html-css', pack: 'web' },
  { id: 'juegos', label: 'Crear videojuegos', emoji: '🎮', courses: ['lua', 'csharp', 'cpp'], start: 'lua', pack: 'juegos' },
  { id: 'backend', label: 'Backend, datos y automatización', emoji: '🗄️', courses: ['python', 'sql', 'java'], start: 'python', pack: 'backend' },
  { id: 'nose', label: 'Todavía no lo sé', emoji: '🤔', courses: ['fundamentos'], start: 'fundamentos', pack: null },
];

export const getCourse = (id) => COURSES.find((course) => course.id === id);
export const courseName = (id) => getCourse(id)?.name ?? id;
export const getInterest = (id) => INTERESTS.find((interest) => interest.id === id);
export const interestOfCourse = (courseId) => INTERESTS.find((interest) => interest.courses.includes(courseId));
export const formatPrice = (amount) => `${amount.toFixed(2).replace('.', ',')} USD`;
export const courseLine = (course) => `**${course.name}** · ${course.months} meses · ${formatPrice(course.price)}`;

// Recomendación para quien acaba de elegir un interés.
export function recommend(interestId) {
  const interest = getInterest(interestId);
  const lines = [`Te recomendamos empezar por ${courseLine(getCourse(interest.start))}.`];
  const pack = PACKS.find((p) => p.id === interest.pack);
  if (pack) {
    lines.push(`Con el pack **${pack.name}** (${pack.courses.map(courseName).join(' + ')}) ahorras un 15 %: ${formatPrice(pack.price)}.`);
  }
  return lines.join('\n');
}

// Sin I, O, 0 ni 1, que se confunden al copiarlos a mano.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Código de un solo uso con la forma PREFIJO-XXXX-XXXX (IA para matrículas, CERT para certificados).
export function generateCode(random = randomInt, prefix = 'IA') {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[random(ALPHABET.length)]).join('');
  return `${prefix}-${pick()}-${pick()}`;
}

// Acepta el código con o sin guiones, espacios o minúsculas. Devuelve null si no tiene la forma correcta.
export function normalizeCode(input, prefix = 'IA') {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = new RegExp(`^${prefix}([A-HJ-NP-Z2-9]{4})([A-HJ-NP-Z2-9]{4})$`).exec(clean);
  return match ? `${prefix}-${match[1]}-${match[2]}` : null;
}

// Limita los intentos fallidos por persona para que nadie pruebe códigos al azar.
export class AttemptLimiter {
  constructor({ max = 5, windowMs = 600_000 } = {}) {
    Object.assign(this, { max, windowMs });
    this.failures = new Map();
  }

  blocked(userId, now) {
    const recent = (this.failures.get(userId) ?? []).filter((time) => now - time < this.windowMs);
    this.failures.set(userId, recent);
    return recent.length >= this.max;
  }

  fail(userId, now) {
    this.failures.set(userId, [...(this.failures.get(userId) ?? []), now]);
  }
}

const CODE_LINE =
  /[{};]\s*$|^\s*(def|class|function|import|from|for|while|if|elif|else|return|const|let|var|public|private|print|console\.|#include|SELECT|local)\b|=>|<\/?[a-z][^>]*>|^\s{2,}\S/;

// Varias líneas con pinta de código y sin bloque de código: conviene sugerir el formato.
export function looksLikeUnformattedCode(content) {
  if (content.includes('```')) return false;
  const lines = content.split('\n').filter((line) => line.trim());
  return lines.length >= 3 && lines.filter((line) => CODE_LINE.test(line)).length >= 3;
}
