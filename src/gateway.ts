import type {
  OpenCodeClient,
  SessionInfo,
  SessionMessageInfo,
  SessionTransferData,
} from '@opencode/client';

export interface SessionGateway {
  get(id: string): Promise<SessionInfo>;
  children(id: string): Promise<SessionInfo[]>;
  messages(id: string): Promise<SessionMessageInfo[]>;
  busy(id: string): Promise<boolean>;
  existing(): Promise<Set<string>>;
  export(id: string): Promise<SessionTransferData>;
  remove(id: string): Promise<void>;
  import(data: SessionTransferData): Promise<SessionInfo>;
}

export function gateway(
  client: OpenCodeClient,
  signal?: AbortSignal,
): SessionGateway {
  const options = signal ? { signal } : undefined;
  async function sessions(parentID?: string): Promise<SessionInfo[]> {
    const found: SessionInfo[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.session.list(
        {
          limit: 100,
          ...(parentID === undefined ? {} : { parentID }),
          ...(cursor === undefined ? {} : { cursor }),
        },
        options,
      );
      found.push(...page.data);
      cursor =
        page.data.length === 0 ? undefined : (page.cursor.next ?? undefined);
      if (cursor && seen.has(cursor))
        throw new Error('The server repeated a session cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return found;
  }

  return {
    get: (sessionID) => client.session.get({ sessionID }, options),
    children: (id) => sessions(id),
    existing: async () =>
      new Set((await sessions()).map((session) => session.id)),
    messages: async (sessionID) => {
      const found: SessionMessageInfo[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.message.list(
          {
            sessionID,
            limit: 100,
            ...(cursor === undefined ? { order: 'asc' as const } : { cursor }),
          },
          options,
        );
        found.push(...page.data);
        cursor =
          page.data.length === 0 ? undefined : (page.cursor.next ?? undefined);
        if (cursor && seen.has(cursor))
          throw new Error('The server repeated a message cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return found;
    },
    busy: async (sessionID) => {
      const active = await client.session.active(options);
      const inbox = await client.session.inbox.list({ sessionID }, options);
      return active[sessionID] !== undefined || inbox.length !== 0;
    },
    export: (sessionID) =>
      client.session.export({ sessionID, sanitize: false }, options),
    remove: (sessionID) => client.session.remove({ sessionID }, options),
    import: (data) =>
      client.session.import({ ...data, location: data.info.location }, options),
  };
}
