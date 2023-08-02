/**
 * Remote connection between TypeScript & Unreal Engine.
 */

import { assert } from 'console';
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as net from 'net';
import { Interface } from 'readline';

const PROTOCOL_VERSION = 1;      // Protocol version number
const PROTOCOL_MAGIC = 'ue_py';  // Protocol magic identifier

const NODE_PING_MILLISECONDS = 1000;
const NODE_TIMEOUT_MILLISECONDS = 5000;

/** Struct containing all the different output types */
export const ECommandOutputType = {
    info: "Info",
    warning: "Warning",
    error: "Error"
} as const;


/** Struct containing the different execution modes */
export const EExecMode = {
    execFile: "ExecuteFile",               // Execute the Python command as a file. This allows you to execute either a literal Python script containing multiple statements, or a file with optional arguments
    execStatement: "ExecuteStatement",     // Execute the Python command as a single statement. This will execute a single statement and print the result. This mode cannot run files
    evalStatement: "EvaluateStatement"
} as const;


/** struct containing the different command types */
export const ECommandTypes = {
    /** Service discovery request (UDP) */
    ping: "ping",
    /** Service discovery response (UDP) */
    pong: "pong",
    /** Open a TCP command connection with the requested server (UDP) */
    openConnection: "open_connection",
    closeConnection: "close_connection",   // Close any active TCP command connection (UDP)
    command: "command",                    // Execute a remote Python command (TCP)
    commandResults: "command_result"       // Result of executing a remote Python command (TCP)
} as const;


interface IRemoteExecutionMessage {
    version: number,
    magic: string,
    source: string,
    type: string,
    dest?: string,
    data?: any
}


export class RemoteExecutionConfig {
    constructor(
        public readonly multicastTTL: number = 0,
        public readonly multicastGroupEndpoint: [string, number] = ['239.0.0.1', 6766],
        public readonly multicastBindAddress: string = '0.0.0.0',
        public readonly commandEndpoint: [string, number] = ["127.0.0.1", 6776]
    ) { }
}


class RemoteExecution {
    readonly nodeId: string;

    private commandConnection?: any;
    private broadcastConnection?: RemoteExecutionBroadcastConnection;

    constructor(
        readonly config = new RemoteExecutionConfig()
    ) {
        this.nodeId = crypto.randomUUID();
    }

    get remoteNodes() {
        return this.broadcastConnection?.remoteNodes || []
    }

    public start() {
        this.broadcastConnection = new RemoteExecutionBroadcastConnection(this.config, this.nodeId);
        this.broadcastConnection.open();
    }

    public stop() {
        this.closeCommandConnection();
        if (this.broadcastConnection) {
            this.broadcastConnection.close();
            this.broadcastConnection = undefined;
        }
    }

    public hasCommandConnection() {
        return this.commandConnection != undefined;
    }

    public openCommandConnection(remoteNodeId: string) {
        this.commandConnection = new RemoteExecutionCommandConnection(this.config, this.nodeId, remoteNodeId);
        this.commandConnection.open();
    }

    public closeCommandConnection() {
        if (this.commandConnection) {
            this.commandConnection.close();
            this.commandConnection = undefined;
        }
    }

    public runCommand(command: string, unattended = true, execMode = EExecMode.execFile, raiseOnFailure = false) {

    }
}


class RemoteExecutionBroadcastConnection {
    private nodes?: RemoteExecutionBroadcastNodes;
    private running = false;
    private broadcastSocket?: dgram.Socket;
    private broadcastListenThread?: NodeJS.Timeout;
    private lastPing?: number;

    constructor(
        readonly config: RemoteExecutionConfig,
        readonly nodeId: string
    ) { }

    get remoteNodes() {
        return this.nodes?.remoteNodes || []
    }

    public open() {
        this.running = true;
        this.lastPing = undefined
        this.nodes = new RemoteExecutionBroadcastNodes();
        this.initBroadcastSocket();
        this.initBroadcastListenThread();
    }

    public close() {
        this.running = false;
        if (this.broadcastSocket) {
            this.broadcastSocket.close();
            this.broadcastSocket = undefined;
        }

        clearInterval(this.broadcastListenThread);
        this.nodes = undefined;
    }

    private initBroadcastSocket() {
        this.broadcastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.broadcastSocket.on('listening', () => {
            if (!this.broadcastSocket)
                return;

            const address = this.broadcastSocket.address()
            console.log(`Server listening ${address.address}:${address.port}`)

            this.broadcastSocket.setMulticastLoopback(true);
            this.broadcastSocket.setMulticastTTL(this.config.multicastTTL);
            this.broadcastSocket.setMulticastInterface(this.config.multicastBindAddress);
            this.broadcastSocket.addMembership(this.config.multicastGroupEndpoint[0], this.config.multicastBindAddress);
        });

        this.broadcastSocket.on('message', this.handleData.bind(this));

        this.broadcastSocket.bind({
            address: this.config.multicastBindAddress,
            port: this.config.multicastGroupEndpoint[1]
        });
    }

