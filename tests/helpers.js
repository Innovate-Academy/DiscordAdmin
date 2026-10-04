import { openDb } from '../src/db.js';
import { createSettings } from '../src/settings.js';

// Dobles mínimos de Discord para probar los módulos sin conexión.

const DAY = 86_400_000;

// `registry` es el mapa de canales del servidor de pruebas; los hilos que se creen se apuntan en él.
export function fakeChannel(id, type = 0) {
  const sent = [];
  const channel = {
    id,
    type,
    sent,
    name: id,
    parentId: null,
    registry: null,
    deleted: false,
    deletedIds: [],
    overwriteEdits: [],
    createdThreads: [],
    children: { cache: new Map() },
    permissionOverwrites: { edit: async (targetId, permissions) => channel.overwriteEdits.push([targetId, permissions]) },
    async setName(name) {
      channel.name = name;
    },
    isTextBased: () => true,
    toString: () => `<#${id}>`,
    async send(payload) {
      const message = {
        id: `${id}-m${sent.length + 1}`,
        payload,
        deleted: false,
        async edit(next) {
          message.payload = { ...message.payload, ...next };
        },
        async delete() {
          message.deleted = true;
        },
        startThread: async (options) => makeThread(options),
      };
      sent.push(message);
      return message;
    },
    messages: {
      fetch: async (messageId) => sent.find((m) => m.id === messageId) ?? null,
      delete: async (messageId) => channel.deletedIds.push(messageId),
    },
    threads: { create: async (options) => makeThread(options) },
    createInvite: async () => ({ code: `inv-${id}` }),
    async delete() {
      channel.deleted = true;
    },
  };

  function makeThread(options) {
    const thread = fakeChannel(`${id}-t${channel.createdThreads.length + 1}`);
    Object.assign(thread, {
      name: options.name,
      options,
      parent: channel,
      registry: channel.registry,
      isThread: () => true,
      archived: false,
      addedMembers: [],
      members: { add: async (userId) => thread.addedMembers.push(userId) },
      async setArchived(value) {
        thread.archived = value;
      },
    });
    channel.createdThreads.push(thread);
    channel.registry?.set(thread.id, thread);
    return thread;
  }
  return channel;
}

// Miembro del servidor; `actions` recoge lo que el bot le hace (rol, silencio, expulsión).
export function fakeMember(id, { roles = [], admin = false, joinedDaysAgo = 30, accountDaysAgo = 365, moderatable = true } = {}) {
  const actions = [];
  const dms = [];
  const user = {
    id,
    bot: false,
    dms,
    createdTimestamp: Date.now() - accountDaysAgo * DAY,
    send: async (text) => dms.push(text),
    toString: () => `<@${id}>`,
  };
  const cache = new Map(roles.map((role) => [role, true]));
  return {
    id,
    user,
    actions,
    displayName: id,
    joinedTimestamp: Date.now() - joinedDaysAgo * DAY,
    permissions: { has: () => admin },
    roles: {
      cache,
      async add(role) {
        cache.set(role, true);
        actions.push(['role', role]);
      },
      async remove(role) {
        cache.delete(role);
        actions.push(['unrole', role]);
      },
    },
    moderatable,
    kickable: moderatable,
    bannable: moderatable,
    timeout: async (ms) => actions.push(['timeout', ms]),
    kick: async () => actions.push(['kick']),
    toString: () => `<@${id}>`,
  };
}

