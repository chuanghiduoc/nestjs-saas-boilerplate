// Receiver webhook CHỈ của smoke (spec SP6 X-4): HTTPS 443 bằng chứng chỉ của CA smoke, ghi nhận request vào bộ nhớ,
// `GET /received` trả JSON để test đọc qua `docker compose exec`. Không xác minh chữ ký: test ở host làm việc đó.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const received = [];
const server = createServer(
  {
    key: readFileSync('/certs/server.key'),
    cert: readFileSync('/certs/server.crt'),
  },
  (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz')
      return res.writeHead(200).end('ok');
    if (req.method === 'GET' && req.url === '/received') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(received));
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(204).end();
    });
  },
);
server.listen(443, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
