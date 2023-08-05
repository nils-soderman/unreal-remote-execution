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


type ObjectValues<T> = T[keyof T];

/** Struct containing all the different output types */
export const ECommandOutputType = {
    info: "Info",
    warning: "Warning",
    error: "Error"
} as const;
type CommandOutputType = ObjectValues<typeof ECommandOutputType>;

/** Struct containing the different execution modes */
export const EExecMode = {
    ExecuteFile: "ExecuteFile",               // Execute the Python command as a file. This allows you to execute either a literal Python script containing multiple statements, or a file with optional arguments
    ExecuteStatement: "ExecuteStatement",     // Execute the Python command as a single statement. This will execute a single statement and print the result. This mode cannot run files
    EvaluateStatement: "EvaluateStatement"
} as const;
type ExecMode = ObjectValues<typeof EExecMode>;



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
type CommandType = ObjectValues<typeof ECommandTypes>;


interface IRemoteExecutionMessage {
    version: number,
    magic: string,
    source: string,
    type: CommandType,
    dest?: string,
    data?: any
}


interface IRemoteExecutionNodeData {
    engine_root: string
    engine_version: string
    machine: string
    project_name: string
    project_root: string
    user: string
}

export class RemoteExecutionConfig {
    constructor(
        public readonly multicastTTL: number = 0,
        public readonly multicastGroupEndpoint: [string, number] = ['239.0.0.1', 6766],
        public readonly multicastBindAddress: string = '0.0.0.0',
        public readonly commandEndpoint: [string, number] = ["127.0.0.1", 6776]
    ) { }
}

// --------------------------------------------------------------------------------------------
//                                      EVENT MANAGER
// --------------------------------------------------------------------------------------------
type Listener<T extends Array<any>> = (...args: T) => void;

export class EventManager<EventMap extends Record<string, Array<any>>> {
    private eventListeners: {
        [K in keyof EventMap]?: Set<Listener<EventMap[K]>>;
    } = {};

    public emit<K extends keyof EventMap>(eventName: K, ...args: EventMap[K]) {
        const listeners = this.eventListeners[eventName] ?? new Set();
        for (const listener of listeners) {
            listener(...args);
        }
    }

    public addEventListener<K extends keyof EventMap>(eventName: K, listener: Listener<EventMap[K]>) {
        const listeners = this.eventListeners[eventName] ?? new Set();
        listeners.add(listener);
        this.eventListeners[eventName] = listeners;
    }

    public once<K extends keyof EventMap>(eventName: K, listener: Listener<EventMap[K]>) {
        const wrappedListener: Listener<EventMap[K]> = (...args) => {
            listener(...args);
            this.removeEventListener(eventName, wrappedListener);
        };
        this.addEventListener(eventName, wrappedListener);
    }

    public removeEventListener<K extends keyof EventMap>(eventName: K, listener: Listener<EventMap[K]>) {
        const listeners = this.eventListeners[eventName];
        if (listeners) {
            listeners.delete(listener);
        }
    }


}



// --------------------------------------------------------------------------------------------
//                                    REMOTE EXECUTION
// --------------------------------------------------------------------------------------------

class RemoteExecution {
    readonly nodeId: string;

    private commandConnection?: RemoteExecutionCommandConnection;
    private broadcastConnection: RemoteExecutionBroadcastConnection;
    private events: { [key: string]: ((...args: any[]) => void)[] } = {};

    constructor(
        readonly config = new RemoteExecutionConfig()
    ) {
        this.nodeId = crypto.randomUUID();
        this.broadcastConnection = new RemoteExecutionBroadcastConnection(this.config, this.nodeId);
    }

    get remoteNodes(): RemoteExecutionNode[] {
        return this.broadcastConnection?.remoteNodes || []
    }

    /**
     * Start broadcasting server searching for available nodes.
     */
    public async start() {
        await this.broadcastConnection.open();
    }

    public stop() {
        this.closeCommandConnection();
        this.broadcastConnection.close();
    }

    public hasCommandConnection() {
        return this.commandConnection != undefined;
    }

    public async openCommandConnection(node: RemoteExecutionNode) {
        this.commandConnection = new RemoteExecutionCommandConnection(this.config, this.nodeId, node);
        await this.commandConnection.open(this.broadcastConnection);
    }

    public closeCommandConnection() {
        if (this.commandConnection) {
            this.commandConnection.close(this.broadcastConnection);
            this.commandConnection = undefined;
        }
    }

    public getFirstRemoteNode(): Promise<RemoteExecutionNode> {
        return new Promise((resolve, reject) => {
            if (this.remoteNodes.length > 0) {
                resolve(this.remoteNodes[0]!);
            }

            this.broadcastConnection.events.once('nodeFound', (node) => {
                resolve(node);
            });
        });
    }

    public runCommand(command: string, unattended = true, execMode: ExecMode = EExecMode.ExecuteFile, raiseOnFailure = false) {
        if (!this.commandConnection) {
            throw new Error('No command connection open!');
        }

        this.commandConnection.runCommand(command, unattended, execMode);
    }
}



// --------------------------------------------------------------------------------------------
//                               BROADCAST CONNECTION
// --------------------------------------------------------------------------------------------
type BroadcastEventMap = {
    nodeFound: [RemoteExecutionNode];
}

class RemoteExecutionBroadcastConnection {
    public nodes: { [key: string]: RemoteExecutionNode } = {};
    private broadcastSocket?: dgram.Socket;
    private broadcastListenThread?: NodeJS.Timeout;

    public events: EventManager<BroadcastEventMap>;

    constructor(
        readonly config: RemoteExecutionConfig,
        readonly nodeId: string
    ) {
        this.events = new EventManager();
    }

