import { Receiver } from "@/core/receiver";
import { BaseClient } from "@";
import { WebSocket } from "ws";
import { OpCode } from "@/constans";

export class WebsocketReceiver extends Receiver {
    state: WebsocketReceiver.State;
    ws: WebSocket | null = null;
    url?: URL;
    session_id?: string;
    
    get logger() {
        return this.c.logger;
    }
    
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private messageListener?: (data: string) => void;
    private eventListeners: Map<string, (...args: any[]) => void> = new Map();

    constructor(client: BaseClient, public config: WebsocketReceiver.Config) {
        super(client);
        this.state = WebsocketReceiver.State.Initial;
    }

    async #getGateway(compress: 0 | 1): Promise<string> {
        try {
            const res = await this.c.request.get('/v3/gateway/index', {
                params: { compress }
            });
            return res.data.url;
        } catch (error) {
            this.logger.error('Failed to get gateway:', error);
            throw error;
        }
    }

    async #receiveHelloCode(): Promise<number> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('WebSocket receive hello code timeout'));
            }, 5000);

            const helloListener = (data: Receiver.HelloPacket['d']) => {
                clearTimeout(timer);
                this.session_id = data.session_id;
                resolve(data.code);
                this.off('hello', helloListener);
            };

            this.on('hello', helloListener);
        });
    }

    #sendPing() {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ s: OpCode.Ping }));
        }
    }

    #setupPingInterval() {
        this.#clearPingInterval();
        const pingInterval = 25000 + Math.floor(Math.random() * 5000);
        const timer = setInterval(() => this.#sendPing(), pingInterval);
        this.timers.set('ping', timer);
    }

    #clearPingInterval() {
        const timer = this.timers.get('ping');
        if (timer) {
            clearInterval(timer);
            this.timers.delete('ping');
        }
    }

    #startListen() {
        this.#stopListen(); // Clean up previous listeners

        this.messageListener = (rawData) => {
            try {
                const data = JSON.parse(this.decryptData(
                    rawData.toString(),
                    this.config.encrypt_key ?? ''
                ));

                if (data.sn) this.sn = data.sn;

                switch (data.s) {
                    case OpCode.Hello:
                        this.emit('hello', data.d);
                        break;
                    case OpCode.Event:
                        this.emit('event', data.d);
                        break;
                    case OpCode.Reconnect:
                        this.reconnect();
                        break;
                    case OpCode.ResumeAck:
                        this.emit('resume', data.d);
                        break;
                    case OpCode.Pong:
                        this.logger.debug('Received pong from server');
                        break;
                    default:
                        this.logger.warn('Unknown opcode received:', data.s);
                }
            } catch (error) {
                this.logger.error('Error processing message:', error);
            }
        };

        this.ws?.on('message', this.messageListener);

        // Setup error and close handlers
        this.ws?.on('error', (error) => {
            this.logger.error('WebSocket error:', error);
            this.reconnect();
        });

        this.ws?.on('close', () => {
            this.logger.info('WebSocket connection closed');
            this.state = WebsocketReceiver.State.Closed;
            this.reconnect();
        });

        this.ws?.on('open', () => {
            this.logger.info('WebSocket connection established');
            this.state = WebsocketReceiver.State.Open;
        });
    }

    #stopListen() {
        if (this.messageListener && this.ws) {
            this.ws.off('message', this.messageListener);
        }
        this.ws?.removeAllListeners();
    }

    async reconnect() {
        this.logger.info('Attempting to reconnect...');
        this.state = WebsocketReceiver.State.Reconnecting;
        
        try {
            await this.disconnect();
            await this.connect(true);
        } catch (error) {
            this.logger.error('Reconnect failed:', error);
            setTimeout(() => this.reconnect(), 5000);
        }
    }

    async connect(isReconnect = false): Promise<void> {
        this.state = WebsocketReceiver.State.PullingGateway;
        
        try {
            const url = new URL(await this.#getGateway(this.config.compress ? 1 : 0));
            
            if (isReconnect && this.session_id) {
                const params = new URLSearchParams();
                if (this.sn) params.append('sn', this.sn);
                params.append('session_id', this.session_id);
                params.append('resume', '1');
                url.search = params.toString();
            }

            this.url = url;
            this.ws = new WebSocket(url.toString());
            this.#startListen();

            const receiveCode = await this.#receiveHelloCode();
            if (receiveCode !== 0) {
                throw new Error(`WebSocket connect failed, receive code: ${receiveCode}`);
            }

            this.#setupPingInterval();
            this.state = WebsocketReceiver.State.Open;
        } catch (error) {
            this.logger.error('Connect failed:', error);
            await this.disconnect();
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        this.state = WebsocketReceiver.State.Closed;
        
        this.#clearPingInterval();
        this.#stopListen();
        
        if (this.ws) {
            return new Promise((resolve) => {
                this.ws?.once('close', resolve);
                this.ws?.close();
                this.ws = null;
            });
        }
    }
}

export namespace WebsocketReceiver {
    export interface Config {
        token: string;
        compress?: boolean;
        encrypt_key?: string;
    }

    export enum State {
        Initial,
        PullingGateway,
        Connecting,
        Open,
        Closed,
        Reconnecting
    }
}

Receiver.register('websocket', WebsocketReceiver);
