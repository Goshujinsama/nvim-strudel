import { WebSocketServer, WebSocket } from 'ws';
import type { ServerConfig, ClientMessage, ServerMessage } from './types.js';

export class StrudelWebSocketServer {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private messageHandler: ((msg: ClientMessage, ws: WebSocket) => void) | null = null;

  constructor(private config: ServerConfig) {}

  /**
   * Start the WebSocket server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          port: this.config.port,
          host: this.config.host,
        });

        this.wss.on('listening', () => {
          console.log(`[strudel-server] WebSocket server listening on ${this.config.host}:${this.config.port}`);
          resolve();
        });

        this.wss.on('connection', (ws) => {
          console.log('[strudel-server] Client connected');
          this.clients.add(ws);

          ws.on('message', (data) => {
            try {
              const msg = JSON.parse(data.toString()) as ClientMessage;
              if (this.messageHandler) {
                this.messageHandler(msg, ws);
              }
            } catch (err) {
              console.error('[strudel-server] Failed to parse message:', err);
            }
          });

          ws.on('close', () => {
            console.log('[strudel-server] Client disconnected');
            this.clients.delete(ws);
          });

          ws.on('error', (err) => {
            console.error('[strudel-server] WebSocket error:', err);
            this.clients.delete(ws);
          });

          // Send initial status
          this.send(ws, {
            type: 'status',
            playing: false,
            cycle: 0,
            cps: 1,
          });
        });

        this.wss.on('error', (err) => {
          console.error('[strudel-server] Server error:', err);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the WebSocket server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss) {
        // Close all client connections
        for (const client of this.clients) {
          client.close();
        }
        this.clients.clear();

        this.wss.close(() => {
          console.log('[strudel-server] Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Register a message handler
   */
  onMessage(handler: (msg: ClientMessage, ws: WebSocket) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Send a message to a specific client
   */
  send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg) + '\n');
    }
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg) + '\n';
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Get the number of connected clients
   */
  get clientCount(): number {
    return this.clients.size;
  }
}