    get remoteNodes() {
        return Object.values(this.nodes);
    }

    public async open(bPeriodicBroadcast = true) {
        this.timeoutRemoteNodes();
        await this.initBroadcastSocket();
        this.broadcastPing();
        if (bPeriodicBroadcast)
            this.initBroadcastListenThread();
    }

    public close() {
        if (this.broadcastSocket) {
            this.broadcastSocket.close();
            this.broadcastSocket = undefined;
        }

        clearInterval(this.broadcastListenThread);
        this.nodes = {};
    }


    /**
     * Send a ping message to all nodes. This will discover new nodes and update existing ones.
     */
    public broadcastPing() {
        const now = Date.now();
        this.broadcastMessage(new RemoteExecutionMessage(ECommandTypes.ping, this.nodeId))
        this.timeoutRemoteNodes(now);
    }

    public broadcastOpenConnection(node: RemoteExecutionNode) {
        const data = {
            command_ip: this.config.commandEndpoint[0],
            command_port: this.config.commandEndpoint[1]
        };
        const message = new RemoteExecutionMessage(ECommandTypes.openConnection, this.nodeId, node.nodeId, data);
        this.broadcastMessage(message);
    }

    /**
     * 
     * @returns Promise that resolves when the socket is ready to send/receive data.
     */
    private initBroadcastSocket(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.broadcastSocket)
                return reject(new Error('Broadcast socket already initialized!'));

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

                resolve();
            });

            this.broadcastSocket.on('message', this.handleData.bind(this));

            this.broadcastSocket.bind({
                address: this.config.multicastBindAddress,
                port: this.config.multicastGroupEndpoint[1]
            });
        });
    }

    private initBroadcastListenThread(interval = NODE_PING_MILLISECONDS) {
        if (!this.broadcastListenThread) {
            this.broadcastListenThread = setInterval(this.broadcastPing.bind(this), interval);
        }
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
        this.handleMessage(RemoteExecutionMessage.fromBuffer(data));
    }

    private handleMessage(message: RemoteExecutionMessage) {
        if (!message.passesReceiveFilter(this.nodeId))
            return;

        if (message.type === ECommandTypes.pong) {
            this.handlePongMessage(message);
        }
    }

    private handlePongMessage(message: RemoteExecutionMessage) {
        this.updateRemoteNode(message.source, message.data);
    }

    private updateRemoteNode(nodeId: string, data: IRemoteExecutionNodeData, now = Date.now()) {
        const node = this.nodes[nodeId];
        if (node) {
            node.update(data, now);
        }
        else {
            console.log(`New node discovered: ${nodeId}`);
            const node = new RemoteExecutionNode(nodeId, data, now);
            this.nodes[nodeId] = node;
            this.events.emit('nodeFound', node);
        }
    }

    private timeoutRemoteNodes(now = Date.now()) {
        for (const [nodeId, node] of Object.entries(this.remoteNodes)) {
            if (node.shouldTimeout(now)) {
                console.log(`Node timed out: ${nodeId}`);
                delete this.nodes[nodeId];
            }
        }
    }


}



class RemoteExecutionNode {
    public lastPong: number;

    constructor(
        public readonly nodeId: string,
        public data: IRemoteExecutionNodeData,
        now?: number
    ) {
        this.lastPong = now || Date.now();
    }

    public update(data: IRemoteExecutionNodeData, now?: number) {
        this.data = data;
        this.lastPong = now || Date.now();
    }

    public shouldTimeout(now?: number) {
        return this.lastPong + NODE_TIMEOUT_MILLISECONDS < (now || Date.now());
    }
}


// --------------------------------------------------------------------------------------------
//                                    COMMAND CONNECTION
// --------------------------------------------------------------------------------------------

class RemoteExecutionCommandConnection {
    private server: net.Server;
    private commandChannelSocket?: net.Socket;

    constructor(
        readonly config: RemoteExecutionConfig,
        readonly sourceNodeId: string,
        readonly remoteNode: RemoteExecutionNode
    ) {
        this.server = net.createServer();
    }

    public async open(broadcastConnection: RemoteExecutionBroadcastConnection) : Promise<void> {
        return new Promise((resolve, reject) => {
            this.server.once('connection', (socket) => {
                this.commandChannelSocket = socket;
                resolve();
            });

            this.server.listen(this.config.commandEndpoint[1], this.config.commandEndpoint[0], 1, () => {
                broadcastConnection.broadcastOpenConnection(this.remoteNode);
            });
        });
    }

    public close(broadcastConnection: RemoteExecutionBroadcastConnection) {
        this.server.close();
        this.commandChannelSocket?.destroy();
    }

    public runCommand(command: string, unattended: boolean, execMode: keyof typeof EExecMode) {
        if (!this.commandChannelSocket) {
            throw new Error('No command channel open!');
        }

        const message = new RemoteExecutionMessage(ECommandTypes.command, this.sourceNodeId, this.remoteNode.nodeId, {
            'command': command,
            'unattended': unattended,
            'exec_mode': execMode,
        });

        

        this.commandChannelSocket.write(message.toJson());
    }


}


// --------------------------------------------------------------------------------------------
//                                         MESSAGE
// --------------------------------------------------------------------------------------------

class RemoteExecutionMessage {
    constructor(
        readonly type: CommandType,
        readonly source: string,
        readonly dest?: string,
        readonly data?: any
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



// --------------------------------------------------------------------------------------------
//                                         DEV TESTING
// --------------------------------------------------------------------------------------------

const exec = new RemoteExecution();
exec.start();
exec.getFirstRemoteNode().then(async (node) => {
    await exec.openCommandConnection(node);
    exec.runCommand('print("Hello World!")', EExecMode.ExecuteFile);
});