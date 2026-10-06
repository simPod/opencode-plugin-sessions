import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { OpenCode } from '@opencode/client';
import type {
  SessionInboxInfo,
  SessionInfo,
  SessionMessageInfo,
  SessionTransferData,
} from '@opencode/client';
import { gateway } from '../src/gateway.ts';

function info(
  id: string,
  parentID?: string,
  directory = '/synthetic/root',
): SessionInfo {
  return {
    id,
    ...(parentID ? { parentID } : {}),
    projectID: 'project-a',
    title: `Title ${id}`,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1700000000000, updated: 1700000000001 },
    location: { directory },
  };
}

function httpGateway(
  respond: (request: Request) => Promise<Response> | Response,
) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, 'https://opencode.invalid');
    requests.push(request);
    return respond(request);
  };
  return {
    sessions: gateway(
      OpenCode.make({ baseUrl: 'https://opencode.invalid', fetch }),
    ),
    requests,
  };
}

function query(request: Request) {
  return Object.fromEntries(new URL(request.url).searchParams);
}

test('generated HTTP client reads all child and existing-ID pages without directory or project filters', async () => {
  const children = Array.from({ length: 101 }, (_, index) =>
    info(`ses_child${index}`, 'ses_root', `/synthetic/worktree${index}`),
  );
  const grandchild = info(
    'ses_grandchild',
    'ses_child100',
    '/synthetic/another-worktree',
  );
  const foreign = { ...info('ses_foreign'), projectID: 'project-b' };
  const all = [info('ses_root'), ...children, grandchild, foreign];
  const cursor = 'opaque cursor/+=';
  const f = httpGateway((request) => {
    assert.equal(request.method, 'GET');
    assert.equal(new URL(request.url).pathname, '/api/session');
    const parameters = query(request);
    assert.equal(parameters.limit, '100');
    // These queries must enumerate across locations and projects, including for conflict checks.
    assert(!('directory' in parameters));
    assert(!('project' in parameters));
    assert(!('subpath' in parameters));
    const source =
      parameters.parentID === 'ses_root'
        ? children
        : parameters.parentID === 'ses_child100'
          ? [grandchild]
          : all;
    if (parameters.cursor) {
      assert.equal(parameters.cursor, cursor);
      return Response.json({ data: source.slice(100), cursor: {} });
    }
    return Response.json({
      data: source.slice(0, 100),
      cursor: source.length > 100 ? { next: cursor } : {},
    });
  });

  assert.deepEqual(await f.sessions.children('ses_root'), children);
  assert.deepEqual(await f.sessions.children('ses_child100'), [grandchild]);
  assert.deepEqual(
    await f.sessions.existing(),
    new Set([
      'ses_root',
      ...Array.from({ length: 101 }, (_, index) => `ses_child${index}`),
      'ses_grandchild',
      'ses_foreign',
    ]),
  );
  assert.deepEqual(f.requests.map(query), [
    { limit: '100', parentID: 'ses_root' },
    { limit: '100', parentID: 'ses_root', cursor },
    { limit: '100', parentID: 'ses_child100' },
    { limit: '100' },
    { limit: '100', cursor },
  ]);
});

test('generated HTTP client pages raw messages in ascending order without a message-type filter', async () => {
  const first: SessionMessageInfo[] = Array.from(
    { length: 100 },
    (_, index) => ({
      id: `msg_user${index}`,
      type: 'user',
      time: { created: 1700000000000 + index },
      text: `User ${index}`,
    }),
  );
  const last: SessionMessageInfo[] = [
    {
      id: 'msg_system',
      type: 'system',
      time: { created: 1700000000100 },
      text: 'Raw private system text: č 🌱\u0000',
    },
    {
      id: 'msg_idle',
      type: 'idle',
      time: { created: 1700000000101 },
      outcome: 'succeeded',
    },
  ];
  const cursor = 'raw/+cursor=';
  const f = httpGateway((request) => {
    assert.equal(request.method, 'GET');
    assert.equal(
      new URL(request.url).pathname,
      '/api/session/ses_root/message',
    );
    const parameters = query(request);
    assert(!('type' in parameters));
    if (parameters.cursor) {
      assert.deepEqual(parameters, { limit: '100', cursor });
      return Response.json({ data: last, cursor: {} });
    }
    assert.deepEqual(parameters, { limit: '100', order: 'asc' });
    return Response.json({ data: first, cursor: { next: cursor } });
  });

  assert.deepEqual(await f.sessions.messages('ses_root'), [...first, ...last]);
  assert.equal(f.requests.length, 2);
});