export function fakeCtx(channels = []) {
  const db = openDb(':memory:');
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  for (const channel of channels) channel.registry = byId;
  const created = [];
  const createdRoles = [];
  const members = new Map();
  const users = new Map();
  const banned = [];
  const invites = new Map();
  const guild = {
    name: 'Mi Servidor',
    roles: {
      everyone: { id: 'everyone' },
      cache: new Map([['r-staff', {}]]),
      async create(options) {
        const role = { id: `role-${createdRoles.length + 1}`, name: options.name, deleted: false, toString: () => `<@&${role.id}>` };
        role.delete = async () => {
          role.deleted = true;
        };
        createdRoles.push(role);
        guild.roles.cache.set(role.id, role);
        return role;
      },
    },
    scheduledEvents: { create: async () => ({ id: 'native-1' }), delete: async () => {} },
    invites: { fetch: async () => invites },
    members: {
      me: { permissions: { has: () => true } },
      async fetch(id) {
        if (id === undefined) return members;
        if (!members.has(id)) throw new Error('Unknown Member');
        return members.get(id);
      },
      ban: async (id, options) => banned.push({ id, ...options }),
    },
    channels: {
      async create(options) {
        const channel = fakeChannel(`created-${created.length + 1}`, options.type);
        Object.assign(channel, { options, name: options.name, parentId: options.parent ?? null, registry: byId });
        byId.get(options.parent)?.children.cache.set(channel.id, channel);
        created.push(channel);
        byId.set(channel.id, channel);
        return channel;
      },
    },
  };
  // Usuario para mensajes privados: el de un miembro conocido o uno nuevo que guarda lo que recibe en `dms`.
  const fetchUser = async (id) => {
    if (members.has(id)) return members.get(id).user;
    if (!users.has(id)) {
      const dms = [];
      users.set(id, { id, dms, send: async (text) => dms.push(text) });
    }
    return users.get(id);
  };
  return {
    db,
    settings: createSettings(db),
    client: { user: { id: 'bot' }, channels: { fetch: async (id) => byId.get(id) ?? null }, users: { fetch: fetchUser }, guilds: { cache: new Map([['g1', guild]]) } },
    guildId: 'g1',
    guild,
    created,
    createdRoles,
    members,
    users,
    banned,
    invites,
  };
}

export function fakeInteraction(ctx, { command = '', sub = null, options = {}, admin = true, userId = 'u1', roles = [], member = null, channel = null, message = null, customId = null, fields = {}, values = [], kind = 'command' } = {}) {
  const replies = [];
  const option = (name) => options[name] ?? null;
  const self = member ?? fakeMember(userId, { roles, admin });
  const interaction = {
    replies,
    modal: null,
    replied: false,
    deferred: false,
    guildId: ctx.guildId,
    guild: ctx.guild,
    commandName: command,
    customId,
    channel,
    channelId: channel?.id ?? null,
    message,
    values,
    users: new Map(),
    user: self.user,
    member: self,
    memberPermissions: { has: () => admin },
    options: {
      getSubcommand: () => sub,
      getString: option,
      getInteger: option,
      getBoolean: option,
      getRole: option,
      getUser: option,
      getMember: (name) => option(name)?.member ?? null,
      getChannel: option,
    },
    fields: { getTextInputValue: (name) => fields[name] ?? '' },
    isChatInputCommand: () => kind === 'command',
    isButton: () => kind === 'button',
    isModalSubmit: () => kind === 'modal',
    isAnySelectMenu: () => kind === 'select',
    isRepliable: () => true,
    async reply(payload) {
      interaction.replied = true;
      replies.push(payload);
    },
    async deferReply() {
      interaction.deferred = true;
    },
    async editReply(payload) {
      replies.push(payload);
    },
    async followUp(payload) {
      replies.push(payload);
    },
    async update(payload) {
      interaction.replied = true;
      replies.push(payload);
    },
    async showModal(modal) {
      interaction.replied = true;
      interaction.modal = modal;
    },
  };
  return interaction;
}

// Opción "usuario" de un comando: getUser devuelve el usuario y getMember su miembro (si sigue en el servidor).
export const userOption = (member) => Object.assign(Object.create(member.user), { member });

export const textOf = (payload) => (typeof payload === 'string' ? payload : payload.content ?? '');
export const embedOf = (payload) => payload.embeds[0].toJSON();
