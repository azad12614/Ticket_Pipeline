import { io } from 'socket.io-client';

const TICKET_ID = process.argv[2];
if (!TICKET_ID) {
  console.error('usage: node scripts/ticket-watch.mjs <ticketId>');
  process.exit(1);
}

const s = io('http://localhost:3000');
s.on('connect', () => { console.log('connected'); s.emit('subscribe', TICKET_ID); });
s.on('ticket:event', e => console.log(JSON.stringify(e, null, 2)));
s.on('disconnect', () => console.log('disconnected'));