test('native get, unsanitized export, import location, and recursive remove use generated API envelopes', async () => {
  const nativeInfo = info(
    'ses_root',
    'ses_parent',
    '/synthetic/moved-worktree',
  );
  const transfer: SessionTransferData = {
    info: nativeInfo,
    messages: [
      {
        id: 'msg_private',
        type: 'system',
        time: { created: 1700000000000 },
        text: 'secret: č 🌱\n\u0000',
      },
    ],
  };
  let imported: unknown;
  const f = httpGateway(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/api/session/ses_root' && request.method === 'GET') {
      assert.deepEqual(query(request), {});
      return Response.json({ data: nativeInfo });
    }
    if (path === '/api/experimental/session/ses_root/export') {
      assert.equal(request.method, 'GET');
      assert.deepEqual(query(request), { sanitize: 'false' });
      return Response.json({ data: transfer });
    }
    if (path === '/api/experimental/session/import') {
      assert.equal(request.method, 'POST');
      assert.match(
        request.headers.get('content-type') ?? '',
        /application\/json/,
      );
      imported = await request.json();
      return Response.json({ data: nativeInfo });
    }
    assert.equal(path, '/api/session/ses_root');
    assert.equal(request.method, 'DELETE');
    assert.equal(await request.text(), '');
    return new Response(null, { status: 204 });
  });

  assert.deepEqual(await f.sessions.get('ses_root'), nativeInfo);
  assert.deepEqual(await f.sessions.export('ses_root'), transfer);
  assert.deepEqual(await f.sessions.import(transfer), nativeInfo);
  assert.deepEqual(imported, {
    ...transfer,
    location: { directory: '/synthetic/moved-worktree' },
  });
  assert.equal(await f.sessions.remove('ses_root'), undefined);
  assert.equal(f.requests.length, 4);
});

test('native active and inbox responses independently prevent treating queued or running sessions as idle', async (t) => {
  for (const state of [
    'running',
    'queued',
    'idle',
    'different session running',
  ] as const)
    await t.test(state, async () => {
      const inbox: SessionInboxInfo[] =
        state === 'queued'
          ? [
              {
                id: 'inbox_fixture',
                sessionID: 'ses_child',
                type: 'compaction',
                payload: {},
                delivery: 'queue',
                time: { created: 1700000000000 },
              },
            ]
          : [];
      const f = httpGateway((request) => {
        assert.equal(request.method, 'GET');
        assert.deepEqual(query(request), {});
        if (new URL(request.url).pathname === '/api/session/active') {
          return Response.json({
            data:
              state === 'running'
                ? { ses_child: { type: 'running' } }
                : state === 'different session running'
                  ? { ses_other: { type: 'running' } }
                  : {},
          });
        }
        assert.equal(
          new URL(request.url).pathname,
          '/api/session/ses_child/inbox',
        );
        return Response.json({ data: inbox });
      });
      assert.equal(
        await f.sessions.busy('ses_child'),
        state === 'running' || state === 'queued',
      );
      assert.equal(f.requests.length, 2);
    });
});

test('repeated server cursors abort enumeration instead of looping or trusting an incomplete family', async (t) => {
  for (const resource of ['children', 'existing', 'messages'] as const)
    await t.test(resource, async () => {
      const f = httpGateway((request) => {
        assert.equal(
          new URL(request.url).pathname,
          resource === 'messages'
            ? '/api/session/ses_root/message'
            : '/api/session',
        );
        const data =
          resource === 'messages'
            ? [
                {
                  id: 'msg_fixture',
                  type: 'system',
                  time: { created: 1700000000000 },
                  text: 'Raw',
                },
              ]
            : [info('ses_child', 'ses_root')];
        return Response.json({ data, cursor: { next: 'repeated' } });
      });
      const run =
        resource === 'children'
          ? () => f.sessions.children('ses_root')
          : resource === 'existing'
            ? () => f.sessions.existing()
            : () => f.sessions.messages('ses_root');
      await assert.rejects(
        run,
        resource === 'messages'
          ? /repeated a message cursor/
          : /repeated a session cursor/,
      );
      assert.equal(f.requests.length, 2);
    });
});
