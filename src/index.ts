/**
 * Remote connection between TypeScript & Unreal Engine.
 */

import * as crypto from 'crypto'; // crypto.randomUUID() for unique IDs
import * as dgram from 'dgram';
import * as net from 'net';

const PROTOCOL_VERSION = 1;      // Protocol version number
const PROTOCOL_MAGIC = 'ue_py';  // Protocol magic identifier


/** Struct containing all the different output types */
export const ECommandOutputType = {
    info: "Info",
    warning: "Warning",
    error: "Error"
}


/** Struct containing the different execution modes */
export const EExecMode = {
    execFile: "ExecuteFile",               // Execute the Python command as a file. This allows you to execute either a literal Python script containing multiple statements, or a file with optional arguments
    execStatement: "ExecuteStatement",     // Execute the Python command as a single statement. This will execute a single statement and print the result. This mode cannot run files
    evalStatement: "EvaluateStatement"
}


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
}

export interface ISocket {
    port: number;
    ip: string;
}

export interface IRemoteExecutionConfig {
    multicastTTL: number;
    multicastGroupEndpoint: [string, number];
    multicastBindAddress: string;
    commandEndpoint: [string, number];
}