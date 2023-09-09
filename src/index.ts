/**
 * RemoteExecution connection between NodeJS & Unreal Engine.
 */

import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as net from 'net';

const PROTOCOL_VERSION = 1;
const PROTOCOL_MAGIC = 'ue_py';

const NODE_PING_MILLISECONDS = 1000;
const NODE_TIMEOUT_MILLISECONDS = 5000;


type ObjectValues<T> = T[keyof T];

/** Object containing the different output types */
export const ECommandOutputType = {
    INFO: "Info",
    WARNING: "Warning",
    ERROR: "Error"
} as const;
type CommandOutputTypeT = ObjectValues<typeof ECommandOutputType>;


/** Object containing the different execution modes */
export const EExecMode = {
    EXECUTE_FILE: "ExecuteFile",
    EXECUTE_STATEMENT: "ExecuteStatement",
    EVALUATE_STATEMENT: "EvaluateStatement"
} as const;
type ExecModeT = ObjectValues<typeof EExecMode>;


/** Object containing the different command types */
const ECommandType = {
    PING: "ping",
    PONG: "pong",
    OPEN_CONNECTION: "open_connection",
    CLOSE_CONNECTION: "close_connection",
    COMMAND: "command",
    COMMAND_RESULT: "command_result"
} as const;
type CommandTypeT = ObjectValues<typeof ECommandType>;


interface IRemoteExecutionNodeData {
    engine_root: string
    engine_version: string
    machine: string
    project_name: string
    project_root: string
    user: string
}

interface IRemoteExecutionMessage {
    version: number,
    magic: string,
    source: string,
    type: CommandTypeT,
    dest?: string,
    data?: any
}

interface IRemoteExecutionMessageOpenConnectionData {
    command_ip: string
    command_port: number
}

export interface IRemoteExecutionMessageCommandOutputData {
    /** The command that was run. */
    command: string
    /** The output of the command. Such as print/log statements. */
    output: { type: CommandOutputTypeT, output: string }[]
    /** If an exception was raised, this will contain the traceback message. */
    result: string
    /** True if the command ran successfully without any errors. */
    success: boolean
}

interface IRemoteExecutionMessageCommandInputData {
    command: string
    unattended: boolean
    exec_mode: ExecModeT
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

type RemoteExecutionEvents = {
    nodeFound: [RemoteExecutionNode];
    nodeTimedOut: [RemoteExecutionNode];
    commandConnectionClosed: [];
};

// --------------------------------------------------------------------------------------------
//                                    REMOTE EXECUTION
// --------------------------------------------------------------------------------------------

function timeoutPromise(ms: number, reason?: string) {
    return new Promise((resolve, reject) => setTimeout(() => reject(new Error(reason)), ms));
}


export class RemoteExecutionConfig {

    /**
     * @param multicastTTL The TTL (Time To Live) that the UDP multicast socket should use. 0 = Limited to the local host, 1 = Limited to the same subnet
     * @param multicastGroupEndpoint The multicast group endpoint to use. [IP, Port]
     * @param multicastBindAddress The address to bind the multicast socket to.
     * @param commandEndpoint The endpoint to use for the command channel. [IP, Port]
     */
    constructor(
        public readonly multicastTTL: number = 0,
        public readonly multicastGroupEndpoint: [string, number] = ['239.0.0.1', 6766],
        public readonly multicastBindAddress: string = '0.0.0.0',
        public readonly commandEndpoint: [string, number] = ["127.0.0.1", 6776]
    ) { }
}


export class RemoteExecution {
    /** Event manager used to listen for specific events. */
    public events: EventManager<RemoteExecutionEvents>;

    /** Random UUID used to identify this node. */
    readonly nodeId: string;

    private broadcastConnection: RemoteExecutionBroadcastConnection;
    private commandConnection?: RemoteExecutionCommandConnection;

    connectedNode: RemoteExecutionNode | null = null;

    /**
     * The RemoteExecution class is used to find and connect to remote Unreal Engine instances.
     * @param config The configuration to use. Some of these settings must match the project settings in the Unreal Engine Python plugin for the Unreal Engine instance you want to connect to. 
     */
    constructor(
        readonly config = new RemoteExecutionConfig()
    ) {
        this.nodeId = crypto.randomUUID();
        this.events = new EventManager();
        this.broadcastConnection = new RemoteExecutionBroadcastConnection(this.config, this.nodeId, this.events);
    }

