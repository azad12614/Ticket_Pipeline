import { io } from 'socket.io-client';

const TICKET_ID = process.argv[2];
if (!TICKET_ID) {
  console.error('usage: node scripts/ticket-watch.ts <ticketId>');
  process.exit(1);
}

const BASE_URL = process.env.API_URL ?? 'http://localhost:3000';
const s = io(BASE_URL);
s.on('connect', () => { console.log('connected'); s.emit('subscribe', TICKET_ID); });
s.on('ticket:event', e => console.log(JSON.stringify(e, null, 2)));
s.on('disconnect', () => console.log('disconnected'));
