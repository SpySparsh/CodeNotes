const http = require('http');

const PORT = process.env.MOCK_AUTH_PORT || 54321;
const HOST = '127.0.0.1';

const MOCK_USER = {
  id: 'ba7d21ff-8535-4c92-ab4d-e8f37b17ac4d',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'e2e-user@example.com',
  email_confirmed_at: '2026-01-01T00:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { name: 'E2E Test User' },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || '*'
  );
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (url.pathname === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url.pathname.startsWith('/auth/v1/user')) {
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Bearer ') && authHeader.length > 7) {
        res.writeHead(200);
        res.end(JSON.stringify(MOCK_USER));
      } else {
        res.writeHead(401);
        res.end(JSON.stringify({ message: 'Invalid or missing JWT', status: 401 }));
      }
      return;
    }

    if (url.pathname.startsWith('/auth/v1/signup')) {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          access_token: 'mock-e2e-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: 1893456000,
          refresh_token: 'mock-e2e-refresh-token',
          user: MOCK_USER,
          session: {
            access_token: 'mock-e2e-access-token',
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: 1893456000,
            refresh_token: 'mock-e2e-refresh-token',
            user: MOCK_USER,
          },
        })
      );
      return;
    }

    if (url.pathname.startsWith('/auth/v1/token')) {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          access_token: 'mock-e2e-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: 1893456000,
          refresh_token: 'mock-e2e-refresh-token',
          user: MOCK_USER,
          session: {
            access_token: 'mock-e2e-access-token',
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: 1893456000,
            refresh_token: 'mock-e2e-refresh-token',
            user: MOCK_USER,
          },
        })
      );
      return;
    }

    if (url.pathname.startsWith('/auth/v1/logout')) {
      res.writeHead(200);
      res.end(JSON.stringify({}));
      return;
    }

    if (url.pathname.startsWith('/auth/v1/settings')) {
      res.writeHead(200);
      res.end(JSON.stringify({ external: { google: true } }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Mock Supabase Auth Server running on http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