    /**
     * List of all the remote nodes that have been found.
     */
    get remoteNodes(): RemoteExecutionNode[] {
        return this.broadcastConnection?.remoteNodes || [];
    }

    /**
     * Start broadcasting server searching for available nodes.
     * @param pingInterval The interval in milliseconds between each ping.
     */
    public async start() {
        await this.broadcastConnection.open();
    }

    /** Stop all servers & close all connections. */
    public stop() {
        this.closeCommandConnection();
        this.broadcastConnection.close();
    }

    /** Check if a command connection is open. */
    public hasCommandConnection() {
        return this.commandConnection !== undefined && this.commandConnection.isOpen();
    }

    /**
     * Open a command connection to the given node.
     * @param node The node to open a command connection with.
     * @param bStopSearchingForNodes If true, stop searching for nodes after the connection has been opened.
     * @param timeoutMs The timeout in milliseconds. If 0, the promise will never timeout.
     */
    public async openCommandConnection(node: RemoteExecutionNode, bStopSearchingForNodes = true, timeoutMs: number = 0) {
        if (this.hasCommandConnection()) {
            throw new Error('A command connection is already open! Please close the current command connection first.');
        }

        const actualPromise = new Promise<void>(async (resolve, reject) => {
            this.commandConnection = new RemoteExecutionCommandConnection(this.config, this.nodeId, node, this.events);
            this.commandConnection.open(this.broadcastConnection).then(() => {
                this.connectedNode = node;
                resolve();
            }).catch(reject);
        });

        if (timeoutMs > 0) {
            return Promise.race([actualPromise, timeoutPromise(timeoutMs, "Timed out: Could connect to the node within the given time.")]).finally(() => {
                if (bStopSearchingForNodes)
                    this.broadcastConnection.stopSearchingForNodes();
            }) as Promise<void>;
        }

        return actualPromise.finally(() => {
            if (bStopSearchingForNodes)
                this.broadcastConnection.stopSearchingForNodes();
        });
    }

    public isSearchingForNodes() {
        return this.broadcastConnection && this.broadcastConnection.isSearchingForNodes();
    }

    public startSearchingForNodes(pingInterval: number = NODE_PING_MILLISECONDS) {
        if (!this.broadcastConnection)
            throw new Error('No broadcast connection open! Please call and await "start" first.');

        this.broadcastConnection.startSearchingForNodes(pingInterval);
    }

    public stopSearchingForNodes() {
        if (this.broadcastConnection)
            this.broadcastConnection.stopSearchingForNodes();
    }

    /** Close the current command connection. */
    public closeCommandConnection() {
        if (this.commandConnection) {
            this.commandConnection.close(this.broadcastConnection);
            this.commandConnection = undefined;
        }

        this.connectedNode = null;
    }

    /**
     * Get the first remote node that's found.
     * @param pingInterval The interval in milliseconds between each ping (That is used to search for nodes)
     * @param timeoutMs The timeout in milliseconds. If 0, the promise will never timeout.
     */
    public getFirstRemoteNode(pingInterval = NODE_PING_MILLISECONDS, timeoutMs: number = 0): Promise<RemoteExecutionNode> {
        if (!this.broadcastConnection)
            throw new Error('No broadcast connection open! Please call and await "start" first.');

        const actualPromise = new Promise<RemoteExecutionNode>((resolve, reject) => {
            this.broadcastConnection.startSearchingForNodes(pingInterval);
            if (!this.isSearchingForNodes()) {
                this.startSearchingForNodes(NODE_PING_MILLISECONDS);
            }

            this.events.once('nodeFound', (node) => {
                resolve(node);
            });
        }).finally(() => {
            this.broadcastConnection.stopSearchingForNodes();
        });

        if (timeoutMs > 0) {
            return Promise.race([actualPromise, timeoutPromise(timeoutMs, "Timed out: Could not find a node within the given time.")]) as Promise<RemoteExecutionNode>;
        }

        return actualPromise;
    }

