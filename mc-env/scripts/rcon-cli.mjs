import net from 'node:net';
import { loadConfig } from './utils.mjs';

function encodeRconPacket(id, type, body) {
  const bodyBuf = Buffer.from(body, 'utf8');
  const packetLen = 4 + 4 + bodyBuf.length + 2;
  const buf = Buffer.alloc(4 + packetLen);
  buf.writeInt32LE(packetLen, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf[12 + bodyBuf.length] = 0;
  buf[13 + bodyBuf.length] = 0;
  return buf;
}

export class RconClient {
  constructor({ host = '127.0.0.1', port = 25575, password = '', timeoutMs = 8000 }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.nextId = 10;
    this.rxBuf = Buffer.alloc(0);
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`RCON connection timed out (${this.host}:${this.port})`));
      }, this.timeoutMs);

      socket.on('error', (err) => {
        clearTimeout(timer);
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        reject(err);
      });

      socket.on('data', (chunk) => {
        this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
        while (this.rxBuf.length >= 4) {
          const pktLen = this.rxBuf.readInt32LE(0);
          if (this.rxBuf.length < 4 + pktLen) break;

          const id = this.rxBuf.readInt32LE(4);
          const type = this.rxBuf.readInt32LE(8);
          const body = this.rxBuf.toString('utf8', 12, 4 + pktLen - 2);
          this.rxBuf = this.rxBuf.subarray(4 + pktLen);

          if (id === -1) {
            const authReq = this.pending.get('auth');
            if (authReq) {
              this.pending.delete('auth');
              authReq.reject(new Error('RCON authentication failed (bad password)'));
            }
          } else if (this.pending.has('auth') && id === 1) {
            const authReq = this.pending.get('auth');
            this.pending.delete('auth');
            authReq.resolve(true);
          } else if (this.pending.has(id)) {
            const req = this.pending.get(id);
            this.pending.delete(id);
            req.resolve({ id, type, body });
          }
        }
      });

      socket.once('connect', () => {
        this.pending.set('auth', {
          resolve: () => {
            clearTimeout(timer);
            resolve(this);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          }
        });
        socket.write(encodeRconPacket(1, 3, this.password));
      });
    });
  }

  async send(command) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('RCON socket is not connected');
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RCON command timed out: ${command}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (pkt) => {
          clearTimeout(timer);
          resolve(pkt.body);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      this.socket.write(encodeRconPacket(id, 2, command));
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
      this.socket.destroy();
    }
  }
}

async function main() {
  const cfg = loadConfig();
  const args = process.argv.slice(2);
  let profileName = '1.21.11-fabric';
  const commands = [];

  for (const arg of args) {
    if (arg.startsWith('--profile=')) {
      profileName = arg.split('=')[1];
    } else {
      commands.push(arg);
    }
  }

  const profile = cfg.serverProfiles[profileName];
  if (!profile) {
    throw new Error(`Unknown server profile: ${profileName}`);
  }
  if (commands.length === 0) {
    commands.push('list');
  }

  const client = new RconClient({
    host: profile.host,
    port: profile.rconPort,
    password: profile.rconPassword
  });

  await client.connect();
  try {
    for (const cmd of commands) {
      const resp = await client.send(cmd);
      console.log(`> ${cmd}\n${resp}`);
    }
  } finally {
    client.close();
  }
}

if (process.argv[1]?.endsWith('rcon-cli.mjs')) {
  main().catch((err) => {
    console.error('[RCON]', err.message);
    process.exit(1);
  });
}
