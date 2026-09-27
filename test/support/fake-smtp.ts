import { SMTPServer, type SMTPServerAddress } from 'smtp-server';

export type FakeSmtpMode = 'accept' | 'reject550' | 'reject451' | 'hang';
export type FakeSmtp = {
  port: number;
  closedConnections(): number;
  close(): Promise<void>;
};

const rejection = (code: number, address: SMTPServerAddress) =>
  Object.assign(new Error(`<${address.address}>: Recipient address rejected`), {
    responseCode: code,
  });

/** SMTP giả cho đường lỗi (Mailpit chỉ nhận). `hang`: nhận RCPT rồi không bao giờ trả lời DATA. */
export async function startFakeSmtp(mode: FakeSmtpMode): Promise<FakeSmtp> {
  let closed = 0;
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onRcptTo(address, _session, cb) {
      if (mode === 'reject550') return cb(rejection(550, address));
      if (mode === 'reject451') return cb(rejection(451, address));
      cb();
    },
    onData(stream, _session, cb) {
      stream.resume();
      if (mode === 'hang') return;
      stream.on('end', () => cb());
    },
    onClose() {
      closed++;
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Fake SMTP did not bind a TCP port');
  }
  const { port } = address;
  return {
    port,
    closedConnections: () => closed,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