    /**
     * Run a command on the current command connection.
     * @param command The Python code to run, use `;` to separate multiple commands.
     * @param unattended True to run the command unattended, suppressing some UI. Defaults to `true`.
     * @param execMode The execution mode to use. Defaults to `EExecMode.EXECUTE_FILE`.
     * @param raiseOnFailure If true, throw an error if the command fails.
     * @returns The command response. Object containing the output such as print statements, and the result of the command.
     */
    public async runCommand(command: string, unattended = true, execMode: ExecModeT = EExecMode.EXECUTE_FILE, raiseOnFailure = false): Promise<IRemoteExecutionMessageCommandOutputData> {
        if (!this.commandConnection) {
            throw new Error('No command connection open! Please call and await "openCommandConnection" first.');
        }

        const message = await this.commandConnection.runCommand(command, unattended, execMode);
        if (raiseOnFailure && !message.data?.success) {
            throw new Error(`Failed to run command: ${message.data?.result}`);
        }

        return message.data!;
    }
}



// --------------------------------------------------------------------------------------------
//                               BROADCAST CONNECTION
// --------------------------------------------------------------------------------------------
class RemoteExecutionBroadcastConnection {
    private nodes: { [key: string]: RemoteExecutionNode } = {};
    private broadcastSocket?: dgram.Socket;
    private broadcastListenThread?: NodeJS.Timeout;

    constructor(
        readonly config: RemoteExecutionConfig,
        readonly nodeId: string,
        private events: EventManager<RemoteExecutionEvents>
    ) { }

    get remoteNodes() {
        return Object.values(this.nodes);
    }

    /**
     * Start the broadcasting server searching for available nodes.
     * @param pingInterval The interval in milliseconds between each ping.
     */
    public async open() {
        this.timeoutRemoteNodes();
        if (!this.broadcastSocket)
            await this.initBroadcastSocket();
    }

    /** Close the broadcasting server. */
    public close() {
        if (this.broadcastSocket) {
            this.broadcastSocket.close();
            this.broadcastSocket = undefined;
        }

        this.stopSearchingForNodes();
    }

    public isSearchingForNodes() {
        return this.broadcastListenThread !== undefined && this.broadcastListenThread.unref();
    }

    /**
     * Start sending ping messages to all nodes at the given interval.
     * @param pingInterval The interval in milliseconds between each ping.
     */
    public startSearchingForNodes(pingInterval: number) {
        this.nodes = {};

        this.broadcastPing();

        if (this.broadcastListenThread) {
            clearInterval(this.broadcastListenThread);
        }

        if (pingInterval > 0)
            this.broadcastListenThread = setInterval(this.broadcastPing.bind(this), pingInterval);
    }


    /** Stop searching for nodes. The broadcasting server is still live. */
    public stopSearchingForNodes() {
        clearInterval(this.broadcastListenThread);
        this.nodes = {};
    }

    /**
     * Broadcast a ping message to all nodes.
     * Any nodes listening will respond with a pong message.
     * This is used for discovering available nodes.
     */
    public broadcastPing() {
        const now = Date.now();
        this.broadcastMessage(new RemoteExecutionMessage(ECommandType.PING, this.nodeId));
        this.timeoutRemoteNodes(now);
    }

    /**
     * Broadcast a open connection message, specifying the nodeId to open a connection with.
     * @param remoteNode The node to open a connection with.
     */
    public broadcastOpenConnection(remoteNode: RemoteExecutionNode) {
        const data: IRemoteExecutionMessageOpenConnectionData = {
            command_ip: this.config.commandEndpoint[0],  // eslint-disable no-unused-vars
            command_port: this.config.commandEndpoint[1]
        };
        const message = new RemoteExecutionMessage<IRemoteExecutionMessageOpenConnectionData>(ECommandType.OPEN_CONNECTION, this.nodeId, remoteNode.nodeId, data);
        this.broadcastMessage(message);
    }

