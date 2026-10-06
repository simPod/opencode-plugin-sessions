import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { desktopClient } from '../src/desktop-client.ts';

test(
  'desktop bridge authenticates, verifies its hosting instance, and creates visible native question forms',
  { timeout: 10_000 },
  async (t) => {
    const state = await mkdtemp(join(tmpdir(), 'session-desktop-service-'));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    t.after(async () => {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      await rm(state, { recursive: true, force: true });
    });
    const forms: Array<Record<string, unknown>> = [];
    const requests: string[] = [];
    const instanceID = randomUUID();
    const password = 'synthetic-password';
    const server = createServer(async (request, response) => {
      const url = request.url ?? '';
      requests.push(url);
      if (
        request.headers.authorization !==
        `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
      ) {
        response.writeHead(401).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (url === '/api/info') {
        response.end(JSON.stringify({ pid: process.pid, version: '2.0.24' }));
      } else if (url.startsWith('/api/rpc/simpod-session-archive/instance')) {
        response.end(JSON.stringify({ output: { id: instanceID } }));
      } else if (
        url === '/api/session/ses_owner/form' &&
        request.method === 'POST'
      ) {
        let body = '';
        for await (const chunk of request) body += chunk;
        const payload: Record<string, unknown> = JSON.parse(body);
        forms.push(payload);
        response.end(
          JSON.stringify({
            data: { ...payload, id: 'form_native', sessionID: 'ses_owner' },
          }),
        );
      } else if (
        url === '/api/session/ses_owner/form/form_native' &&
        request.method === 'GET'
      ) {
        response.end(
          JSON.stringify({
            data: {
              state: { status: 'answered', answer: { exclusive: 'archive' } },
            },
          }),
        );
      } else if (
        url === '/api/session/ses_owner/form/form_native' &&
        request.method === 'DELETE'
      ) {
        response.writeHead(204).end();
      } else {
        response.writeHead(404).end('{}');
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    assert(address && typeof address !== 'string');
    await mkdir(join(state, 'opencode'));
    await writeFile(
      join(state, 'opencode/service.json'),
      JSON.stringify({
        url: `http://127.0.0.1:${address.port}`,
        pid: process.pid,
        version: '2.0.24',
        password,
      }),
    );

    await assert.rejects(
      desktopClient(
        { directory: '/synthetic/project' },
        randomUUID(),
        new AbortController().signal,
      ),
      /not the server hosting/,
    );
    assert.equal(forms.length, 0);
    const host = await desktopClient(
      { directory: '/synthetic/project' },
      instanceID,
      new AbortController().signal,
    );
    const answer = await host.ask('ses_owner', 'Archive session tree?', [
      {
        key: 'exclusive',
        type: 'string',
        required: true,
        custom: true,
        options: [{ value: 'archive', label: 'I have exclusive use; archive' }],
      },
    ]);
    assert.deepEqual(answer, { exclusive: 'archive' });
    await host.report(
      'ses_owner',
      'Session archives',
      'No session archives in this project.',
    );
    assert.equal(forms.length, 2);
    for (const form of forms) {
      assert.deepEqual(form.metadata, { kind: 'question' });
      assert(Array.isArray(form.fields));
      assert.equal(form.fields[0].type, 'string');
    }
    assert(
      requests.some((url) =>
        url.startsWith('/api/rpc/simpod-session-archive/instance'),
      ),
    );
  },
);