    private initBroadcastListenThread() {
        this.broadcastListenThread = setInterval(() => {
            const now = Date.now();
            this.broadcastPing(now)
            this.nodes?.timeoutRemoteNodes(now)
        }, NODE_PING_MILLISECONDS)
    }

    private broadcastPing(now: number) {
        this.lastPing = now
        this.broadcastMessage(new RemoteExecutionMessage(ECommandTypes.ping, this.nodeId))
    }

    private broadcastMessage(message: RemoteExecutionMessage): void {
        const data = message.toJson()
        this.broadcastSocket?.send(
            data,
            this.config.multicastGroupEndpoint[1],
            this.config.multicastGroupEndpoint[0]
        )
    }

    private handleData(data: Buffer, remote: dgram.RemoteInfo) {
        this.handleMessage(RemoteExecutionMessage.fromBuffer(data), remote);
    }

    private handleMessage(message: RemoteExecutionMessage, remote: dgram.RemoteInfo) {
        if (!message.passesReceiveFilter(this.nodeId))
            return;

        if (message.type === ECommandTypes.pong) {
            this.handlePongMessage(message);
        }
    }

    private handlePongMessage(message: RemoteExecutionMessage) {
        this.nodes?.updateRemoteNode(message.source, message.data);
    }

}


class RemoteExecutionNode {
    public lastPong: number;

    constructor(
        public data: any,
        now?: number
    ) {
        this.lastPong = now || Date.now();
    }

    public update(data: any, now?: number) {
        this.data = data;
        this.lastPong = now || Date.now();
    }

    public shouldTimeout(now?: number) {
        return this.lastPong + NODE_TIMEOUT_MILLISECONDS < (now || Date.now());
    }
}


class RemoteExecutionBroadcastNodes {
    public remoteNodes: { [key: string]: RemoteExecutionNode } = {};

    constructor() { }

    updateRemoteNode(nodeId: string, data: any, now = Date.now()) {
        const node = this.remoteNodes[nodeId];
        if (node) {
            node.update(data, now);
        }
        else {
            console.log(`New node discovered: ${nodeId}`);
            this.remoteNodes[nodeId] = new RemoteExecutionNode(data, now);
        }
    }

    timeoutRemoteNodes(now = Date.now()) {
        for (const [nodeId, node] of Object.entries(this.remoteNodes)) {
            if (node.shouldTimeout(now)) {
                console.log(`Node timed out: ${nodeId}`);
                delete this.remoteNodes[nodeId];
            }
        }
    }

}

class RemoteExecutionCommandConnection {
    constructor(
        readonly config: RemoteExecutionConfig,
        readonly sourceNodeId: string,
        readonly destNodeId: string
    ) { }

    public open() {

    }

    public close() {

    }
}


class RemoteExecutionMessage {
    constructor(
        readonly type: string,
        readonly source: string,
        readonly dest?: string,
        readonly data?: {}
    ) { }


    public passesReceiveFilter(nodeId: string): boolean {
        return this.source != nodeId && (!this.dest || this.dest == nodeId)
    }

    public toJson() {
        if (!this.type)
            throw Error('"type" cannot be empty!');

        if (!this.source)
            throw Error('"source" cannot be empty!');

        let jsonObj: IRemoteExecutionMessage = {
            'version': PROTOCOL_VERSION,
            'magic': PROTOCOL_MAGIC,
            'source': this.source,
            'type': this.type,
        };

        if (this.dest) {
            jsonObj.dest = this.dest;
        }
        if (this.data) {
            jsonObj.data = this.data;
        }

        return JSON.stringify(jsonObj);
    }

    // public toJsonBytes() { } NOTE: Skipping this method for now, as it's not needed.

    public static fromJson(jsonStr: string): RemoteExecutionMessage {
        const jsonObj: IRemoteExecutionMessage = JSON.parse(jsonStr);

        if (jsonObj.version !== PROTOCOL_VERSION) {
            throw Error(`"version" is incorrect (got ${jsonObj.version}, expected ${PROTOCOL_VERSION})!`);
        }
        if (jsonObj.magic !== PROTOCOL_MAGIC) {
            throw Error(`"magic" is incorrect (got "${jsonObj.magic}", expected "${PROTOCOL_MAGIC}")!`);
        }

        return new RemoteExecutionMessage(
            jsonObj.type,
            jsonObj.source,
            jsonObj.dest,
            jsonObj.data
        );
    }

    public static fromBuffer(buffer: Buffer): RemoteExecutionMessage {
        const jsonStr = buffer.toString("utf-8"); // TODO: Specify utf-8 encoding? didn't do it in previous version
        return this.fromJson(jsonStr);
    }
}



// TESTING

const exec = new RemoteExecution();
exec.start();