import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import routes from './routes/api.js';
import { requireAuth } from './auth.js';
import { startScheduler } from './collector.js';
import { stats } from './analysis.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function build() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, trustProxy: true, bodyLimit: 25 * 1024 * 1024 });

  await app.register(cookie);
  await app.register(compress, { global: true, encodings: ['br', 'gzip'] });
  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (req, body, done) => done(null, body));
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (req, body, done) => done(null, body));

  // Security headers (no inline scripts are used, so a strict CSP works).
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    if (!req.url.startsWith('/api/')) {
      reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'");
    }
  });
  app.addHook('onRequest', requireAuth);

  // Simple in-memory rate limit for the login endpoint.
  const attempts = new Map();
  app.addHook('preHandler', async (req, reply) => {
    if (req.url !== '/api/login' || req.method !== 'POST') return;
    const now = Date.now();
    const rec = attempts.get(req.ip) || { count: 0, reset: now + 15 * 60_000 };
    if (rec.reset < now) Object.assign(rec, { count: 0, reset: now + 15 * 60_000 });
    rec.count++;
    attempts.set(req.ip, rec);
    if (rec.count > 20) return reply.code(429).send({ error: 'Too many attempts, try again later' });
  });

  await app.register(routes);

  // Static assets: Chart.js straight from node_modules (immutable), app files with revalidation.
  await app.register(fastifyStatic, { root: join(root, 'node_modules/chart.js/dist'), prefix: '/vendor/chartjs/', decorateReply: false, maxAge: '365d', immutable: true });
  await app.register(fastifyStatic, { root: join(root, 'public'), prefix: '/', cacheControl: true, maxAge: 0, etag: true, lastModified: true });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await build();
  try {
    await app.listen({ port: config.port, host: config.host });
    const s = stats();
    app.log.info(`Competitor Pulse ready: ${s.competitors} competitors, ${s.accounts} accounts, ${s.posts} posts. Login ${config.password ? 'enabled' : 'disabled (set DASHBOARD_PASSWORD)'}.`);
    console.log(`\n  ➜  Open http://localhost:${config.port} in your browser${s.posts ? '' : '  (tip: run "npm run seed" first to see demo data)'}\n`);
    startScheduler(app.log);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${config.port} is already in use. Stop the other program or start with a different port, e.g.:\n  PORT=4000 npm start   (Windows PowerShell: $env:PORT=4000; npm start)\n`);
    } else if (err.code === 'EACCES') {
      console.error(`\nNo permission to listen on port ${config.port}. Use a port above 1024, e.g. PORT=3000 npm start.\n`);
    } else {
      app.log.error(err);
    }
    process.exit(1);
  }
}
