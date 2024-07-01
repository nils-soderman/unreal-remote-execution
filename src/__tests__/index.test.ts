/**
 * This tests require a running instance of Unreal Engine with the RemoteExecution plugin enabled.
 */

import { RemoteExecution, ECommandOutputType, RemoteExecutionConfig } from '../index';

// These settings must match the settings in the Unreal Engine plugin, or the tests will fail.
const LOCALHOST_IP = '127.0.0.1';
const MULTICAST_ENDPOINT_IP = '239.0.0.1';
const MULTICAST_ENDPOINT_PORT = 6766;
const COMMAND_ENDPOINT_PORT = 6776;


describe('RemoteExecution', () => {
  let remoteExecution: RemoteExecution;

  beforeAll(async () => {
    const config = new RemoteExecutionConfig(
      0,
      [MULTICAST_ENDPOINT_IP, MULTICAST_ENDPOINT_PORT],
      LOCALHOST_IP,
      [LOCALHOST_IP, COMMAND_ENDPOINT_PORT]
    );

    remoteExecution = new RemoteExecution(config);

    await remoteExecution.start();
  });

  afterAll(() => {
    remoteExecution.stop();
  });

  test('Hello World', async () => {
    const node = await remoteExecution.getFirstRemoteNode(1000, 2000);

    await remoteExecution.openCommandConnection(node);

    const response = await remoteExecution.runCommand('print("Hello World")');

    expect(response.success).toBe(true);
    expect(response.result).toBe("None");

    expect(response.output.length).toBe(1);
  
    for (const output of response.output) {
      expect(output.type).toBe(ECommandOutputType.INFO);
      expect(output.output).toBe('Hello World\r\n');
    }
  });

});