    /**
     * Broadcast a close connection message, specifying the nodeId to close the connection with.
     * @param remoteNode The node to close the connection with.
     */
    public broadcastCloseConnection(remoteNode: RemoteExecutionNode) {
        const message = new RemoteExecutionMessage(ECommandType.CLOSE_CONNECTION, this.nodeId, remoteNode.nodeId);
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


    /**
     * Broadcast a message to all nodes.
     * @param message The message to broadcast.
     */
    private broadcastMessage(message: RemoteExecutionMessage): void {
        const data = message.toJson();
        this.broadcastSocket?.send(
            data,
            this.config.multicastGroupEndpoint[1],
            this.config.multicastGroupEndpoint[0]
        );
    }

    /**
     * Handle data recieved through the broadcast socket.
     * @param data The data recieved.
     * @param remote The remote info of the sender.
     */
    private handleData(data: Buffer, remote: dgram.RemoteInfo) {
        const message = RemoteExecutionMessage.fromBuffer(data);

        if (message.passesReceiveFilter(this.nodeId))
            this.handleMessage(message);
    }

    /**
     * Handle messages recieved through the broadcast socket.
     * @param message The message recieved.
     */
    private handleMessage(message: RemoteExecutionMessage) {
        if (message.type === ECommandType.PONG) {
            this.handlePongMessage(message);
        }
    }

    /**
     * Handle a pong messages recieved.
     * @param message The pong message recieved.
     */
    private handlePongMessage(message: RemoteExecutionMessage) {
        this.updateRemoteNode(message.source, message.data);
    }

    /**
     * Update a remote node with new data.
     * @param nodeId The id of the node to update.
     * @param data The new data
     * @param now The current time
     */
    private updateRemoteNode(nodeId: string, data: IRemoteExecutionNodeData, now = Date.now()) {
        const node = this.nodes[nodeId];
        if (node) {
            node.update(data, now);
        }
        else if (this.isSearchingForNodes()) {
            const node = new RemoteExecutionNode(nodeId, data, now);
            this.nodes[nodeId] = node;
            this.events.emit('nodeFound', node);
        }
    }

    /** Check if any nodes should be considered timed out. */
    private timeoutRemoteNodes(now = Date.now()) {
        for (const [nodeId, node] of Object.entries(this.remoteNodes)) {
            if (node.shouldTimeout(now)) {
                delete this.nodes[nodeId];
                this.events.emit('nodeTimedOut', node);
            }
        }
    }
}


export class RemoteExecutionNode {
    constructor(
        public readonly nodeId: string,
        public data: IRemoteExecutionNodeData,
        private lastPong: number = Date.now()
    ) { }

    /**
     * Update the node data. This method should not be used outside of this API.
     * @param data 
     * @param lastPong 
     */
    public update(data: IRemoteExecutionNodeData, lastPong: number = Date.now()) {
        this.data = data;
        this.lastPong = lastPong;
    }

    /** Check if this node should be considered timed out.*/
    public shouldTimeout(now: number): boolean {
        return this.lastPong + NODE_TIMEOUT_MILLISECONDS < now;
    }
}


// --------------------------------------------------------------------------------------------
//                                    COMMAND CONNECTION
// --------------------------------------------------------------------------------------------

class RemoteExecutionCommandConnection {
    private commandChannelSocket?: net.Socket;
    private commandQueue: [RemoteExecutionMessage<IRemoteExecutionMessageCommandInputData>, (value: RemoteExecutionMessage<IRemoteExecutionMessageCommandOutputData> | PromiseLike<RemoteExecutionMessage<IRemoteExecutionMessageCommandOutputData>>) => void, (reason?: any) => void][] = [];
    private isRunningCommand = false;

    constructor(
        readonly config: RemoteExecutionConfig,
        readonly sourceNodeId: string,
        readonly remoteNode: RemoteExecutionNode,
        private events: EventManager<RemoteExecutionEvents>
    ) {
    }

    /**
     * Open a command connection to the given node.
     * @param broadcastConnection The RemoteExecutionBroadcastConnection instance to use.
     * @returns A promise that resolves when the connection is open.
     */
    public async open(broadcastConnection: RemoteExecutionBroadcastConnection): Promise<void> {
        if (this.isOpen()) {
            throw new Error('A command connection is already open! Please close the current command connection first.');
        }

        const server = net.createServer();

        return new Promise<void>((resolve, reject) => {
            server.once('connection', (socket) => {
                this.commandChannelSocket = socket;

                this.commandChannelSocket.on("close", this.onClose.bind(this));

                resolve();
            });

            server.once('error', (err) => {
                reject(err);
            });

            server.listen(this.config.commandEndpoint[1], this.config.commandEndpoint[0], 1, () => {
                broadcastConnection.broadcastOpenConnection(this.remoteNode);
            });
        }).then(() => {
            server.close();
        });
    }

    /** Check if the command connection is open. */
    public isOpen() {
        return this.commandChannelSocket !== undefined;
    }

    /**
     * Close the command connection.
     * @param broadcastConnection The RemoteExecutionBroadcastConnection instance to use.
     */
    public close(broadcastConnection: RemoteExecutionBroadcastConnection) {
        broadcastConnection.broadcastCloseConnection(this.remoteNode);
        this.commandChannelSocket?.destroy();
        this.commandChannelSocket = undefined;

        if (this.commandQueue.length > 0) {
            this.commandQueue.forEach(([, , reject]) => reject(new Error('Connection closed!')));
            this.commandQueue = [];
        }
    }

