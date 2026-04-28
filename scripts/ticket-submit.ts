#!/usr/bin/env node
import { io } from 'socket.io-client';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { z } from 'zod';

const BASE_URL = process.env.API_URL ?? 'http://localhost:3000';

async function prompt(question: string) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

const subject = process.argv[2] ?? await prompt('Subject: ');
const body    = process.argv[3] ?? await prompt('Body:    ');

if (!subject || !body) {
  console.error('subject and body required');
  process.exit(1);
}

console.log('\nSubmitting ticket...');
const res = await fetch(`${BASE_URL}/tickets`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ subject, body }),
});

if (!res.ok) {
  console.error(`POST /tickets failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const TicketResponse = z.object({ ticketId: z.string() });
const parsed = TicketResponse.safeParse(await res.json());
if (!parsed.success) {
  console.error('unexpected response shape', parsed.error.issues);
  process.exit(1);
}
const id = parsed.data.ticketId;
console.log(`Ticket created: ${id}`);
console.log('Watching events (ctrl+c to stop)...\n');

const s = io(BASE_URL);
s.on('connect', () => s.emit('subscribe', id));
s.on('ticket:event', e => {
  const { event_type, phase, created_at, payload } = e;
  const time = new Date(created_at).toLocaleTimeString();
  const meta = payload && Object.keys(payload).length ? '  ' + JSON.stringify(payload) : '';
  console.log(`[${time}] ${event_type}${phase ? ` (${phase})` : ''}${meta}`);
});
s.on('disconnect', () => console.log('\ndisconnected'));
