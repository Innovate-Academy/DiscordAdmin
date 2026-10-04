import { Events, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { dmIfOptedIn } from '../dm.js';
import { ensureRole } from '../roles.js';
import { grantXp } from './levels.js';
import { UserError, fetchChannel, safe } from '../util.js';

const DAY = 86_400_000;
const STAY_MS = 7 * DAY;
const MIN_ACCOUNT_AGE_MS = 7 * DAY;
const REFERRAL_XP = 200;
const AMBASSADOR_AT = 3;

const command = new SlashCommandBuilder().setName('invitar').setDescription('Tu enlace personal de invitación y cuánta gente has traído');

// Saber qué invitación se usó exige que el bot pueda ver las invitaciones del servidor.
const canTrack = (guild) => Boolean(guild?.members.me?.permissions.has(PermissionFlagsBits.ManageGuild));

function register(client, ctx) {
  const { db } = ctx;
  const uses = new Map();

  // Actualiza el recuento de usos y devuelve los códigos que han subido desde la última vez.
  async function refresh(guild) {
    const used = [];
    for (const invite of (await guild.invites.fetch()).values()) {
      if ((invite.uses ?? 0) > (uses.get(invite.code) ?? 0)) used.push(invite.code);
      uses.set(invite.code, invite.uses ?? 0);
    }
    return used;
  }

  client.once(
    Events.ClientReady,
    safe('referidos', async () => {
      const guild = client.guilds.cache.get(ctx.guildId);
      if (canTrack(guild)) await refresh(guild);
    }),
  );

  client.on(
    Events.GuildMemberAdd,
    safe('referidos', async (member) => {
      if (member.guild.id !== ctx.guildId || member.user.bot || !canTrack(member.guild)) return;
      const used = await refresh(member.guild);
      // Si entran dos personas a la vez no se puede saber quién usó cuál: no se cuenta ninguna.
      if (used.length !== 1) return;
      const invite = db.prepare('SELECT user_id FROM referral_invites WHERE code = ?').get(used[0]);
      if (!invite || invite.user_id === member.id) return;
      // Las cuentas recién creadas no cuentan: es la forma habitual de inflar invitaciones.
      if (Date.now() - member.user.createdTimestamp < MIN_ACCOUNT_AGE_MS) return;
      db.prepare('INSERT OR IGNORE INTO referrals (invited_id, inviter_id, joined_at) VALUES (?, ?, ?)').run(member.id, invite.user_id, Date.now());
    }),
  );
}

async function onCommand(interaction, ctx) {
  const { db, client, settings } = ctx;
  const { guild, user } = interaction;
  if (!canTrack(guild)) {
    throw new UserError('Los referidos no están activos: el bot necesita el permiso "Gestionar servidor" para saber qué invitación usa cada persona.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let code = db.prepare('SELECT code FROM referral_invites WHERE user_id = ?').get(user.id)?.code;
  if (!code) {
    const channel = (await fetchChannel(client, settings.get('channel_welcome'))) ?? interaction.channel;
    const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: `Enlace de referido de ${user.id}` });
    code = invite.code;
    db.prepare('INSERT INTO referral_invites (code, user_id, created_at) VALUES (?, ?, ?)').run(code, user.id, Date.now());
  }
  const { qualified, waiting } = db
    .prepare(
      `SELECT COUNT(qualified_at) AS qualified, COALESCE(SUM(checked = 0), 0) AS waiting
       FROM referrals WHERE inviter_id = ?`,
    )
    .get(user.id);
  await interaction.editReply(
    `Tu enlace: https://discord.gg/${code}\n` +
      `Invitados que se han quedado: **${qualified}** (en espera: ${waiting}).\n` +
      `Cada persona que entra con tu enlace y sigue aquí a los 7 días te da ${REFERRAL_XP} XP; con ${AMBASSADOR_AT} consigues el rol Embajador.`,
  );
}

// A los 7 días se comprueba si la persona invitada sigue en el servidor (y verificada) y se premia a quien la trajo.
async function tick(ctx, now) {
  const { db, client, settings } = ctx;
  const guild = client.guilds.cache.get(ctx.guildId);
  if (!guild) return;
  const due = db.prepare('SELECT * FROM referrals WHERE checked = 0 AND joined_at <= ?').all(now - STAY_MS);
  for (const referral of due) {
    db.prepare('UPDATE referrals SET checked = 1 WHERE invited_id = ?').run(referral.invited_id);
    const invited = await guild.members.fetch(referral.invited_id).catch(() => null);
    const verifiedRole = settings.get('role_verified');
    if (!invited || (verifiedRole && !invited.roles.cache.has(verifiedRole))) continue;

    db.prepare('UPDATE referrals SET qualified_at = ? WHERE invited_id = ?').run(now, referral.invited_id);
    grantXp(db, referral.inviter_id, REFERRAL_XP);
    const { total } = db.prepare('SELECT COUNT(*) AS total FROM referrals WHERE inviter_id = ? AND qualified_at IS NOT NULL').get(referral.inviter_id);
    if (total >= AMBASSADOR_AT) {
      const inviter = await guild.members.fetch(referral.inviter_id).catch(() => null);
      const roleId = await ensureRole(guild, settings, 'role_ambassador', 'Embajador').catch(() => null);
      if (inviter && roleId && !inviter.roles.cache.has(roleId)) await inviter.roles.add(roleId).catch(() => {});
    }
    await dmIfOptedIn(ctx, referral.inviter_id, `<@${referral.invited_id}> entró con tu enlace y sigue en el servidor: +${REFERRAL_XP} XP. Ya llevas ${total}.`);
  }
}

export default { id: 'referrals', name: 'Referidos', commands: [command], register, onCommand, tick };