    /**
     * Run a python command
     * @param command The Python command/code to run
     * @param unattended True to run the command unattended, suppressing some UI. Defaults to `true`.
     * @param execMode The execution mode to use. Defaults to `EExecMode.EXECUTE_FILE`.
     * @param raiseOnFailure If true, throw an error if the command fails.
     * @returns The message response.
     */
    public runCommand(command: string, unattended: boolean, execMode: ExecModeT): Promise<RemoteExecutionMessage<IRemoteExecutionMessageCommandOutputData>> {
        return new Promise((resolve, reject) => {
            if (!this.commandChannelSocket) {
                reject(new Error('No command channel open!'));
                return;
            }

            const message = new RemoteExecutionMessage<IRemoteExecutionMessageCommandInputData>(ECommandType.COMMAND, this.sourceNodeId, this.remoteNode.nodeId, {
                'command': command,
                'unattended': unattended,
                'exec_mode': execMode,
            });

            this.commandQueue.push([message, resolve, reject]);
            if (this.commandQueue.length === 1 && !this.isRunningCommand) {
                this._runNextCommandInQue();
            }
        });
    }

    private _runNextCommandInQue() {
        if (this.commandQueue.length === 0 || !this.commandChannelSocket) {
            this.isRunningCommand = false;
            return;
        }
        this.isRunningCommand = true;

        const [message, resolve, reject] = this.commandQueue.shift()!;

        let dataRecived: string = '';
        const dataRecieved = (data: Buffer) => {
            dataRecived += data.toString('utf-8');
            let parsedData: IRemoteExecutionMessage;
            try {
                parsedData = JSON.parse(dataRecived);
            }
            catch (e) {
                // If the message sent is too large, Unreal will send the message in chunks.
                // And if the message is sent in chunks, it will to be parsable until the last chunk is recieved.
                return;
            }

            const message = RemoteExecutionMessage.fromData<IRemoteExecutionMessageCommandOutputData>(parsedData);
            if (message.type === ECommandType.COMMAND_RESULT && message.passesReceiveFilter(this.sourceNodeId)) {
                this.commandChannelSocket?.removeListener('data', dataRecieved);
                resolve(message);

                this._runNextCommandInQue();
            }
        };

        this.commandChannelSocket.on('data', dataRecieved);

        this.commandChannelSocket.write(message.toJson());
    }

    private onClose(hadError: boolean) {
        this.events.emit("commandConnectionClosed");
        this.commandChannelSocket?.destroy();
        this.commandChannelSocket = undefined;
    }

}


// --------------------------------------------------------------------------------------------
//                                         MESSAGE
// --------------------------------------------------------------------------------------------

class RemoteExecutionMessage<T = any> {
    constructor(
        readonly type: CommandTypeT,
        readonly source: string,
        readonly dest?: string,
        readonly data?: T
    ) { }

    /**
     * Check if a message was meant for a spesific node.
     * @param nodeId The node id of the remote execution object.
     */
    public passesReceiveFilter(nodeId: string): boolean {
        return this.source !== nodeId && (!this.dest || this.dest === nodeId);
    }

    /** Convert the message to a JSON string thats ready to be sent over the network. */
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

    /**
     * Convert data to a RemoteExecutionMessage.
     * @param data The object/data to convert to a RemoteExecutionMessage.
     */
    public static fromData<T>(data: IRemoteExecutionMessage): RemoteExecutionMessage<T> {
        if (data.version !== PROTOCOL_VERSION) {
            throw Error(`"version" is incorrect (got ${data.version}, expected ${PROTOCOL_VERSION})!`);
        }
        if (data.magic !== PROTOCOL_MAGIC) {
            throw Error(`"magic" is incorrect (got "${data.magic}", expected "${PROTOCOL_MAGIC}")!`);
        }

        return new RemoteExecutionMessage(
            data.type,
            data.source,
            data.dest,
            data.data
        );
    }

    /**
     * 
     * @param buffer The buffer to convert to a RemoteExecutionMessage.
     */
    public static fromBuffer<T>(buffer: Buffer): RemoteExecutionMessage<T> {
        const jsonStr = buffer.toString("utf-8");
        const data = JSON.parse(jsonStr);
        return this.fromData(data);
    }
}