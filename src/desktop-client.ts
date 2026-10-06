import { setTimeout } from 'node:timers/promises';
import {
  OpenCode,
  type FormAnswer,
  type FormFields,
  type LocationRef,
} from '@opencode/client';
import { Service } from '@opencode/client/service';
import { gateway, type SessionGateway } from './gateway.ts';
import { Archives } from './rpc.ts';

export interface DesktopHost {
  sessions: SessionGateway;
  ask(
    sessionID: string,
    title: string,
    fields: FormFields,
  ): Promise<FormAnswer | undefined>;
  report(sessionID: string, title: string, message: string): Promise<void>;
}

export async function desktopClient(
  location: LocationRef,
  instanceID: string,
  signal: AbortSignal,
): Promise<DesktopHost> {
  const endpoint = await Service.discover();
  if (!endpoint)
    throw new Error(
      'Desktop session commands require the managed OpenCode service. No session was changed.',
    );
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers({
      url: endpoint.url,
      ...(endpoint.auth ? { auth: endpoint.auth } : {}),
    }),
  });
  const actual = await client.rpc(Archives).instance(
    {},
    {
      location,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    },
  );
  if (actual.id !== instanceID)
    throw new Error(
      'The registered service is not the server hosting this plugin. No session was changed.',
    );

  return {
    sessions: gateway(client, signal),
    async ask(sessionID, title, fields) {
      const form = await client.session.form.create(
        { sessionID, title, metadata: { kind: 'question' }, fields },
        { signal },
      );
      const timeout = AbortSignal.timeout(10 * 60_000);
      const waiting = AbortSignal.any([signal, timeout]);
      try {
        while (true) {
          waiting.throwIfAborted();
          const { state } = await client.session.form.get(
            { sessionID, formID: form.id },
            { signal: waiting },
          );
          if (state.status === 'answered') return state.answer;
          if (state.status === 'cancelled') return undefined;
          await setTimeout(250, undefined, { signal: waiting });
        }
      } finally {
        // Use an independent signal so unloading the plugin still closes its form.
        await client.session.form
          .cancel(
            { sessionID, formID: form.id },
            { signal: AbortSignal.timeout(5_000) },
          )
          .catch(() => {});
      }
    },
    async report(sessionID, title, message) {
      await client.session.form.create(
        {
          sessionID,
          title,
          metadata: { kind: 'question' },
          fields: [
            {
              key: 'acknowledged',
              type: 'string',
              title,
              description: message,
              custom: true,
              options: [{ value: 'done', label: 'Done' }],
            },
          ],
        },
        { signal },
      );
    },
  };
}
