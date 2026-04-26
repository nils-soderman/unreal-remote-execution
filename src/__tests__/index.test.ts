/**
 * This tests require a running instance of Unreal Engine with the RemoteExecution plugin enabled.
 */

import { RemoteExecution, ECommandOutputType } from '../index';


describe('RemoteExecution', () => {
  let remoteExecution: RemoteExecution;

  beforeAll(async () => {
    remoteExecution = new RemoteExecution();

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

    const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';
  
    for (const output of response.output) {
      expect(output.type).toBe(ECommandOutputType.INFO);
      expect(output.output).toBe(`Hello World${lineEnding}`);
    }
  });

});